// Loads data-defined checks, plans the run (cost guard) and executes it.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSERTIONS, runAssertions } from './assert.mjs';
import { EVALUATORS } from './evaluators.mjs';
import { buildUrl, sendRequest } from './http.mjs';
import { BAD_MODEL, INVALID_KEY, fillTemplate, tokenCap, estimateTokens, TOKEN_FIELDS } from './util.mjs';

export const PROFILES = ['chat', 'anthropic', 'agent', 'responses'];
export const SEVERITIES = ['fail', 'warn', 'info'];
export const DEFAULT_CAP = 16;
export const TOOL_CAP = 64;
export const BUILTIN_CHECKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'checks');

const FILE_ORDER = ['chat.json', 'agent.json', 'anthropic.json', 'responses.json'];

export function familyOf(profile) {
  return profile === 'anthropic' ? 'anthropic' : 'openai';
}

/** Validate one check definition. Returns a list of problems (empty = valid). */
export function validateCheck(c) {
  const errs = [];
  const id = c && c.id ? c.id : '(no id)';
  if (!c || typeof c !== 'object') return ['check is not an object'];
  if (typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(c.id)) errs.push(`${id}: id must be lowercase letters, digits, ".", "_" or "-"`);
  const profiles = Array.isArray(c.profile) ? c.profile : [c.profile];
  if (!profiles.length || profiles.some((p) => !PROFILES.includes(p))) errs.push(`${id}: profile must be one or more of ${PROFILES.join(', ')}`);
  if (typeof c.title !== 'string' || !c.title) errs.push(`${id}: title is required`);
  if (!SEVERITIES.includes(c.severity)) errs.push(`${id}: severity must be one of ${SEVERITIES.join(', ')}`);
  if (typeof c.fix_hint !== 'string' || !c.fix_hint) errs.push(`${id}: fix_hint is required`);
  if (!c.request && !c.uses) errs.push(`${id}: needs "request" or "uses"`);
  if (c.request && c.uses) errs.push(`${id}: use either "request" or "uses", not both`);
  if (c.request) {
    const r = c.request;
    if (!['GET', 'POST'].includes(r.method)) errs.push(`${id}: request.method must be GET or POST`);
    if (typeof r.path !== 'string' || !r.path.startsWith('/')) errs.push(`${id}: request.path must start with "/"`);
    if (r.auth && !['valid', 'invalid', 'none'].includes(r.auth)) errs.push(`${id}: request.auth must be valid, invalid or none`);
    const cap = c.budget === 'tool' ? TOOL_CAP : DEFAULT_CAP;
    if (r.method === 'POST') {
      if (!r.body || typeof r.body !== 'object') errs.push(`${id}: POST needs a body`);
      else {
        const has = TOKEN_FIELDS.some((f) => typeof r.body[f] === 'number');
        if (!has) errs.push(`${id}: POST body must set max_tokens, max_completion_tokens or max_output_tokens (cost guard)`);
        if (tokenCap(r.body) > cap) errs.push(`${id}: output token cap ${tokenCap(r.body)} exceeds ${cap} (cost guard)`);
      }
    }
  }
  for (const a of c.assertions || []) {
    if (!a || !ASSERTIONS[a.type]) errs.push(`${id}: unknown assertion type "${a && a.type}"`);
  }
  if (c.evaluator) {
    if (!EVALUATORS[c.evaluator.name]) errs.push(`${id}: unknown evaluator "${c.evaluator.name}"`);
    if (c.evaluator.followup_max_tokens && c.evaluator.followup_max_tokens > TOOL_CAP) errs.push(`${id}: followup_max_tokens exceeds ${TOOL_CAP}`);
  }
  if (!c.assertions && !c.evaluator) errs.push(`${id}: needs "assertions" or "evaluator"`);
  return errs;
}

/** Load every *.json file from the built-in folder plus any extra folders. Throws on invalid checks. */
export function loadChecks(extraDirs = []) {
  const dirs = [BUILTIN_CHECKS_DIR, ...extraDirs];
  const all = [];
  const errors = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) { errors.push(`checks folder not found: ${dir}`); continue; }
    const rank = (n) => (dir === BUILTIN_CHECKS_DIR ? FILE_ORDER.indexOf(n) : -1);
    const files = readdirSync(dir).filter((n) => n.endsWith('.json')).sort((a, b) => (rank(a) === rank(b) ? a.localeCompare(b) : (rank(a) < 0 ? 99 : rank(a)) - (rank(b) < 0 ? 99 : rank(b))));
    for (const f of files) {
      let data;
      try {
        data = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      } catch (e) {
        errors.push(`${f}: ${e.message}`);
        continue;
      }
      const list = Array.isArray(data) ? data : data.checks;
      if (!Array.isArray(list)) { errors.push(`${f}: expected {"checks": [...]}`); continue; }
      for (const c of list) {
        const errs = validateCheck(c);
        if (errs.length) errors.push(...errs.map((e) => `${f}: ${e}`));
        else all.push({ ...c, profile: Array.isArray(c.profile) ? c.profile : [c.profile], source: f });
      }
    }
  }
  const seen = new Set();
  for (const c of all) {
    if (seen.has(c.id)) errors.push(`duplicate check id "${c.id}"`);
    seen.add(c.id);
  }
  for (const c of all) {
    if (c.uses && !all.some((o) => o.id === c.uses)) errors.push(`${c.id}: uses unknown check "${c.uses}"`);
  }
  if (errors.length) {
    const e = new Error('invalid checks:\n  ' + errors.join('\n  '));
    e.code = 'EBADCHECKS';
    throw e;
  }
  return all;
}

function matchesAny(id, patterns) {
  return patterns.some((p) => id === p || id.startsWith(p));
}

/** Pick the checks for a profile, honour --only / --skip, and keep dependencies in order. */
export function selectChecks(all, profile, { only = [], skip = [] } = {}) {
  let list = all.filter((c) => c.profile.includes(profile));
  if (only.length) list = list.filter((c) => matchesAny(c.id, only));
  if (skip.length) list = list.filter((c) => !matchesAny(c.id, skip));
  // Pull in checks that selected checks reuse.
  const ids = new Set(list.map((c) => c.id));
  for (const c of [...list]) {
    if (c.uses && !ids.has(c.uses)) {
      const dep = all.find((o) => o.id === c.uses);
      if (dep) { list.push(dep); ids.add(dep.id); }
    }
  }
  const order = new Map(all.map((c, i) => [c.id, i]));
  list.sort((a, b) => order.get(a.id) - order.get(b.id));
  // Dependencies first.
  const out = [];
  const placed = new Set();
  const place = (c) => {
    if (placed.has(c.id)) return;
    if (c.uses) { const d = list.find((o) => o.id === c.uses); if (d) place(d); }
    placed.add(c.id);
    out.push(c);
  };
  list.forEach(place);
  return out;
}

/** Count requests and estimate tokens before anything is sent. */
export function planRun(checks, { model }) {
  let requests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const rows = [];
  for (const c of checks) {
    const req = c.request || (checks.find((o) => o.id === c.uses) || {}).request;
    const extra = c.evaluator ? EVALUATORS[c.evaluator.name].extraRequests : 0;
    const own = c.request ? 1 : 0;
    const n = own + extra;
    rows.push({ id: c.id, requests: n });
    if (!n || !req) continue;
    requests += n;
    const body = req.body ? fillTemplate(req.body, { model, bad_model: BAD_MODEL }) : undefined;
    const inTok = estimateTokens(body);
    inputTokens += inTok * n + 80 * extra;
    outputTokens += own * tokenCap(body) + (extra ? extra * (c.evaluator.followup_max_tokens || TOOL_CAP) : 0);
  }
  return { requests, inputTokens, outputTokens, rows };
}

/**
 * Run checks against an endpoint.
 * opts: { baseUrl, profile, model, apiKey, timeoutMs, headers, anthropicVersion, onResult }
 */
export async function runChecks(checks, opts) {
  const family = familyOf(opts.profile);
  const vars = { model: opts.model, bad_model: BAD_MODEL };
  const results = [];
  const byId = new Map();

  const send = async (spec) => {
    const body = spec.body === undefined ? undefined : fillTemplate(spec.body, vars);
    // Hard cost guard at the transport, so no evaluator or community check can exceed it.
    if (body && tokenCap(body) > TOOL_CAP) throw new Error(`refusing to send a request with an output cap above ${TOOL_CAP}`);
    const headers = { ...(opts.headers || {}) };
    const auth = spec.auth || 'valid';
    const key = auth === 'invalid' ? INVALID_KEY : auth === 'none' ? null : opts.apiKey;
    if (family === 'anthropic') {
      headers['anthropic-version'] = opts.anthropicVersion || '2023-06-01';
      if (key) headers['x-api-key'] = key;
    } else if (key) {
      headers.authorization = `Bearer ${key}`;
    }
    return sendRequest({ url: buildUrl(opts.baseUrl, family, spec.path), method: spec.method, headers, body, timeoutMs: opts.timeoutMs });
  };

  for (const c of checks) {
    const started = Date.now();
    const result = { id: c.id, title: c.title, severity: c.severity, tags: c.tags || [], fix_hint: c.fix_hint, status: 'pass', problems: [], notes: [], exchanges: [] };
    let exchange;
    if (c.uses) {
      const dep = byId.get(c.uses);
      if (!dep || !dep.exchange || dep.exchange.error) {
        result.status = 'skip';
        result.notes.push(`skipped: depends on ${c.uses}, which got no response`);
      } else {
        exchange = dep.exchange;
        result.reused = c.uses;
        result.exchanges.push({ label: `response reused from ${c.uses}`, exchange });
      }
    } else {
      exchange = await send(c.request);
      result.exchanges.push({ label: 'request', exchange });
    }
    if (result.status !== 'skip') {
      if (exchange.error) {
        result.problems.push(exchange.error);
      } else {
        result.problems.push(...runAssertions(exchange, fillTemplate(c.assertions || [], vars)));
        if (c.evaluator && !(result.problems.length && c.evaluator.after_assertions !== false && (c.assertions || []).length)) {
          const ev = EVALUATORS[c.evaluator.name];
          try {
            const depCheck = c.uses ? byId.get(c.uses).check : null;
            const check = c.request ? c : { ...c, request: depCheck && depCheck.request };
            const out = await ev.fn({ exchange, send, check, params: c.evaluator, model: opts.model });
            result.problems.push(...(out.problems || []));
            result.notes.push(...(out.notes || []));
            if (out.extra) result.exchanges.push(out.extra);
            if (out.status) result.forced = out.status;
          } catch (e) {
            result.problems.push(`evaluator error: ${e.message}`);
          }
        }
      }
      if (result.forced === 'info' || c.severity === 'info') {
        result.status = 'info';
        result.notes.push(...result.problems);
        result.problems = [];
      } else if (result.forced === 'warn' && result.problems.length) {
        result.status = 'warn';
      } else if (result.problems.length) {
        result.status = c.severity === 'fail' ? 'fail' : 'warn';
      }
    }
    result.duration_ms = Date.now() - started;
    byId.set(c.id, { exchange, result, check: c });
    results.push(result);
    if (opts.onResult) opts.onResult(result);
  }
  return results;
}

/** Summary + feature list used by the table, JSON, HTML and badge. */
export function summarize(results, profile) {
  const count = (s) => results.filter((r) => r.status === s).length;
  const summary = { pass: count('pass'), warn: count('warn'), fail: count('fail'), info: count('info'), skip: count('skip') };
  const scored = results.filter((r) => r.status !== 'info' && r.status !== 'skip');
  summary.scored = scored.length;
  summary.score = `${summary.pass}/${scored.length}`;
  const order = ['chat', 'anthropic', 'responses', 'stream', 'usage', 'tools', 'json'];
  const features = [];
  for (const f of order) {
    const tagged = scored.filter((r) => r.tags.includes(f));
    if (tagged.length && tagged.every((r) => r.status === 'pass')) features.push(f);
  }
  summary.features = features;
  summary.profile = profile;
  return summary;
}
