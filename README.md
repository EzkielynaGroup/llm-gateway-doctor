# llm-gateway-doctor

**Your provider says "OpenAI-compatible". Check it in 30 seconds.**

`llm-gateway-doctor` runs small conformance checks against any OpenAI- or Anthropic-compatible endpoint
(a hosted API, a gateway, LiteLLM, vLLM, Ollama, your own proxy) using **your own key**, and tells you
exactly which parts of the wire format break real clients: SSE framing, `[DONE]`, usage in streams,
tool-call arguments, history replay, error shapes. It writes a terminal table, JSON, a self-contained
HTML report and an SVG badge.

- Zero runtime dependencies, Node 18+, one command: `npx llm-gateway-doctor`.
- Cheap by design: about 8 to 13 requests per run, `max_tokens` 16 (64 for tool calls), a plan and a token estimate before anything is sent.
- Checks are JSON data files, so you can add a quirk without touching code.

## Quick start (30 seconds)

```bash
export OPENAI_API_KEY=sk-...            # your key; it is never printed and is redacted in reports
npx llm-gateway-doctor --base-url https://your-endpoint.example/v1 --model your-model-id
```

Anthropic Messages format:

```bash
export ANTHROPIC_API_KEY=...
npx llm-gateway-doctor --base-url https://your-endpoint.example --model your-model-id --profile anthropic
```

Tools + streaming (what coding agents need), with an HTML report and a badge:

```bash
npx llm-gateway-doctor --base-url http://localhost:8000/v1 --model my-model \
  --profile agent --html doctor-report.html --badge doctor-badge.svg
```

See the plan without sending anything:

```bash
npx llm-gateway-doctor --preset ollama --model llama3.2 --profile agent --dry-run
```

## Example output

From a run against the bundled mock server with three quirks switched on (`no_done`, `args_object`,
`reject_tool_calls_null`); passing rows trimmed:

```text
Plan: 20 checks, 13 requests to http://127.0.0.1:18787/v1 (profile agent, model mock-model)
      about 736 input tokens and at most 336 output tokens in total; key from $OPENAI_API_KEY

llm-gateway-doctor 0.1.0 · profile agent · model mock-model
target http://127.0.0.1:18787/v1

 PASS  chat.stream.framing               Stream is SSE: text/event-stream, data: lines, JSON chunks
 FAIL  chat.stream.done                  Stream ends with data: [DONE]
                                         - stream ended without "data: [DONE]"
                                         fix: OpenAI SDKs and many hand-written clients stop reading only at `data: [DONE]`. ...
 FAIL  agent.tools.call                  Forced tool call returns tool_calls with JSON-string arguments
                                         - choices[0].message.tool_calls[0].function.arguments is object, expected a JSON-encoded string
 FAIL  agent.tools.stream                Streamed tool call: every delta has index, arguments are string fragments
                                         - 1 delta(s) stream function.arguments as an object instead of a string fragment
 WARN  agent.replay.tool_calls_null      History with assistant tool_calls: null is accepted
                                         - HTTP status 400, expected 200

compat 13/19 · chat+usage+json   (13 pass, 4 fail, 2 warn, 1 info, 0 skip)
```

The badge reads `compat 13/19 · chat+usage+json`. A feature (chat, anthropic, responses, stream, usage,
tools, json) appears on the badge only when every scored check carrying that tag passed.

## Profiles

| Profile | Endpoint | Checks | Requests |
|---|---|---|---|
| `chat` | `POST /v1/chat/completions`, `GET /v1/models` | 15 | 8 |
| `agent` | chat + tool calls, streamed tool calls, history replay | 20 | 13 |
| `anthropic` | `POST /v1/messages`, `GET /v1/models` with `x-api-key` + `anthropic-version` | 12 | 8 |
| `responses` | `POST /v1/responses` (basic + stream), `GET /v1/models` | 6 | 4 |

Run `npx llm-gateway-doctor --list-checks --profile agent` for the full list. Highlights:

- `/models` shape, and whether your model id is listed.
- Non-stream basics: `choices[0].message.content`, `finish_reason`, `usage`, `id/object/created`.
- SSE framing: `text/event-stream`, only `data:` lines, JSON chunks, final `data: [DONE]`, `finish_reason` in a chunk.
- Anthropic streams: named events, `event:` equals `data.type`, standard order, `stop_reason`, usage split between `message_start` and `message_delta`.
- Usage in streams with `stream_options.include_usage`.
- Tool calls: `arguments` is a JSON **string** that parses, streamed deltas carry `index`, and a full round-trip (tool result sent back).
- Replay tolerance: assistant history with `tool_calls: null` or `[]`.
- `response_format: {type: "json_object"}`, `max_completion_tokens` next to `max_tokens`.
- Error shape for an unknown model and a bad key: 4xx plus parseable JSON with a message (not an HTML page, not a 5xx).
- Reasoning dialect (informational): `reasoning_content`, `reasoning`, `reasoning_details`, or inline `<think>` tags (warn).

## Options

| Option | Description |
|---|---|
| `--base-url <url>` | API base. OpenAI format usually ends in `/v1`; Anthropic format is the host root (`/v1/messages` is added). Required unless `--preset`. There is no default. |
| `--model <id>` | Model id to test. Required. |
| `--profile <p>` | `chat` (default), `anthropic`, `agent`, `responses`. |
| `--preset <name>` | Fill base URL, profile and key variable from `presets.json`. |
| `--key-env <NAME>` | Env var that holds the key. Default `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY` for `anthropic`, or the preset's. |
| `--header "K: V"` | Extra header (repeatable). Values are redacted in reports. |
| `--anthropic-version <v>` | `anthropic-version` header, default `2023-06-01`. |
| `--dry-run` | Print the plan (checks, requests, token estimate) and exit. Sends nothing. |
| `--yes`, `-y` | Skip the confirmation prompt. Non-interactive runs (CI, pipes) never prompt. |
| `--timeout-ms <n>` | Per-request timeout, default 30000. |
| `--only <ids>` / `--skip <ids>` | Comma list of check ids or prefixes (`--only agent.tools`). |
| `--checks <dir>` | Load extra `*.json` check files from a folder (repeatable). |
| `--json` | Print the JSON report to stdout instead of the table. |
| `--html <file>` | Write a self-contained HTML report (no external assets). |
| `--badge <file>` | Write an SVG badge. |
| `--force` | Allow `--html` / `--badge` to overwrite an existing file. Without it the run stops before sending anything. |
| `--list-checks`, `--list-presets` | Show what is available. |
| `--no-color` | Plain output (also `NO_COLOR=1`). |

Exit codes: `0` no failed checks (warnings allowed), `1` at least one failed check, `2` usage or setup error.

## Presets

Base URLs come from each vendor's public documentation (read 12 Nov 2026, links in `presets.json`).
Presets only save typing; nothing is ever used as a default.

| Preset | Label | OpenAI-format base | Anthropic-format base |
|---|---|---|---|
| `anthropic` | Anthropic | – | `https://api.anthropic.com` |
| `deepseek` | DeepSeek | `https://api.deepseek.com` | `https://api.deepseek.com/anthropic` |
| `ezkielyna` | Ezkielyna | `https://api.ezkielyna.store/v1` | `https://api.ezkielyna.store` |
| `groq` | Groq | `https://api.groq.com/openai/v1` | – |
| `litellm` | LiteLLM proxy (local) | `http://localhost:4000` | `http://localhost:4000` |
| `ollama` | Ollama (local) | `http://localhost:11434/v1` | – |
| `openai` | OpenAI | `https://api.openai.com/v1` | – |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | – |
| `together` | Together AI | `https://api.together.ai/v1` | – |
| `vllm` | vLLM (local) | `http://localhost:8000/v1` | `http://localhost:8000` |

## FAQ

**How do I test if my API is really OpenAI-compatible?**
Run `npx llm-gateway-doctor --base-url <your base> --model <id> --profile agent`. It checks the parts
clients actually depend on (streaming, `[DONE]`, usage, tool calls, error shapes), not just whether one
request returns 200.

**Why does my OpenAI SDK hang at the end of a stream from a proxy?**
Usually the stream never sends `data: [DONE]`, or a proxy buffers the event stream. The
`chat.stream.done` and `chat.stream.framing` checks show which one, with the raw (redacted) stream in the HTML report.

**Why do tool calls work with OpenAI but fail through my gateway?**
The common causes are `function.arguments` returned as an object instead of a JSON string, streamed
tool-call deltas without `index`, and 400 errors when history contains `tool_calls: null`. The `agent`
profile checks all three plus a full round-trip.

**Does it cost money? Is my API key safe?**
A full `agent` run is 13 requests with at most 16 output tokens each (64 for the tool checks), and
`--dry-run` shows the plan first. The key is read from an environment variable, sent only to the base
URL you give, never printed, and redacted (with any key-shaped string and custom header values) in
the table, JSON and HTML.

**Can I check vLLM, Ollama or LiteLLM locally without a key?**
Yes. For `localhost`/`127.0.0.1` the doctor runs without a key if the variable is empty (the bad-key
check will then warn, which is expected for a server without auth).

**Is a passing report a certification?**
No. It describes one run, one model, one moment. Some upstreams legitimately differ (for example,
OpenAI itself rejects `tool_calls: []`), which is why such checks are warnings.

## How it works

1. Checks live in `checks/*.json`. Each has an `id`, `profile`, `title`, `severity` (`fail`, `warn`,
   `info`), a `request` (or `uses` to reuse another check's response, which costs nothing), a list of
   `assertions`, an optional named `evaluator`, and a `fix_hint`.
2. The loader validates every check, including the cost guard: every POST must set a token cap, at
   most 16, or 64 when `"budget": "tool"`. The HTTP layer refuses anything above 64 as a second line of defence.
3. Requests run one at a time with a per-request timeout; response bodies are capped at 1 MB.
4. Results are redacted once, then rendered as table, JSON, HTML and badge.

Assertion vocabulary: `status`, `header`, `json`, `exists`, `absent`, `type`, `equals`, `one_of`,
`nonempty`, `json_string`, `matches`, `some`, `every`, `any_of`. Paths look like
`choices[0].message.tool_calls[0].function.arguments`. Strings may use `{{model}}` and `{{bad_model}}`.

Named evaluators (for things a flat assertion cannot express): `sse_openai`, `sse_anthropic`,
`sse_responses`, `sse_tool_call`, `tool_roundtrip`, `anthropic_tool_roundtrip`, `reasoning_dialect`.

A minimal community check:

```json
{
  "checks": [
    {
      "id": "community.stop_sequence",
      "profile": ["chat", "agent"],
      "title": "stop sequences are accepted",
      "severity": "warn",
      "request": {
        "method": "POST",
        "path": "/chat/completions",
        "body": { "model": "{{model}}", "messages": [{ "role": "user", "content": "Count: 1, 2, 3" }], "stop": ["3"], "max_tokens": 16 }
      },
      "assertions": [{ "type": "status", "in": [200] }, { "type": "json" }],
      "fix_hint": "Pass stop through to the upstream or drop it; do not reject the request."
    }
  ]
}
```

Run it with `--checks ./my-checks`.

## Limits (v0.1)

- One model per run, requests in sequence. No load or latency benchmarking.
- Responses API coverage is basic (non-stream, stream, error). No vision, prompt-cache, `json_schema` or
  body-size checks yet; those are planned for v0.2 together with a chunk-timing view.
- Results depend on the model: a reasoning model may spend all 16 tokens thinking, so the JSON-mode
  check can warn. Re-run with a non-reasoning model to separate gateway issues from model behaviour.
- No public leaderboard, by design. If you run a gateway, you can publish your own report.

## Contributing

New quirks are welcome as data: add a check to `checks/*.json` (or a new file), make the mock in
`test/mock-server.mjs` able to reproduce the quirk, and add a test that proves the check catches it.
See [CONTRIBUTING.md](CONTRIBUTING.md). Run `npm test` (no network, no keys needed).

## Bahasa Indonesia

`llm-gateway-doctor` mengecek apakah endpoint yang mengaku "OpenAI-compatible" atau
"Anthropic-compatible" benar-benar cocok dengan klien sungguhan: streaming SSE, `[DONE]`, usage,
tool call (arguments harus string JSON), riwayat dengan `tool_calls: null`, dan bentuk error.
Hasilnya berupa tabel di terminal, JSON, laporan HTML, dan badge SVG.

Cara pakai:

```bash
export OPENAI_API_KEY=sk-...   # key milik Anda sendiri; tidak pernah dicetak, disensor di laporan
npx llm-gateway-doctor --base-url https://endpoint-anda/v1 --model id-model --profile agent --html laporan.html
```

- Hemat: satu run `agent` = 13 request, `max_tokens` 16 (64 untuk tool call). Pakai `--dry-run` untuk melihat rencana dan estimasi token tanpa mengirim apa pun.
- Tidak ada base URL bawaan; isi `--base-url` atau pilih `--preset` (Anthropic, DeepSeek, Ezkielyna, Groq, LiteLLM, Ollama, OpenAI, OpenRouter, Together, vLLM).
- File laporan yang sudah ada tidak akan ditimpa kecuali memakai `--force`.
- Cek baru bisa ditambahkan sebagai file JSON di folder `checks/` tanpa mengubah kode.

Hasil lulus bukan sertifikasi: hanya potret satu model pada satu waktu.

## License

MIT © 2026 Ezekiel Lieberhart (Ezkielyna). Generated reports say "generated by llm-gateway-doctor (MIT)".

Built by the team behind [Ezkielyna](https://ezkielyna.store/?utm_source=github&utm_medium=readme&utm_campaign=llm-gateway-doctor),
an independent AI API gateway, from quirks we hit while connecting many upstreams.
