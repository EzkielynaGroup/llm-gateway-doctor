// The built-in assertion vocabulary used by checks/*.json.
// Every assertion returns null when it holds, or a short problem string.
import { getPath, typeOf, tryJson } from './util.mjs';

function target(ex, a) {
  const json = ex.response ? ex.response.json : undefined;
  return getPath(json, a.path);
}

function show(v) {
  if (v === undefined) return 'missing';
  const s = JSON.stringify(v);
  return s && s.length > 80 ? s.slice(0, 80) + '...' : s;
}

export const ASSERTIONS = {
  /** HTTP status is one of `in`, or within [min, max]. */
  status(ex, a) {
    const s = ex.response.status;
    if (Array.isArray(a.in) && !a.in.includes(s)) return `HTTP status ${s}, expected ${a.in.join(' or ')}`;
    if (typeof a.min === 'number' && s < a.min) return `HTTP status ${s}, expected >= ${a.min}`;
    if (typeof a.max === 'number' && s > a.max) return `HTTP status ${s}, expected <= ${a.max}`;
    return null;
  },
  /** Response header `name` contains `contains` (case-insensitive). */
  header(ex, a) {
    const v = ex.response.headers[String(a.name).toLowerCase()];
    if (v === undefined) return `header ${a.name} missing`;
    if (a.contains && !v.toLowerCase().includes(String(a.contains).toLowerCase())) return `header ${a.name} is "${v}", expected it to contain "${a.contains}"`;
    return null;
  },
  /** Body parses as JSON (and is not an HTML page). */
  json(ex) {
    if (ex.response.json !== undefined) return null;
    const t = ex.response.text.trim();
    if (/^<(!doctype|html|head|body)/i.test(t)) return 'body is an HTML page, not JSON';
    if (t === '') return 'body is empty, expected JSON';
    return `body is not JSON: ${tryJson(t).error}`;
  },
  exists(ex, a) {
    return target(ex, a) === undefined ? `${a.path} is missing` : null;
  },
  absent(ex, a) {
    return target(ex, a) !== undefined ? `${a.path} should be absent, got ${show(target(ex, a))}` : null;
  },
  /** `is` is a type name or a list of type names: string number boolean object array null. */
  type(ex, a) {
    const v = target(ex, a);
    const want = Array.isArray(a.is) ? a.is : [a.is];
    const got = v === undefined ? 'missing' : typeOf(v);
    return want.includes(got) ? null : `${a.path} is ${got}, expected ${want.join(' or ')}`;
  },
  equals(ex, a) {
    const v = target(ex, a);
    return JSON.stringify(v) === JSON.stringify(a.value) ? null : `${a.path} is ${show(v)}, expected ${show(a.value)}`;
  },
  one_of(ex, a) {
    const v = target(ex, a);
    return (a.values || []).some((x) => JSON.stringify(x) === JSON.stringify(v)) ? null : `${a.path} is ${show(v)}, expected one of ${show(a.values)}`;
  },
  /** Non-empty string or array. */
  nonempty(ex, a) {
    const v = target(ex, a);
    if ((typeof v === 'string' || Array.isArray(v)) && v.length > 0) return null;
    return `${a.path} is empty or missing (${show(v)})`;
  },
  /** Value is a string that itself parses as JSON (OpenAI tool-call arguments). */
  json_string(ex, a) {
    const v = target(ex, a);
    if (typeof v !== 'string') return `${a.path} is ${v === undefined ? 'missing' : typeOf(v)}, expected a JSON-encoded string`;
    const p = tryJson(v);
    return p.ok ? null : `${a.path} is a string but not valid JSON: ${show(v)}`;
  },
  matches(ex, a) {
    const v = target(ex, a);
    if (typeof v !== 'string') return `${a.path} is ${v === undefined ? 'missing' : typeOf(v)}, expected a string`;
    return new RegExp(a.pattern, a.flags || '').test(v) ? null : `${a.path} does not match /${a.pattern}/`;
  },
  /** Some element of the array at `path` has `where.path` equal to `where.equals`. */
  some(ex, a) {
    const arr = target(ex, a);
    if (!Array.isArray(arr)) return `${a.path} is not an array`;
    const w = a.where || {};
    const hit = arr.some((el) => JSON.stringify(getPath(el, w.path)) === JSON.stringify(w.equals));
    return hit ? null : `no item in ${a.path} has ${w.path} = ${show(w.equals)}`;
  },
  /** Every element of the array at `path` has `where.path` of type `where.is`. */
  every(ex, a) {
    const arr = target(ex, a);
    if (!Array.isArray(arr)) return `${a.path} is not an array`;
    const w = a.where || {};
    const want = Array.isArray(w.is) ? w.is : [w.is];
    const bad = arr.findIndex((el) => !want.includes(typeOf(getPath(el, w.path))));
    return bad < 0 ? null : `${a.path}[${bad}].${w.path} is ${typeOf(getPath(arr[bad], w.path))}, expected ${want.join(' or ')}`;
  },
  /** Passes when at least one nested assertion passes. */
  any_of(ex, a) {
    const problems = [];
    for (const sub of a.assertions || []) {
      const p = runAssertion(ex, sub);
      if (!p) return null;
      problems.push(p);
    }
    return `none matched: ${problems.join('; ')}`;
  },
};

export function runAssertion(ex, a) {
  const fn = ASSERTIONS[a.type];
  if (!fn) return `unknown assertion type "${a.type}"`;
  const p = fn(ex, a);
  if (p && a.message) return `${a.message} (${p})`;
  return p;
}

export function runAssertions(ex, list = []) {
  const problems = [];
  for (const a of list) {
    const p = runAssertion(ex, a);
    if (p) {
      problems.push(p);
      // A failed status/json check makes later path checks noise.
      if ((a.type === 'status' || a.type === 'json') && a.stop !== false) break;
    }
  }
  return problems;
}
