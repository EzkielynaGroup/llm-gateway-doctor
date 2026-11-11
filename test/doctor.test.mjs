// Runner-level tests: each mock quirk must be detected by the right check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMock, MOCK_KEY, MOCK_MODEL } from './mock-server.mjs';
import { loadChecks, selectChecks, runChecks, summarize, planRun } from '../src/runner.mjs';

const ALL = loadChecks();

async function run(profile, quirks = [], extra = {}) {
  const mock = await startMock({ quirks });
  try {
    const checks = selectChecks(ALL, profile, extra);
    const results = await runChecks(checks, {
      baseUrl: profile === 'anthropic' ? mock.anthropicBase : mock.openaiBase,
      profile,
      model: MOCK_MODEL,
      apiKey: MOCK_KEY,
      timeoutMs: extra.timeoutMs || 5000,
    });
    const by = Object.fromEntries(results.map((r) => [r.id, r]));
    return { results, by, summary: summarize(results, profile), requests: mock.requests, plan: planRun(checks, { model: MOCK_MODEL }) };
  } finally {
    await mock.close();
  }
}

for (const profile of ['chat', 'agent', 'anthropic', 'responses']) {
  test(`clean mock passes every ${profile} check`, async () => {
    const { results, summary } = await run(profile);
    const bad = results.filter((r) => r.status === 'fail' || r.status === 'warn' || r.status === 'skip');
    assert.deepEqual(bad.map((r) => `${r.id}: ${r.problems.join('; ')}`), []);
    assert.equal(summary.fail, 0);
    assert.ok(summary.pass >= 5);
  });
}

test('plan request count matches the requests actually sent', async () => {
  for (const profile of ['chat', 'agent', 'anthropic', 'responses']) {
    const { plan, requests } = await run(profile);
    assert.equal(plan.requests, requests.length, profile);
  }
});

test('agent profile has 20 checks and the clean badge features', async () => {
  const { results, summary } = await run('agent');
  assert.equal(results.length, 20);
  assert.equal(summary.score, '19/19');
  assert.deepEqual(summary.features, ['chat', 'stream', 'usage', 'tools', 'json']);
});

test('quirk no_done: missing [DONE] fails chat.stream.done', async () => {
  const { by } = await run('chat', ['no_done']);
  assert.equal(by['chat.stream.done'].status, 'fail');
  assert.match(by['chat.stream.done'].problems.join(), /\[DONE\]/);
  assert.equal(by['chat.stream.framing'].status, 'pass');
});

test('quirk no_done (anthropic analogue): missing message_stop fails the event order', async () => {
  const { by } = await run('anthropic', ['no_done']);
  assert.equal(by['anthropic.stream.events'].status, 'fail');
  assert.match(by['anthropic.stream.events'].problems.join(), /message_stop/);
});

test('quirk args_object: arguments as an object fail tool checks', async () => {
  const { by } = await run('agent', ['args_object']);
  assert.equal(by['agent.tools.call'].status, 'fail');
  assert.match(by['agent.tools.call'].problems.join(), /JSON-encoded string/);
  assert.equal(by['agent.tools.stream'].status, 'fail');
  assert.match(by['agent.tools.stream'].problems.join(), /object instead of a string/);
  assert.equal(by['agent.tools.roundtrip'].status, 'fail');
});

test('quirk args_object (anthropic analogue): tool_use.input as a string fails the round-trip', async () => {
  const { by } = await run('anthropic', ['args_object']);
  assert.equal(by['anthropic.tools.roundtrip'].status, 'fail');
  assert.match(by['anthropic.tools.roundtrip'].problems.join(), /expected an object/);
});

test('quirk no_usage: missing usage is detected in every profile', async () => {
  const chat = await run('chat', ['no_usage']);
  assert.equal(chat.by['chat.usage'].status, 'fail');
  assert.equal(chat.by['chat.stream.usage'].status, 'warn');
  assert.equal(chat.by['chat.basic'].status, 'pass');
  const anth = await run('anthropic', ['no_usage']);
  assert.equal(anth.by['anthropic.usage'].status, 'fail');
  assert.equal(anth.by['anthropic.stream.usage'].status, 'warn');
  const resp = await run('responses', ['no_usage']);
  assert.equal(resp.by['responses.usage'].status, 'warn');
  assert.equal(resp.by['responses.stream'].status, 'fail');
});

test('quirk reject_tool_calls_null: replay checks warn, the rest still pass', async () => {
  const { by, summary } = await run('agent', ['reject_tool_calls_null']);
  assert.equal(by['agent.replay.tool_calls_null'].status, 'warn');
  assert.equal(by['agent.replay.tool_calls_empty'].status, 'warn');
  assert.match(by['agent.replay.tool_calls_null'].problems.join(), /400/);
  assert.equal(summary.fail, 0);
});

test('quirk html_errors: HTML error pages are flagged', async () => {
  const { by } = await run('chat', ['html_errors']);
  assert.equal(by['chat.errors.bad_model'].status, 'fail');
  assert.match(by['chat.errors.bad_model'].problems.join(), /HTML page/);
  assert.equal(by['chat.errors.bad_key'].status, 'warn');
  const anth = await run('anthropic', ['html_errors']);
  assert.equal(anth.by['anthropic.errors.bad_model'].status, 'fail');
});

test('quirk no_index: streamed tool calls without index fail', async () => {
  const { by } = await run('agent', ['no_index']);
  assert.equal(by['agent.tools.stream'].status, 'fail');
  assert.match(by['agent.tools.stream'].problems.join(), /index/);
});

test('quirk reasoning: dialect check reports reasoning_content as info', async () => {
  const { by } = await run('chat', ['reasoning']);
  const r = by['chat.reasoning.dialect'];
  assert.equal(r.status, 'info');
  assert.match(r.notes.join(), /reasoning_content/);
});

test('quirk ignore_stream: a JSON body for stream=true fails framing and dependants', async () => {
  const { by } = await run('chat', ['ignore_stream']);
  assert.equal(by['chat.stream.framing'].status, 'fail');
  assert.match(by['chat.stream.framing'].problems.join(), /ignored/);
  assert.equal(by['chat.stream.done'].status, 'fail');
});

test('quirk no_auth: bad key accepted is a warning, not a failure', async () => {
  const { by } = await run('chat', ['no_auth']);
  assert.equal(by['chat.errors.bad_key'].status, 'warn');
});

test('timeouts are reported per request', async () => {
  const t0 = Date.now();
  const { by } = await run('chat', ['slow'], { only: ['chat.basic'], timeoutMs: 300 });
  assert.equal(by['chat.basic'].status, 'fail');
  assert.match(by['chat.basic'].problems.join(), /timeout after 300 ms/);
  assert.ok(Date.now() - t0 < 2500);
});

test('connection refused is a failed check, and reused checks are skipped', async () => {
  const checks = selectChecks(ALL, 'chat', { only: ['chat.basic', 'chat.usage'] });
  const results = await runChecks(checks, { baseUrl: 'http://127.0.0.1:9/v1', profile: 'chat', model: 'x', apiKey: 'k', timeoutMs: 2000 });
  const by = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(by['chat.basic'].status, 'fail');
  assert.match(by['chat.basic'].problems.join(), /request failed/);
  assert.equal(by['chat.usage'].status, 'skip');
});

test('anthropic requests carry x-api-key and anthropic-version, not Authorization', async () => {
  const { requests } = await run('anthropic', [], { only: ['anthropic.basic'] });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/v1/messages');
  assert.equal(requests[0].headers['x-api-key'], MOCK_KEY);
  assert.equal(requests[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(requests[0].headers.authorization, undefined);
});

test('every request respects the output-token caps (16, tool checks 64)', async () => {
  const { requests } = await run('agent');
  for (const r of requests) {
    if (r.method !== 'POST') continue;
    const cap = Math.max(r.body.max_tokens || 0, r.body.max_completion_tokens || 0, r.body.max_output_tokens || 0);
    assert.ok(cap > 0 && cap <= (r.body.tools ? 64 : 16), `${r.url} cap ${cap}`);
  }
});
