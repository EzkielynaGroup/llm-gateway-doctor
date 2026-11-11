// Command-line front end: argument parsing, cost guard, confirm prompt, outputs.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { VERSION, makeRedactor, isLocalHost, safeUrl } from './util.mjs';
import { PROFILES, familyOf, loadChecks, selectChecks, planRun, runChecks, summarize } from './runner.mjs';
import { buildReport, renderTable, renderJson, renderHtml, renderBadge, badgeText } from './report.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `llm-gateway-doctor ${VERSION}
Conformance checks for OpenAI- and Anthropic-compatible LLM endpoints, using your own key.

Usage:
  npx llm-gateway-doctor --base-url <url> --model <id> [options]
  npx llm-gateway-doctor --preset <name> --model <id> [options]

Target:
  --base-url <url>        API base, e.g. https://host/v1 (OpenAI) or https://host (Anthropic)
  --model <id>            Model id to test (required)
  --profile <p>           chat | anthropic | agent | responses (default: chat, or the preset's)
  --preset <name>         Fill base URL + profile from presets.json (see --list-presets)
  --key-env <NAME>        Env var holding the key (default OPENAI_API_KEY, or ANTHROPIC_API_KEY
                          for the anthropic profile, or the preset's). The key is never printed.
  --header "K: V"         Extra request header (repeatable); values are redacted in reports
  --anthropic-version <v> anthropic-version header (default 2023-06-01)

Run control:
  --dry-run               Print the plan (requests, token estimate) and exit; sends nothing
  --yes, -y               Do not ask for confirmation (non-interactive runs never ask)
  --timeout-ms <n>        Per-request timeout (default 30000)
  --only <ids>            Comma list of check ids or prefixes to run
  --skip <ids>            Comma list of check ids or prefixes to skip
  --checks <dir>          Load extra checks/*.json from a folder (repeatable)

Output:
  --json                  Print the JSON report to stdout instead of the table
  --html <file>           Write a self-contained HTML report
  --badge <file>          Write an SVG badge ("compat 18/20 · chat+stream+tools")
  --force                 Allow --html/--badge to overwrite an existing file
  --no-color              Plain terminal output (also NO_COLOR=1)

Info:
  --list-checks           List checks for --profile (or all) and exit
  --list-presets          List presets and exit
  --help, -h | --version, -v

Exit codes: 0 no failures, 1 at least one failed check, 2 usage or setup error.`;

class UsageError extends Error {}

export function parseArgs(argv) {
  const o = { headers: [], checks: [], only: [], skip: [] };
  const valueFlags = new Set(['--base-url', '--model', '--profile', '--preset', '--key-env', '--header', '--anthropic-version', '--timeout-ms', '--only', '--skip', '--checks', '--html', '--badge']);
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let v;
    if (a.startsWith('--') && a.includes('=')) { v = a.slice(a.indexOf('=') + 1); a = a.slice(0, a.indexOf('=')); }
    if (valueFlags.has(a) && v === undefined) {
      v = argv[++i];
      if (v === undefined || (v.startsWith('--') && a !== '--header')) throw new UsageError(`${a} needs a value`);
    }
    switch (a) {
      case '--base-url': o.baseUrl = v; break;
      case '--model': o.model = v; break;
      case '--profile': o.profile = v; break;
      case '--preset': o.preset = v; break;
      case '--key-env': o.keyEnv = v; break;
      case '--header': o.headers.push(v); break;
      case '--anthropic-version': o.anthropicVersion = v; break;
      case '--timeout-ms': o.timeoutMs = Number(v); break;
      case '--only': o.only.push(...v.split(',').map((s) => s.trim()).filter(Boolean)); break;
      case '--skip': o.skip.push(...v.split(',').map((s) => s.trim()).filter(Boolean)); break;
      case '--checks': o.checks.push(v); break;
      case '--html': o.html = v; break;
      case '--badge': o.badge = v; break;
      case '--json': o.json = true; break;
      case '--force': o.force = true; break;
      case '--dry-run': o.dryRun = true; break;
      case '--yes': case '-y': o.yes = true; break;
      case '--no-color': o.noColor = true; break;
      case '--list-checks': o.listChecks = true; break;
      case '--list-presets': o.listPresets = true; break;
      case '--help': case '-h': o.help = true; break;
      case '--version': case '-v': o.version = true; break;
      default: throw new UsageError(`unknown option: ${a}`);
    }
  }
  return o;
}

export function loadPresets() {
  return JSON.parse(readFileSync(join(ROOT, 'presets.json'), 'utf8')).presets;
}

/** Resolve flags + preset + env into a run configuration. Throws UsageError. */
export function resolveConfig(o, env = process.env) {
  const cfg = { profile: o.profile, baseUrl: o.baseUrl, model: o.model, keyEnv: o.keyEnv };
  if (o.preset) {
    const p = loadPresets().find((x) => x.name === o.preset.toLowerCase());
    if (!p) throw new UsageError(`unknown preset "${o.preset}". Try --list-presets.`);
    cfg.profile = cfg.profile || p.profile;
    const fam = familyOf(cfg.profile);
    const url = fam === 'anthropic' ? p.anthropic_base_url : p.openai_base_url;
    if (!url && !cfg.baseUrl) throw new UsageError(`preset "${p.name}" has no ${fam === 'anthropic' ? 'Anthropic' : 'OpenAI'}-format base URL; pass --base-url`);
    cfg.baseUrl = cfg.baseUrl || url;
    cfg.keyEnv = cfg.keyEnv || p.key_env;
    cfg.presetLabel = p.label;
  }
  cfg.profile = cfg.profile || 'chat';
  if (!PROFILES.includes(cfg.profile)) throw new UsageError(`--profile must be one of ${PROFILES.join(', ')}`);
  if (!cfg.baseUrl) throw new UsageError('--base-url (or --preset) is required; there is no default endpoint');
  let u;
  try { u = new URL(cfg.baseUrl); } catch { throw new UsageError(`--base-url is not a valid URL: ${safeUrl(cfg.baseUrl)}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UsageError('--base-url must start with http:// or https://');
  if (!cfg.model) throw new UsageError('--model is required');
  cfg.keyEnv = cfg.keyEnv || (familyOf(cfg.profile) === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cfg.keyEnv)) throw new UsageError('--key-env must be an environment variable name, not a key');
  cfg.apiKey = env[cfg.keyEnv] || '';
  cfg.timeoutMs = o.timeoutMs === undefined ? 30000 : o.timeoutMs;
  if (!Number.isFinite(cfg.timeoutMs) || cfg.timeoutMs < 100 || cfg.timeoutMs > 600000) throw new UsageError('--timeout-ms must be between 100 and 600000');
  cfg.headers = {};
  for (const h of o.headers) {
    const i = h.indexOf(':');
    if (i < 1) throw new UsageError(`--header must look like "Name: value" (got "${h.slice(0, 20)}")`);
    cfg.headers[h.slice(0, i).trim().toLowerCase()] = h.slice(i + 1).trim();
  }
  cfg.anthropicVersion = o.anthropicVersion || '2023-06-01';
  cfg.local = isLocalHost(cfg.baseUrl);
  cfg.insecure = u.protocol === 'http:' && !cfg.local;
  return cfg;
}

function writeNew(file, content, force) {
  const path = resolve(file);
  try {
    writeFileSync(path, content, { flag: force ? 'w' : 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') throw new UsageError(`${file} already exists; pass --force to overwrite`);
    throw new UsageError(`cannot write ${file}: ${e.code || e.message}`);
  }
  return path;
}

function ask(question, io) {
  return new Promise((res) => {
    const rl = createInterface({ input: io.stdin, output: io.stderr });
    rl.question(question, (a) => { rl.close(); res(a); });
  });
}

/** Entry point. Returns the exit code. `io` lets tests inject streams and env. */
export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, env: process.env }) {
  const out = (s) => io.stdout.write(s + '\n');
  const err = (s) => io.stderr.write(s + '\n');
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    err(`error: ${e.message}\nRun with --help for usage.`);
    return 2;
  }
  if (o.help) { out(HELP); return 0; }
  if (o.version) { out(VERSION); return 0; }
  if (o.listPresets) {
    for (const p of loadPresets()) out(`${p.name.padEnd(11)} ${p.label.padEnd(22)} ${p.profile.padEnd(9)} ${p.openai_base_url || '-'}${p.anthropic_base_url ? '  (anthropic: ' + p.anthropic_base_url + ')' : ''}`);
    return 0;
  }
  let all;
  try {
    all = loadChecks(o.checks.map((d) => resolve(d)));
  } catch (e) {
    err(`error: ${e.message}`);
    return 2;
  }
  if (o.listChecks) {
    const list = o.profile ? selectChecks(all, o.profile, o) : all;
    for (const c of list) out(`${c.id.padEnd(34)} ${c.severity.padEnd(5)} ${c.profile.join(',').padEnd(22)} ${c.title}`);
    return 0;
  }
  let cfg;
  try {
    cfg = resolveConfig(o, io.env || {});
  } catch (e) {
    err(`error: ${e.message}`);
    return 2;
  }
  const checks = selectChecks(all, cfg.profile, o);
  if (!checks.length) { err('error: no checks selected'); return 2; }
  const plan = planRun(checks, { model: cfg.model });
  const color = !o.noColor && !io.env.NO_COLOR && io.stdout.isTTY;
  err(`Plan: ${checks.length} checks, ${plan.requests} requests to ${safeUrl(cfg.baseUrl)} (profile ${cfg.profile}, model ${cfg.model})`);
  err(`      about ${plan.inputTokens} input tokens and at most ${plan.outputTokens} output tokens in total; key from $${cfg.keyEnv}`);
  if (cfg.insecure) err('warning: plain http:// to a non-local host sends your key unencrypted');
  if (o.dryRun) {
    for (const r of plan.rows) err(`  ${String(r.requests).padStart(2)} x ${r.id}`);
    err('Dry run: nothing was sent.');
    return 0;
  }
  if (!cfg.apiKey) {
    if (cfg.local) err(`note: $${cfg.keyEnv} is empty; sending requests without a key (local host)`);
    else { err(`error: $${cfg.keyEnv} is empty. Export your key first, or choose another variable with --key-env.`); return 2; }
  }
  if (o.html && existsSync(resolve(o.html)) && !o.force) { err(`error: ${o.html} already exists; pass --force to overwrite`); return 2; }
  if (o.badge && existsSync(resolve(o.badge)) && !o.force) { err(`error: ${o.badge} already exists; pass --force to overwrite`); return 2; }
  if (!o.yes && io.stdin.isTTY && io.stderr.isTTY) {
    const a = await ask(`Send ${plan.requests} requests? This uses a small amount of your credit. [y/N] `, io);
    if (!/^y(es)?$/i.test(a.trim())) { err('Aborted; nothing was sent.'); return 2; }
  }
  const redact = makeRedactor([cfg.apiKey, ...Object.values(cfg.headers)]);
  let done = 0;
  const results = await runChecks(checks, {
    baseUrl: cfg.baseUrl,
    profile: cfg.profile,
    model: cfg.model,
    apiKey: cfg.apiKey,
    timeoutMs: cfg.timeoutMs,
    headers: cfg.headers,
    anthropicVersion: cfg.anthropicVersion,
    onResult: () => { done++; if (io.stderr.isTTY) io.stderr.write(`\r  ${done}/${checks.length} checks`); },
  });
  if (io.stderr.isTTY) io.stderr.write('\r' + ' '.repeat(30) + '\r');
  const summary = summarize(results, cfg.profile);
  const report = buildReport({ results, summary, target: cfg, plan, redact });
  if (o.json) out(renderJson(report));
  else out(renderTable(report, { color }));
  try {
    if (o.html) err(`HTML report: ${writeNew(o.html, renderHtml(report), o.force)}`);
    if (o.badge) err(`Badge (${badgeText(summary)}): ${writeNew(o.badge, renderBadge(summary), o.force)}`);
  } catch (e) {
    err(`error: ${e.message}`);
    return 2;
  }
  return summary.fail ? 1 : 0;
}
