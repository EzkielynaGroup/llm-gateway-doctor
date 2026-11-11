// A tiny local endpoint that speaks OpenAI chat completions, Anthropic messages and Responses,
// with switchable quirks so tests can prove the doctor detects each one. 127.0.0.1 only, no cost.
//
// Run by hand:  node test/mock-server.mjs --port 8787 --quirks no_done,args_object
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const MOCK_KEY = 'sk-' + 'test-mock-0001';
export const MOCK_MODEL = 'mock-model';
export const QUIRKS = ['no_done', 'args_object', 'no_usage', 'reject_tool_calls_null', 'html_errors', 'no_index', 'echo_key', 'reasoning', 'ignore_stream', 'no_auth', 'slow'];

const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const e of events) res.write(e);
  res.end();
};

export function startMock({ quirks = [], port = 0 } = {}) {
  const q = new Set(quirks);
  const requests = [];

  const sendError = (res, status, message, type, anthropic = false) => {
    if (q.has('html_errors')) {
      res.writeHead(status, { 'content-type': 'text/html' });
      return res.end(`<!DOCTYPE html><html><head><title>${status}</title></head><body><h1>${status} Error</h1><p>nginx</p></body></html>`);
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    const body = anthropic ? { type: 'error', error: { type, message } } : { error: { message, type, code: type } };
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { return sendError(res, 400, 'invalid JSON body', 'invalid_request_error'); }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const url = req.url.split('?')[0];
      const isAnthropic = url === '/v1/messages' || (url === '/v1/models' && req.headers['x-api-key'] !== undefined);
      // Auth
      const given = isAnthropic ? req.headers['x-api-key'] : (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!q.has('no_auth')) {
        if (given !== MOCK_KEY) {
          const msg = q.has('echo_key') ? `Incorrect API key provided: ${given}` : 'invalid api key';
          return sendError(res, 401, msg, 'authentication_error', isAnthropic);
        }
      }
      if (req.method === 'GET' && url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: MOCK_MODEL, object: 'model', created: 1, owned_by: 'mock' }] }));
      }
      if (q.has('slow')) return setTimeout(() => sendError(res, 504, 'too slow', 'timeout'), 3000);
      if (req.method === 'POST' && url === '/v1/chat/completions') return chat(body, res, given);
      if (req.method === 'POST' && url === '/v1/messages') {
        if (!req.headers['anthropic-version']) return sendError(res, 400, 'anthropic-version header is required', 'invalid_request_error', true);
        return messages(body, res);
      }
      if (req.method === 'POST' && url === '/v1/responses') return responses(body, res);
      return sendError(res, 404, `no route ${req.method} ${url}`, 'not_found');
    });
  });

  function chat(body, res, given) {
    if (body.model !== MOCK_MODEL) return sendError(res, 404, `model ${body.model} not found`, 'model_not_found');
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    if (q.has('reject_tool_calls_null') && msgs.some((m) => m.role === 'assistant' && 'tool_calls' in m && (m.tool_calls === null || (Array.isArray(m.tool_calls) && !m.tool_calls.length)))) {
      return sendError(res, 400, "Invalid 'messages[1].tool_calls': expected an array with minimum length 1", 'invalid_request_error');
    }
    const last = msgs[msgs.length - 1] || {};
    const wantsTool = Array.isArray(body.tools) && body.tools.length && last.role !== 'tool' && body.tool_choice && body.tool_choice !== 'auto' && body.tool_choice !== 'none';
    const text = body.response_format && body.response_format.type === 'json_object' ? '{"ok":true}' : last.role === 'tool' ? 'It is 31 C in Jakarta.' : 'OK';
    const usage = { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 };
    const id = 'chatcmpl-mock1';
    const created = 1763000000;
    const args = { city: 'Jakarta' };

    if (body.stream && !q.has('ignore_stream')) {
      const ev = [];
      const chunk = (choices, extra = {}) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: MOCK_MODEL, choices, ...extra })}\n\n`;
      ev.push(chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]));
      if (wantsTool) {
        const first = { id: 'call_mock1', type: 'function', function: { name: 'get_weather', arguments: q.has('args_object') ? args : '' } };
        const frag = (a) => ({ function: { arguments: a } });
        const withIdx = (o) => (q.has('no_index') ? o : { index: 0, ...o });
        ev.push(chunk([{ index: 0, delta: { tool_calls: [withIdx(first)] }, finish_reason: null }]));
        if (!q.has('args_object')) {
          ev.push(chunk([{ index: 0, delta: { tool_calls: [withIdx(frag('{"city":'))] }, finish_reason: null }]));
          ev.push(chunk([{ index: 0, delta: { tool_calls: [withIdx(frag('"Jakarta"}'))] }, finish_reason: null }]));
        }
        ev.push(chunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]));
      } else {
        if (q.has('reasoning')) ev.push(chunk([{ index: 0, delta: { reasoning_content: 'Thinking.' }, finish_reason: null }]));
        ev.push(chunk([{ index: 0, delta: { content: text }, finish_reason: null }]));
        ev.push(chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]));
      }
      if (body.stream_options && body.stream_options.include_usage && !q.has('no_usage')) ev.push(chunk([], { usage }));
      if (!q.has('no_done')) ev.push('data: [DONE]\n\n');
      return sse(res, ev);
    }
    const message = { role: 'assistant', content: wantsTool ? null : q.has('echo_key') ? `${text} (debug: called with key ${given})` : text };
    if (wantsTool) message.tool_calls = [{ id: 'call_mock1', type: 'function', function: { name: 'get_weather', arguments: q.has('args_object') ? args : JSON.stringify(args) } }];
    if (q.has('reasoning')) message.reasoning_content = 'Thinking.';
    const out = { id, object: 'chat.completion', created, model: MOCK_MODEL, choices: [{ index: 0, message, finish_reason: wantsTool ? 'tool_calls' : 'stop' }] };
    if (!q.has('no_usage')) out.usage = usage;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(out));
  }

  function messages(body, res) {
    if (body.model !== MOCK_MODEL) return sendError(res, 404, `model: ${body.model}`, 'not_found_error', true);
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const last = msgs[msgs.length - 1] || {};
    const isToolResult = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
    const wantsTool = Array.isArray(body.tools) && body.tools.length && body.tool_choice && body.tool_choice.type === 'tool' && !isToolResult;
    const content = wantsTool
      ? [{ type: 'tool_use', id: 'toolu_mock1', name: 'get_weather', input: q.has('args_object') ? JSON.stringify({ city: 'Jakarta' }) : { city: 'Jakarta' } }]
      : [{ type: 'text', text: isToolResult ? 'It is 31 C in Jakarta.' : 'OK' }];
    const stop = wantsTool ? 'tool_use' : 'end_turn';
    const msg = { id: 'msg_mock1', type: 'message', role: 'assistant', model: MOCK_MODEL, content, stop_reason: stop, stop_sequence: null };
    if (!q.has('no_usage')) msg.usage = { input_tokens: 12, output_tokens: 2 };
    if (body.stream && !q.has('ignore_stream')) {
      const e = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      const start = { ...msg, content: [], stop_reason: null };
      if (!q.has('no_usage')) start.usage = { input_tokens: 12, output_tokens: 1 };
      const ev = [e('message_start', { message: start }), e('ping', {})];
      ev.push(e('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
      ev.push(e('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OK' } }));
      ev.push(e('content_block_stop', { index: 0 }));
      ev.push(e('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, ...(q.has('no_usage') ? {} : { usage: { output_tokens: 2 } }) }));
      ev.push(e('message_stop', {}));
      if (q.has('no_done')) ev.splice(ev.length - 1, 1); // anthropic analogue: missing message_stop
      return sse(res, ev);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(msg));
  }

  function responses(body, res) {
    if (body.model !== MOCK_MODEL) return sendError(res, 404, `model ${body.model} not found`, 'model_not_found');
    const resp = {
      id: 'resp_mock1', object: 'response', created_at: 1763000000, status: 'completed', model: MOCK_MODEL,
      output: [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }],
    };
    if (!q.has('no_usage')) resp.usage = { input_tokens: 12, output_tokens: 2, total_tokens: 14 };
    if (body.stream && !q.has('ignore_stream')) {
      const e = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      return sse(res, [
        e('response.created', { response: { ...resp, status: 'in_progress', output: [], usage: null } }),
        e('response.output_text.delta', { item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'OK' }),
        e('response.completed', { response: resp }),
      ]);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(resp));
  }

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      resolve({
        port: p,
        openaiBase: `http://127.0.0.1:${p}/v1`,
        anthropicBase: `http://127.0.0.1:${p}`,
        requests,
        close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); }),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  const port = Number(args[args.indexOf('--port') + 1]) || 8787;
  const qi = args.indexOf('--quirks');
  const quirks = qi >= 0 ? args[qi + 1].split(',').filter(Boolean) : [];
  startMock({ port, quirks }).then((m) => {
    process.stderr.write(`mock listening on ${m.openaiBase} (anthropic: ${m.anthropicBase}) quirks=[${quirks.join(',')}]\n`);
    process.stderr.write(`test key: export OPENAI_API_KEY=${MOCK_KEY}\n`);
  });
}
