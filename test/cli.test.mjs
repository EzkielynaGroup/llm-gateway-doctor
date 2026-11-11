// CLI tests: spawn the real binary against the local mock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock, MOCK_KEY, MOCK_MODEL } from './mock-server.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'llm-gateway-doctor.mjs');

function cli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { PATH: process.env.PATH, NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const tmp = () => mkdtempSync(join(tmpdir(), 'lgd-cli-'));

test('--help and --version', async () => {
  const h = await cli(['--help']);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /--dry-run/);
  const v = await cli(['--version']);
  assert.equal(v.stdout.trim(), '0.1.0');
});

test('there is no default base URL', async () => {
  const r = await cli(['--model', 'x']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no default endpoint/);
});

test('unknown flags and bad profiles are usage errors', async () => {
  assert.equal((await cli(['--nope'])).code, 2);
  const r = await cli(['--base-url', 'http://127.0.0.1:1/v1', '--model', 'x', '--profile', 'gemini']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--profile must be/);
});

test('--dry-run prints the plan and sends nothing', async () => {
  const mock = await startMock();
  try {
    const r = await cli(['--base-url', mock.openaiBase, '--model', MOCK_MODEL, '--profile', 'agent', '--dry-run']);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /Plan: 20 checks, 13 requests/);
    assert.match(r.stderr, /output tokens/);
    assert.match(r.stderr, /Dry run: nothing was sent/);
    assert.equal(mock.requests.length, 0);
  } finally {
    await mock.close();
  }
});

test('--preset fills base URL and profile', async () => {
  const r = await cli(['--preset', 'ollama', '--model', 'llama3.2', '--dry-run']);
  assert.equal(r.code, 0);
  assert.match(r.stderr, /http:\/\/localhost:11434\/v1/);
  const a = await cli(['--preset', 'deepseek', '--profile', 'anthropic', '--model', 'm', '--dry-run']);
  assert.match(a.stderr, /https:\/\/api\.deepseek\.com\/anthropic/);
  assert.match(a.stderr, /DEEPSEEK_API_KEY/);
  const g = await cli(['--preset', 'groq', '--profile', 'anthropic', '--model', 'm', '--dry-run']);
  assert.equal(g.code, 2);
  const l = await cli(['--list-presets']);
  assert.equal(l.stdout.trim().split('\n').length, 10);
});

test('a missing key for a remote host stops before any request', async () => {
  const r = await cli(['--base-url', 'https://gateway.invalid/v1', '--model', 'm', '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /\$OPENAI_API_KEY is empty/);
});

test('--key-env must be a variable name, not a key', async () => {
  const r = await cli(['--base-url', 'https://gateway.invalid/v1', '--model', 'm', '--key-env', 'sk-' + 'abc', '--dry-run']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /environment variable name/);
});

test('--json prints a parseable report and exit code 0 on a clean endpoint', async () => {
  const mock = await startMock();
  try {
    const r = await cli(['--base-url', mock.openaiBase, '--model', MOCK_MODEL, '--json', '--yes'], { OPENAI_API_KEY: MOCK_KEY });
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.tool, 'llm-gateway-doctor');
    assert.equal(j.target.profile, 'chat');
    assert.equal(j.summary.fail, 0);
    assert.equal(j.checks.length, 15);
    assert.ok(j.checks.every((c) => typeof c.status === 'string'));
  } finally {
    await mock.close();
  }
});

test('exit code 1 when a check fails, with the fix hint in the table', async () => {
  const mock = await startMock({ quirks: ['no_done'] });
  try {
    const r = await cli(['--base-url', mock.openaiBase, '--model', MOCK_MODEL], { OPENAI_API_KEY: MOCK_KEY });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /FAIL\s+chat\.stream\.done/);
    assert.match(r.stdout, /fix: OpenAI SDKs/);
  } finally {
    await mock.close();
  }
});

test('an existing HTML file is never overwritten without --force', async () => {
  const mock = await startMock();
  const dir = tmp();
  const file = join(dir, 'report.html');
  writeFileSync(file, 'keep me');
  try {
    const r = await cli(['--base-url', mock.openaiBase, '--model', MOCK_MODEL, '--html', file], { OPENAI_API_KEY: MOCK_KEY });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /already exists/);
    assert.equal(readFileSync(file, 'utf8'), 'keep me');
    assert.equal(mock.requests.length, 0, 'no request may be sent when the output file is blocked');
    const f = await cli(['--base-url', mock.openaiBase, '--model', MOCK_MODEL, '--html', file, '--force'], { OPENAI_API_KEY: MOCK_KEY });
    assert.equal(f.code, 0);
    assert.match(readFileSync(file, 'utf8'), /^<!doctype html>/);
  } finally {
    await mock.close();
  }
});

test('the key never appears in stdout, stderr, JSON or HTML, even when echoed by the server', async () => {
  const mock = await startMock({ quirks: ['echo_key', 'no_usage'] });
  const dir = tmp();
  const html = join(dir, 'r.html');
  try {
    const r = await cli(['--base-url', mock.openaiBase, '--model', MOCK_MODEL, '--json', '--html', html, '--header', 'X-Custom-Secret: hunter2-value'], { OPENAI_API_KEY: MOCK_KEY });
    assert.equal(r.code, 1);
    const page = readFileSync(html, 'utf8');
    for (const text of [r.stdout, r.stderr, page]) {
      assert.ok(!text.includes(MOCK_KEY), 'key leaked');
      assert.ok(!text.includes('hunter2-value'), 'custom header leaked');
    }
    assert.match(page, /\[REDACTED\]/);
    assert.match(page, /debug: called with key \[REDACTED\]/);
    assert.match(page, /Fix hint/);
    const j = JSON.parse(r.stdout);
    const usage = j.checks.find((c) => c.id === 'chat.usage');
    assert.equal(usage.status, 'fail');
    assert.ok(usage.exchanges[0].response.body.includes('[REDACTED]'));
    assert.equal(usage.exchanges[0].request.headers.authorization, '[REDACTED]');
  } finally {
    await mock.close();
  }
});

test('--badge writes the compat text and respects --force', async () => {
  const mock = await startMock();
  const dir = tmp();
  const badge = join(dir, 'badge.svg');
  try {
    const r = await cli(['--base-url', mock.openaiBase, '--model', MOCK_MODEL, '--profile', 'agent', '--badge', badge], { OPENAI_API_KEY: MOCK_KEY });
    assert.equal(r.code, 0, r.stderr);
    const svg = readFileSync(badge, 'utf8');
    assert.match(svg, /compat: 19\/19 · chat\+stream\+usage\+tools\+json/);
    assert.match(svg, /#44cc11/);
    const again = await cli(['--base-url', mock.openaiBase, '--model', MOCK_MODEL, '--badge', badge], { OPENAI_API_KEY: MOCK_KEY });
    assert.equal(again.code, 2);
    assert.match(readFileSync(badge, 'utf8'), /19\/19/);
  } finally {
    await mock.close();
  }
});

test('anthropic profile end to end via the CLI', async () => {
  const mock = await startMock();
  try {
    const r = await cli(['--base-url', mock.anthropicBase, '--model', MOCK_MODEL, '--profile', 'anthropic', '--json'], { ANTHROPIC_API_KEY: MOCK_KEY });
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.summary.score, '12/12');
    assert.ok(j.summary.features.includes('anthropic'));
  } finally {
    await mock.close();
  }
});

test('a local endpoint without a key still runs (no auth header sent)', async () => {
  const mock = await startMock({ quirks: ['no_auth'] });
  try {
    const r = await cli(['--base-url', mock.openaiBase, '--model', MOCK_MODEL, '--only', 'chat.basic']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /sending requests without a key/);
    assert.equal(mock.requests[0].headers.authorization, undefined);
  } finally {
    await mock.close();
  }
});

test('--list-checks shows the agent profile', async () => {
  const r = await cli(['--list-checks', '--profile', 'agent']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim().split('\n').length, 20);
  assert.ok(!existsSync('report.html'));
});
