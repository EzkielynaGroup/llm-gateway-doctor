// Named evaluators for checks that do not fit plain assertions (streams, multi-step tool calls).
// A check references one with "evaluator": {"name": "...", ...params}.
// Each returns { problems: string[], notes: string[], status?: 'info'|'warn' }.
import { parseSSE } from './http.mjs';
import { tryJson } from './util.mjs';

function contentType(ex) {
  return (ex.response.headers['content-type'] || '').toLowerCase();
}

function isEventStream(ex) {
  return contentType(ex).includes('text/event-stream');
}

function want(params, name) {
  return !params.expect || params.expect.includes(name);
}

function streamPreconditions(ex, problems) {
  if (ex.response.status !== 200) {
    problems.push(`HTTP status ${ex.response.status}, expected 200`);
    return false;
  }
  if (!isEventStream(ex) && ex.response.json !== undefined && !ex.response.text.trimStart().startsWith('data:')) {
    problems.push('stream=true was ignored: the body is a single JSON object, not an event stream');
    return false;
  }
  return true;
}

/** OpenAI chat-completions stream: data lines, JSON chunks, finish_reason, [DONE], usage chunk. */
function sseOpenAI({ exchange: ex, params }) {
  const problems = [];
  const notes = [];
  if (!streamPreconditions(ex, problems)) return { problems, notes };
  const sse = parseSSE(ex.response.text);
  const datas = sse.events.map((e) => e.data).filter((d) => d !== null);
  const chunks = [];
  const badJson = [];
  for (const d of datas) {
    if (d.trim() === '[DONE]') continue;
    const p = tryJson(d);
    if (p.ok) chunks.push(p.value);
    else badJson.push(d.slice(0, 60));
  }
  if (want(params, 'content_type') && !isEventStream(ex)) problems.push(`content-type is "${contentType(ex) || 'missing'}", expected text/event-stream`);
  if (want(params, 'data_lines')) {
    if (sse.badLines.length) problems.push(`${sse.badLines.length} line(s) are not SSE fields, e.g. "${sse.badLines[0]}" (every payload line must start with "data:")`);
    if (!datas.length) problems.push('no "data:" events found in the stream');
  }
  if (want(params, 'chunks_json')) {
    if (badJson.length) problems.push(`${badJson.length} data event(s) are not JSON, e.g. "${badJson[0]}"`);
    const noChoices = chunks.filter((c) => !Array.isArray(c.choices));
    if (noChoices.length) problems.push(`${noChoices.length} chunk(s) have no "choices" array`);
    if (chunks.length && !chunks.some((c) => c.object === 'chat.completion.chunk')) notes.push('chunks do not set object="chat.completion.chunk"');
  }
  if (want(params, 'done')) {
    const last = datas.length ? datas[datas.length - 1].trim() : null;
    if (!datas.some((d) => d.trim() === '[DONE]')) problems.push('stream ended without "data: [DONE]"');
    else if (last !== '[DONE]') problems.push('"[DONE]" is not the last data event');
  }
  if (want(params, 'finish_reason')) {
    const fr = chunks.flatMap((c) => (Array.isArray(c.choices) ? c.choices : [])).map((ch) => ch && ch.finish_reason).filter((x) => typeof x === 'string' && x);
    if (!fr.length) problems.push('no chunk carries a non-null choices[].finish_reason');
    else notes.push(`finish_reason: ${fr[fr.length - 1]}`);
  }
  if (want(params, 'usage')) {
    const u = chunks.map((c) => c.usage).filter((x) => x && typeof x === 'object');
    if (!u.length) problems.push('no chunk carries "usage" although stream_options.include_usage=true was sent');
    else {
      const last = u[u.length - 1];
      if (typeof last.prompt_tokens !== 'number' || typeof last.completion_tokens !== 'number') problems.push('usage chunk lacks numeric prompt_tokens/completion_tokens');
      else notes.push(`usage: ${last.prompt_tokens} in / ${last.completion_tokens} out`);
    }
  }
  return { problems, notes };
}

/** Anthropic Messages stream: named events whose data.type matches, standard order, stop_reason, usage. */
function sseAnthropic({ exchange: ex, params }) {
  const problems = [];
  const notes = [];
  if (!streamPreconditions(ex, problems)) return { problems, notes };
  const sse = parseSSE(ex.response.text);
  const evs = sse.events.filter((e) => e.data !== null).map((e) => ({ name: e.event, data: tryJson(e.data) }));
  if (want(params, 'content_type') && !isEventStream(ex)) problems.push(`content-type is "${contentType(ex) || 'missing'}", expected text/event-stream`);
  if (want(params, 'event_lines')) {
    if (sse.badLines.length) problems.push(`${sse.badLines.length} line(s) are not SSE fields, e.g. "${sse.badLines[0]}"`);
    const unnamed = evs.filter((e) => !e.name).length;
    if (unnamed) problems.push(`${unnamed} event(s) have no "event:" line`);
    const notJson = evs.filter((e) => !e.data.ok).length;
    if (notJson) problems.push(`${notJson} event(s) carry non-JSON data`);
    const mismatch = evs.filter((e) => e.name && e.data.ok && e.data.value.type !== e.name);
    if (mismatch.length) problems.push(`event name and data.type differ, e.g. "${mismatch[0].name}" vs "${mismatch[0].data.value.type}"`);
  }
  const types = evs.map((e) => e.name || (e.data.ok && e.data.value.type)).filter((t) => t !== 'ping');
  if (want(params, 'sequence')) {
    if (types[0] !== 'message_start') problems.push(`first event is "${types[0] || 'none'}", expected message_start`);
    if (types[types.length - 1] !== 'message_stop') problems.push(`last event is "${types[types.length - 1] || 'none'}", expected message_stop`);
    for (const t of ['content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta']) {
      if (!types.includes(t)) problems.push(`no ${t} event`);
    }
  }
  const md = evs.find((e) => e.data.ok && e.data.value.type === 'message_delta');
  if (want(params, 'stop_reason')) {
    const sr = md && md.data.value.delta && md.data.value.delta.stop_reason;
    if (typeof sr !== 'string') problems.push('message_delta.delta.stop_reason missing');
    else notes.push(`stop_reason: ${sr}`);
  }
  if (want(params, 'usage')) {
    const ms = evs.find((e) => e.data.ok && e.data.value.type === 'message_start');
    const inTok = ms && ms.data.value.message && ms.data.value.message.usage && ms.data.value.message.usage.input_tokens;
    const outTok = md && md.data.value.usage && md.data.value.usage.output_tokens;
    if (typeof inTok !== 'number') problems.push('message_start.message.usage.input_tokens missing');
    if (typeof outTok !== 'number') problems.push('message_delta.usage.output_tokens missing');
    if (!problems.length) notes.push(`usage: ${inTok} in / ${outTok} out`);
  }
  return { problems, notes };
}

/** OpenAI Responses API stream: response.created ... response.completed, output_text deltas. */
function sseResponses({ exchange: ex, params }) {
  const problems = [];
  const notes = [];
  if (!streamPreconditions(ex, problems)) return { problems, notes };
  const sse = parseSSE(ex.response.text);
  const evs = sse.events.filter((e) => e.data !== null && e.data.trim() !== '[DONE]').map((e) => ({ name: e.event, data: tryJson(e.data) }));
  if (want(params, 'content_type') && !isEventStream(ex)) problems.push(`content-type is "${contentType(ex) || 'missing'}", expected text/event-stream`);
  if (sse.badLines.length) problems.push(`${sse.badLines.length} line(s) are not SSE fields, e.g. "${sse.badLines[0]}"`);
  const notJson = evs.filter((e) => !e.data.ok).length;
  if (notJson) problems.push(`${notJson} event(s) carry non-JSON data`);
  const types = evs.map((e) => (e.data.ok && e.data.value.type) || e.name);
  if (types[0] !== 'response.created') problems.push(`first event is "${types[0] || 'none'}", expected response.created`);
  const last = types[types.length - 1];
  if (last !== 'response.completed' && last !== 'response.incomplete') problems.push(`last event is "${last || 'none'}", expected response.completed or response.incomplete`);
  if (!types.includes('response.output_text.delta')) notes.push('no response.output_text.delta event (the model may have produced reasoning only)');
  const done = evs.find((e) => e.data.ok && (e.data.value.type === 'response.completed' || e.data.value.type === 'response.incomplete'));
  const usage = done && done.data.value.response && done.data.value.response.usage;
  if (!usage || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') problems.push('final response event has no usage.input_tokens/output_tokens');
  return { problems, notes };
}

/** Streamed tool call: every tool_calls delta has `index`, arguments are string fragments that join into JSON. */
function sseToolCall({ exchange: ex, params }) {
  const problems = [];
  const notes = [];
  if (!streamPreconditions(ex, problems)) return { problems, notes };
  const sse = parseSSE(ex.response.text);
  const chunks = sse.events.map((e) => e.data).filter((d) => d && d.trim() !== '[DONE]').map((d) => tryJson(d)).filter((p) => p.ok).map((p) => p.value);
  const deltas = [];
  for (const c of chunks) for (const ch of c.choices || []) for (const tc of (ch.delta && ch.delta.tool_calls) || []) deltas.push(tc);
  if (!deltas.length) {
    problems.push('no choices[].delta.tool_calls in the stream although tool_choice forced a function');
    return { problems, notes };
  }
  const calls = new Map();
  let missingIndex = 0;
  let nonString = 0;
  for (const d of deltas) {
    if (typeof d.index !== 'number') missingIndex++;
    const key = typeof d.index === 'number' ? d.index : 0;
    const call = calls.get(key) || { id: null, name: null, args: '' };
    if (d.id) call.id = d.id;
    if (d.function && d.function.name) call.name = d.function.name;
    const a = d.function ? d.function.arguments : undefined;
    if (a !== undefined && typeof a !== 'string') { nonString++; call.args += JSON.stringify(a); }
    else if (typeof a === 'string') call.args += a;
    calls.set(key, call);
  }
  if (want(params, 'index') && missingIndex) problems.push(`${missingIndex} of ${deltas.length} tool_calls delta(s) have no numeric "index"`);
  if (want(params, 'args_string') && nonString) problems.push(`${nonString} delta(s) stream function.arguments as an object instead of a string fragment`);
  for (const [i, c] of calls) {
    if (want(params, 'id_name') && (!c.id || !c.name)) problems.push(`tool call #${i} never sent ${!c.id ? 'an id' : 'a function name'}`);
    if (want(params, 'args_parse') && !tryJson(c.args).ok) problems.push(`tool call #${i}: joined arguments are not valid JSON: ${c.args.slice(0, 60)}`);
  }
  if (!problems.length) notes.push(`${calls.size} streamed tool call(s), ${deltas.length} delta(s)`);
  return { problems, notes };
}

/** Chat-completions tool round-trip: forced call, then send the tool result back. */
async function toolRoundtrip({ exchange: ex, send, check, params }) {
  const problems = [];
  const notes = [];
  const msg = ex.response.json && ex.response.json.choices && ex.response.json.choices[0] && ex.response.json.choices[0].message;
  const calls = msg && Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  if (ex.response.status !== 200 || !calls.length) {
    problems.push(ex.response.status !== 200 ? `step 1 HTTP status ${ex.response.status}` : 'step 1 returned no tool_calls');
    return { problems, notes };
  }
  const call = calls[0];
  let args = call.function && call.function.arguments;
  if (typeof args !== 'string') {
    problems.push('step 1: function.arguments is not a JSON string (re-encoding it for step 2)');
    args = JSON.stringify(args ?? {});
  }
  const body = {
    ...check.request.body,
    tool_choice: 'auto',
    max_tokens: params.followup_max_tokens || 64,
    messages: [
      ...check.request.body.messages,
      { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name: call.function && call.function.name, arguments: args } }] },
      { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ city: 'Jakarta', temp_c: 31 }) },
    ],
  };
  const ex2 = await send({ method: 'POST', path: check.request.path, body });
  const extra = { label: 'step 2: tool result sent back', exchange: ex2 };
  if (ex2.error) { problems.push(`step 2 ${ex2.error}`); return { problems, notes, extra }; }
  if (ex2.response.status !== 200) problems.push(`step 2 (tool result) HTTP status ${ex2.response.status}`);
  else {
    const m2 = ex2.response.json && ex2.response.json.choices && ex2.response.json.choices[0] && ex2.response.json.choices[0].message;
    if (!m2) problems.push('step 2 response has no choices[0].message');
    else notes.push(`step 2 finish_reason: ${ex2.response.json.choices[0].finish_reason}`);
  }
  return { problems, notes, extra };
}

/** Anthropic tool round-trip: forced tool_use, then a tool_result block. */
async function anthropicToolRoundtrip({ exchange: ex, send, check, params }) {
  const problems = [];
  const notes = [];
  const content = ex.response.json && Array.isArray(ex.response.json.content) ? ex.response.json.content : [];
  const use = content.find((b) => b && b.type === 'tool_use');
  if (ex.response.status !== 200 || !use) {
    problems.push(ex.response.status !== 200 ? `step 1 HTTP status ${ex.response.status}` : 'step 1 returned no tool_use block');
    return { problems, notes };
  }
  if (!use.input || typeof use.input !== 'object' || Array.isArray(use.input)) problems.push(`step 1: tool_use.input is ${typeof use.input}, expected an object`);
  const body = {
    ...check.request.body,
    tool_choice: { type: 'auto' },
    max_tokens: params.followup_max_tokens || 64,
    messages: [
      ...check.request.body.messages,
      { role: 'assistant', content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify({ city: 'Jakarta', temp_c: 31 }) }] },
    ],
  };
  const ex2 = await send({ method: 'POST', path: check.request.path, body });
  const extra = { label: 'step 2: tool_result sent back', exchange: ex2 };
  if (ex2.error) { problems.push(`step 2 ${ex2.error}`); return { problems, notes, extra }; }
  if (ex2.response.status !== 200) problems.push(`step 2 (tool_result) HTTP status ${ex2.response.status}`);
  else if (!ex2.response.json || !Array.isArray(ex2.response.json.content)) problems.push('step 2 response has no content array');
  else notes.push(`step 2 stop_reason: ${ex2.response.json.stop_reason}`);
  return { problems, notes, extra };
}

/** Which reasoning dialect does the endpoint speak? Informational; inline <think> tags are a warning. */
function reasoningDialect({ exchange: ex }) {
  const notes = [];
  const problems = [];
  const msg = ex.response.json && ex.response.json.choices && ex.response.json.choices[0] && ex.response.json.choices[0].message;
  if (!msg) return { problems: ['no choices[0].message to inspect'], notes, status: 'info' };
  const found = [];
  if (Object.prototype.hasOwnProperty.call(msg, 'reasoning_content')) found.push('reasoning_content');
  if (Object.prototype.hasOwnProperty.call(msg, 'reasoning')) found.push('reasoning');
  if (Object.prototype.hasOwnProperty.call(msg, 'reasoning_details')) found.push('reasoning_details');
  if (Object.prototype.hasOwnProperty.call(msg, 'thinking')) found.push('thinking');
  const rt = ex.response.json.usage && ex.response.json.usage.completion_tokens_details && ex.response.json.usage.completion_tokens_details.reasoning_tokens;
  if (found.length) notes.push(`reasoning field(s): ${found.join(', ')}`);
  else notes.push('no reasoning field in the message (fine for non-reasoning models)');
  if (typeof rt === 'number') notes.push(`usage.completion_tokens_details.reasoning_tokens = ${rt}`);
  if (typeof msg.content === 'string' && /<think>/i.test(msg.content)) {
    problems.push('reasoning is inlined in content as <think> tags; most clients will show it to the user');
    return { problems, notes, status: 'warn' };
  }
  return { problems, notes, status: 'info' };
}

export const EVALUATORS = {
  sse_openai: { fn: sseOpenAI, extraRequests: 0 },
  sse_anthropic: { fn: sseAnthropic, extraRequests: 0 },
  sse_responses: { fn: sseResponses, extraRequests: 0 },
  sse_tool_call: { fn: sseToolCall, extraRequests: 0 },
  tool_roundtrip: { fn: toolRoundtrip, extraRequests: 1 },
  anthropic_tool_roundtrip: { fn: anthropicToolRoundtrip, extraRequests: 1 },
  reasoning_dialect: { fn: reasoningDialect, extraRequests: 0 },
};
