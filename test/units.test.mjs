// Unit tests: check validation, SSE parser, redaction, URL building, presets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChecks, validateCheck, selectChecks } from '../src/runner.mjs';
import { parseSSE, buildUrl } from '../src/http.mjs';
import { makeRedactor, getPath, fillTemplate, safeUrl } from '../src/util.mjs';
import { renderBadge } from '../src/report.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = () => ({
  id: 'x.y', profile: ['chat'], title: 't', severity: 'fail', fix_hint: 'h',
  request: { method: 'POST', path: '/chat/completions', body: { model: '{{model}}', max_tokens: 16 } },
  assertions: [{ type: 'status', in: [200] }],
});

test('built-in checks load and cover all four profiles', () => {
  const all = loadChecks();
  assert.ok(all.length >= 30, `only ${all.length} checks`);
  const count = (p) => selectChecks(all, p).length;
  assert.equal(count('chat'), 15);
  assert.equal(count('agent'), 20);
  assert.equal(count('anthropic'), 12);
  assert.equal(count('responses'), 6);
  for (const c of all) assert.ok(c.fix_hint.length > 20, c.id);
});

test('validation enforces the cost guard', () => {
  assert.deepEqual(validateCheck(base()), []);
  const big = base(); big.request.body.max_tokens = 17;
  assert.match(validateCheck(big).join(), /exceeds 16/);
  const tool = base(); tool.budget = 'tool'; tool.request.body.max_tokens = 64;
  assert.deepEqual(validateCheck(tool), []);
  tool.request.body.max_tokens = 65;
  assert.match(validateCheck(tool).join(), /exceeds 64/);
  const none = base(); delete none.request.body.max_tokens;
  assert.match(validateCheck(none).join(), /must set max_tokens/);
});

test('validation rejects unknown assertions, evaluators, profiles and missing hints', () => {
  const a = base(); a.assertions = [{ type: 'nope' }];
  assert.match(validateCheck(a).join(), /unknown assertion/);
  const e = base(); e.evaluator = { name: 'nope' };
  assert.match(validateCheck(e).join(), /unknown evaluator/);
  const p = base(); p.profile = ['gemini'];
  assert.match(validateCheck(p).join(), /profile/);
  const h = base(); delete h.fix_hint;
  assert.match(validateCheck(h).join(), /fix_hint/);
});

test('community checks load from an extra folder without code changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lgd-checks-'));
  writeFileSync(join(dir, 'mine.json'), JSON.stringify({ checks: [{ ...base(), id: 'community.ok' }] }));
  const all = loadChecks([dir]);
  assert.ok(all.some((c) => c.id === 'community.ok'));
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ checks: [{ ...base(), id: 'community.bad', severity: 'loud' }] }));
  assert.throws(() => loadChecks([dir]), /severity/);
});

test('--only keeps the checks a selected check reuses', () => {
  const sel = selectChecks(loadChecks(), 'chat', { only: ['chat.stream.done'] }).map((c) => c.id);
  assert.deepEqual(sel, ['chat.stream.framing', 'chat.stream.done']);
});

test('parseSSE handles events, comments, CRLF and junk lines', () => {
  const s = parseSSE(': keepalive\r\nevent: a\r\ndata: {"x":1}\r\n\r\ndata: [DONE]\n\n{"raw":true}\n');
  assert.equal(s.comments, 1);
  assert.equal(s.events.length, 2);
  assert.equal(s.events[0].event, 'a');
  assert.equal(s.events[1].data, '[DONE]');
  assert.equal(s.badLines.length, 1);
});

test('redactor removes the key, bearer tokens and key-shaped strings', () => {
  const key = 'sk-' + 'live-abcdefghijklmnop';
  const r = makeRedactor([key]);
  const out = r(`key ${key} and Bearer abc.def and ${'sk-' + 'other1234567890'} ok`);
  assert.ok(!out.includes(key));
  assert.ok(!out.includes('abc.def'));
  assert.ok(!out.includes('other1234567890'));
  assert.match(out, /ok$/);
});

test('buildUrl joins OpenAI and Anthropic bases', () => {
  assert.equal(buildUrl('https://h/v1/', 'openai', '/chat/completions'), 'https://h/v1/chat/completions');
  assert.equal(buildUrl('https://h', 'anthropic', '/messages'), 'https://h/v1/messages');
  assert.equal(buildUrl('https://h/v1', 'anthropic', '/messages'), 'https://h/v1/messages');
  assert.equal(buildUrl('https://h/anthropic', 'anthropic', '/messages'), 'https://h/anthropic/v1/messages');
});

test('safeUrl strips credentials and query strings', () => {
  assert.equal(safeUrl('https://u:p@h/v1?key=abc'), 'https://h/v1?[REDACTED]');
});

test('getPath and fillTemplate', () => {
  assert.equal(getPath({ a: [{ b: 2 }] }, 'a[0].b'), 2);
  assert.equal(getPath({}, 'a[0].b'), undefined);
  assert.deepEqual(fillTemplate({ m: '{{model}}', s: 'x {{model}}' }, { model: 'm1' }), { m: 'm1', s: 'x m1' });
});

test('badge is a valid-looking SVG with escaped text', () => {
  const svg = renderBadge({ score: '3/4', features: ['chat', 'stream'], fail: 1, warn: 0 });
  assert.match(svg, /^<svg /);
  assert.match(svg, /compat: 3\/4 · chat\+stream/);
  assert.match(svg, /#e05d44/);
});

test('presets are alphabetical, complete and never local-by-default', () => {
  const presets = JSON.parse(readFileSync(join(ROOT, 'presets.json'), 'utf8')).presets;
  const labels = presets.map((p) => p.label.toLowerCase());
  assert.deepEqual(labels, [...labels].sort());
  assert.deepEqual(presets.map((p) => p.name), ['anthropic', 'deepseek', 'ezkielyna', 'groq', 'litellm', 'ollama', 'openai', 'openrouter', 'together', 'vllm']);
  for (const p of presets) {
    assert.ok(p.openai_base_url || p.anthropic_base_url, p.name);
    assert.match(p.docs, /^https:\/\//);
  }
  const ezk = presets.find((p) => p.name === 'ezkielyna');
  assert.equal(ezk.openai_base_url, 'https://api.ezkielyna.store/v1');
  assert.equal(ezk.anthropic_base_url, 'https://api.ezkielyna.store');
});
