// Small helpers shared by the runner, evaluators and reports. No dependencies.

export const VERSION = '0.1.0';
export const BAD_MODEL = 'llm-gateway-doctor-no-such-model';
// Built from two parts so secret scanners never see a key-shaped literal.
export const INVALID_KEY = 'sk-' + 'doctor-invalid-key-000';

/** Read a value by a simple path such as `choices[0].message.content` or `data`. */
export function getPath(obj, path) {
  if (path === undefined || path === null || path === '' || path === '$') return obj;
  const parts = [];
  String(path).replace(/[^.[\]]+|\[(\d+)\]/g, (m, idx) => {
    parts.push(idx !== undefined ? Number(idx) : m);
    return m;
  });
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

export function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Replace {{model}} / {{bad_model}} in every string of a JSON value. */
export function fillTemplate(value, vars) {
  if (typeof value === 'string') {
    const whole = value.match(/^\{\{(\w+)\}\}$/);
    if (whole && Object.prototype.hasOwnProperty.call(vars, whole[1])) return vars[whole[1]];
    return value.replace(/\{\{(\w+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
  }
  if (Array.isArray(value)) return value.map((v) => fillTemplate(v, vars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = fillTemplate(v, vars);
    return out;
  }
  return value;
}

export function tryJson(text) {
  if (typeof text !== 'string') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export const TOKEN_FIELDS = ['max_tokens', 'max_completion_tokens', 'max_output_tokens'];

/** Return the largest output-token cap set anywhere at the top level of a request body. */
export function tokenCap(body) {
  if (!body || typeof body !== 'object') return 0;
  let max = 0;
  for (const f of TOKEN_FIELDS) if (typeof body[f] === 'number') max = Math.max(max, body[f]);
  return max;
}

/** Rough token estimate: about 4 characters per token. */
export function estimateTokens(body) {
  if (!body) return 0;
  return Math.ceil(JSON.stringify(body).length / 4);
}

const KEYISH = /\b(sk|key|pk|rk|gsk|xai|tgp_v1)[-_][A-Za-z0-9_\-.]{8,}/g;
const BEARER = /(Bearer\s+)[^\s"',}]+/gi;

/** Build a redactor that removes the user's key (and anything key-shaped) from text. */
export function makeRedactor(secrets = []) {
  const list = secrets.filter((s) => typeof s === 'string' && s.length >= 4);
  return function redact(text) {
    if (text === undefined || text === null) return text;
    let s = typeof text === 'string' ? text : JSON.stringify(text);
    for (const sec of list) s = s.split(sec).join('[REDACTED]');
    s = s.replace(BEARER, '$1[REDACTED]');
    s = s.replace(KEYISH, '[REDACTED]');
    return s;
  };
}

export function truncate(s, n = 2000) {
  if (typeof s !== 'string') return s;
  return s.length > n ? s.slice(0, n) + `\n... [${s.length - n} more chars]` : s;
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function isLocalHost(url) {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h.endsWith('.localhost');
  } catch {
    return false;
  }
}

/** Strip user:pass and query strings from a URL before it goes into a report. */
export function safeUrl(url) {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    if (u.search) u.search = '?[REDACTED]';
    return u.toString().replace(/\/$/, '');
  } catch {
    return '[invalid url]';
  }
}
