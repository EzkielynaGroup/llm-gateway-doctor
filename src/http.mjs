// HTTP transport and SSE parsing. Uses the global fetch of Node 18+.
import { VERSION, tryJson } from './util.mjs';

export const MAX_BODY_BYTES = 1024 * 1024; // never buffer more than 1 MB of a response

/** Join a base URL and an API path for the given wire family. */
export function buildUrl(baseUrl, family, path) {
  const base = String(baseUrl).replace(/\/+$/, '');
  if (family === 'anthropic') {
    // Anthropic SDKs take a base without /v1 and add /v1/messages themselves.
    if (/\/v1$/.test(base)) return base + path;
    return base + '/v1' + path;
  }
  return base + path;
}

/**
 * Send one request. Never throws: network errors and timeouts come back as `error`.
 * Returns { request, response?, error?, duration_ms }.
 */
export async function sendRequest({ url, method = 'GET', headers = {}, body, timeoutMs = 30000 }) {
  const reqHeaders = { 'user-agent': `llm-gateway-doctor/${VERSION}`, accept: '*/*', ...headers };
  if (body !== undefined) reqHeaders['content-type'] = 'application/json';
  const request = { method, url, headers: reqHeaders, body };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
  const started = Date.now();
  let firstByteMs = null;
  try {
    const res = await fetch(url, {
      method,
      headers: reqHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
      redirect: 'manual',
    });
    const chunks = [];
    let size = 0;
    let truncated = false;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (firstByteMs === null) firstByteMs = Date.now() - started;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          truncated = true;
          try { await reader.cancel(); } catch { /* ignore */ }
          break;
        }
        chunks.push(value);
      }
    }
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    const headersOut = {};
    res.headers.forEach((v, k) => { headersOut[k] = v; });
    const parsed = tryJson(text);
    return {
      request,
      response: {
        status: res.status,
        headers: headersOut,
        text,
        json: parsed.ok ? parsed.value : undefined,
        truncated,
        first_byte_ms: firstByteMs,
      },
      duration_ms: Date.now() - started,
    };
  } catch (e) {
    const reason = ctrl.signal.aborted ? `timeout after ${timeoutMs} ms` : (e && e.cause && e.cause.code) || (e && e.message) || String(e);
    return { request, error: `request failed: ${reason}`, duration_ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a Server-Sent Events body.
 * Returns { events: [{event, data, id}], badLines: [...], comments, unterminated }.
 */
export function parseSSE(text) {
  const lines = String(text ?? '').split(/\r\n|\r|\n/);
  const events = [];
  const badLines = [];
  let comments = 0;
  let cur = { event: null, data: [], id: null };
  let pending = false;
  const flush = () => {
    if (pending) events.push({ event: cur.event, data: cur.data.length ? cur.data.join('\n') : null, id: cur.id });
    cur = { event: null, data: [], id: null };
    pending = false;
  };
  for (const line of lines) {
    if (line === '') { flush(); continue; }
    if (line.startsWith(':')) { comments++; continue; }
    const idx = line.indexOf(':');
    const field = idx < 0 ? line : line.slice(0, idx);
    let value = idx < 0 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') { cur.data.push(value); pending = true; }
    else if (field === 'event') { cur.event = value; pending = true; }
    else if (field === 'id') { cur.id = value; }
    else if (field === 'retry') { /* allowed */ }
    else badLines.push(line.length > 120 ? line.slice(0, 120) + '...' : line);
  }
  const unterminated = pending;
  flush();
  return { events, badLines, comments, unterminated };
}
