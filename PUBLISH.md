# Publishing llm-gateway-doctor (owner steps)

Nothing below has been done. The repo exists only locally.

## GitHub

- **Description (≤ 120 chars):** Conformance checks for OpenAI- and Anthropic-compatible LLM endpoints: streaming, tool calls, errors. HTML + badge.
- **Homepage:** https://www.npmjs.com/package/llm-gateway-doctor
- **Topics (12):** `openai-compatible`, `anthropic`, `llm`, `llm-gateway`, `api-testing`, `conformance-testing`, `server-sent-events`, `tool-calling`, `function-calling`, `cli`, `vllm`, `ollama`

## Steps

```bash
cd llm-gateway-doctor
npm test                                   # 48 tests, no network
bash <leak-scan script> .                  # must print CLEAN
gh repo create EzkielynaGroup/llm-gateway-doctor --public \
  --description "Conformance checks for OpenAI- and Anthropic-compatible LLM endpoints: streaming, tool calls, errors. HTML + badge." \
  --homepage "https://www.npmjs.com/package/llm-gateway-doctor" --source . --remote origin
gh repo edit EzkielynaGroup/llm-gateway-doctor --add-topic openai-compatible,anthropic,llm,llm-gateway,api-testing,conformance-testing,server-sent-events,tool-calling,function-calling,cli,vllm,ollama
git push -u origin main
# wait for the test workflow (Node 18/20/22) to go green, then:
git tag v0.1.0 && git push origin v0.1.0
npm publish --provenance --access public   # provenance needs a GitHub Actions publish job; from a laptop drop --provenance
```

Optional after release: enable private vulnerability reporting (Settings, Security), and ask to be listed on
LiteLLM's "Projects" page and relevant awesome lists, following each list's own contribution rules.

Open check before publishing: the npm name `llm-gateway-doctor` was not checked for availability (no network
calls to npm were made while building). Run `npm view llm-gateway-doctor` first.

## Show HN draft

**Title (≤ 80):** Show HN: llm-gateway-doctor – check if an "OpenAI-compatible" API really is

**First comment:**

Hi HN. Many LLM servers and gateways say they are OpenAI- or Anthropic-compatible. In practice the
differences show up later, inside a client: the SDK hangs because the stream never sends `data: [DONE]`,
an agent crashes because tool-call `arguments` arrive as an object instead of a JSON string, streamed
tool-call deltas have no `index`, or a replayed history with `tool_calls: null` gets a 400.

llm-gateway-doctor is a small CLI that checks these things against any endpoint with your own key:

    npx llm-gateway-doctor --base-url http://localhost:8000/v1 --model my-model --profile agent --html report.html

It has four profiles (chat completions, agent = tools + streaming, Anthropic Messages, Responses basic),
36 checks stored as JSON so new quirks can be added without code, and it outputs a table, JSON, a
self-contained HTML report (with redacted request/response excerpts and a fix hint per failure) and an
SVG badge. A full agent run is 13 requests with max_tokens 16 (64 for tool calls), and `--dry-run`
shows the plan first. Zero dependencies, MIT.

I work on Ezkielyna, a small API gateway; the checks come from quirks we hit while connecting upstreams.
The tool is neutral: no default endpoint, no leaderboard. I would like to hear which quirks you have met
that are not covered yet.

## dev.to article draft

**Title:** Your LLM endpoint says "OpenAI-compatible". Here is how to check.

**Tags:** `llm`, `openai`, `api`, `testing`

*Disclosure: I work on Ezkielyna, an independent AI API gateway. The tool in this post is MIT-licensed,
works with any provider, and has no default endpoint.*

"OpenAI-compatible" has become the default promise of every model server, router and gateway. vLLM,
Ollama, LiteLLM, hosted APIs and home-grown proxies all accept `POST /v1/chat/completions`. The first
request usually works. The trouble starts when a real client, an agent framework or an IDE plugin
leans on the parts of the format that nobody tested.

Running a gateway, we connected a lot of upstreams and kept a list of the ways "compatible" broke our
users' tools. The same handful of problems came back again and again:

- **The stream never ends.** The server sends the content but no final `data: [DONE]`. The OpenAI SDK
  and many hand-written loops wait for that line and hang until the socket times out.
- **Tool-call arguments as an object.** The spec says `function.arguments` is a JSON-encoded *string*.
  Upstreams with a native tool format return an object, and a gateway that forgets to `JSON.stringify`
  it breaks every client that calls `JSON.parse(arguments)`.
- **Streamed tool calls without `index`.** Clients merge argument fragments by `index`. Without it they
  either crash or glue two calls together.
- **History replay.** Several frameworks send earlier assistant turns with `"tool_calls": null` or `[]`.
  Some servers answer with a 400, so the second turn of a conversation fails while the first works.
- **No usage in streams.** With `stream_options.include_usage` the client expects one last chunk with
  token counts. Without it, cost tracking silently shows zero.
- **Errors as HTML.** An unknown model or bad key should give a 4xx with a JSON error message. A proxy
  or CDN page in HTML cannot be parsed, and a 5xx makes clients retry forever.
- **Reasoning in three dialects.** `reasoning_content`, `reasoning`, `reasoning_details`, or raw
  `<think>` tags inside `content`. None is wrong as such, but clients need to know which one they get.

None of these show up in a "hello world" curl. So we turned the list into a tool.

### llm-gateway-doctor

```bash
export OPENAI_API_KEY=sk-...
npx llm-gateway-doctor --base-url https://your-endpoint.example/v1 --model your-model --profile agent
```

It reads the key from an environment variable, prints a plan, and then runs small checks. Four profiles
cover the common wire formats:

- `chat`: `/v1/models`, a non-stream completion, SSE framing, `[DONE]`, `finish_reason`, stream usage,
  `max_completion_tokens`, JSON mode, error shapes, reasoning dialect.
- `agent`: everything in `chat`, plus a forced tool call, a streamed tool call, a full round-trip
  (the tool result goes back to the model) and the two replay cases.
- `anthropic`: `/v1/messages` with `x-api-key` and `anthropic-version`, named SSE events in the right
  order, `stop_reason`, usage split between `message_start` and `message_delta`, `tool_use` round-trip,
  system prompt as an array of blocks with `cache_control`.
- `responses`: basic `/v1/responses`, its typed event stream and error shape.

Here is a real run against the mock server that ships with the tests, with three quirks switched on
(no `[DONE]`, arguments as objects, rejecting `tool_calls: null`). Passing rows are trimmed:

```text
Plan: 20 checks, 13 requests to http://127.0.0.1:18787/v1 (profile agent, model mock-model)
      about 736 input tokens and at most 336 output tokens in total; key from $OPENAI_API_KEY

 PASS  chat.stream.framing               Stream is SSE: text/event-stream, data: lines, JSON chunks
 FAIL  chat.stream.done                  Stream ends with data: [DONE]
                                         - stream ended without "data: [DONE]"
 FAIL  agent.tools.call                  Forced tool call returns tool_calls with JSON-string arguments
                                         - choices[0].message.tool_calls[0].function.arguments is object, expected a JSON-encoded string
 FAIL  agent.tools.roundtrip             Tool result can be sent back (assistant tool_calls + role=tool)
                                         - step 1: function.arguments is not a JSON string (re-encoding it for step 2)
 FAIL  agent.tools.stream                Streamed tool call: every delta has index, arguments are string fragments
                                         - 1 delta(s) stream function.arguments as an object instead of a string fragment
 WARN  agent.replay.tool_calls_null      History with assistant tool_calls: null is accepted
                                         - HTTP status 400, expected 200
 WARN  agent.replay.tool_calls_empty     History with assistant tool_calls: [] is accepted
                                         - HTTP status 400, expected 200

compat 13/19 · chat+usage+json   (13 pass, 4 fail, 2 warn, 1 info, 0 skip)
```

Each failure in the table also prints a `fix:` line written for the operator, for example: "function.arguments
must be a JSON-encoded string, not an object. Upstreams with a native tool format return objects; the
gateway must JSON.stringify them."

`--html report.html` writes a single self-contained page (no external assets, dark mode included) with
the redacted request and response for every failed check. That is the thing to attach to a GitHub
issue. `--badge badge.svg` writes a small badge such as `compat 19/19 · chat+stream+usage+tools+json`
for a README. `--json` is there for CI.

### Cheap on purpose

Every test request costs real tokens on someone's account, so the doctor is strict about it:

- `max_tokens` is 16 for every request, 64 for the tool-call checks. The check loader rejects anything
  higher, and the HTTP layer refuses it a second time.
- Checks that only need to look at an existing response reuse it (`"uses": "chat.basic"`) instead of
  sending a new request. The full agent profile is 13 requests for 20 checks.
- Before anything is sent it prints the request count and a token estimate. `--dry-run` stops there.
  On an interactive terminal it asks for confirmation; `--yes` skips that, and CI never prompts.
- Requests run one at a time, with a per-request timeout (`--timeout-ms`) and a 1 MB response cap.

The key is never printed. It is redacted from the table, the JSON and the HTML, together with custom
header values and anything key-shaped, even if the server echoes it back in an error message. There is a
test for exactly that case.

### Checks are data

The checks are JSON files. A check has an id, profile, severity, request, a list of assertions from a
small vocabulary (`status`, `json`, `type`, `equals`, `json_string`, `some`, `any_of` and a few more) and a
`fix_hint`. Stream parsing and multi-step tool round-trips use named evaluators. To add a quirk you met,
write a JSON check, teach the mock server to reproduce the quirk, and add a test that shows the check
catches it. `--checks ./my-checks` loads your own folder without a fork.

### What it is not

It is not a benchmark and not a leaderboard. A report is one model on one endpoint at one moment, and some
differences are legitimate (OpenAI itself rejects `tool_calls: []`, which is why that check is a warning).
It does not try to guess which model is "really" behind an endpoint.

v0.2 will add a chunk-timing view of streams, a prompt-cache check, `json_schema` and vision inputs.
If you run vLLM, Ollama, LiteLLM or your own proxy, I would like to see your report, and to hear which quirks
are missing.

Repo: https://github.com/EzkielynaGroup/llm-gateway-doctor (MIT, zero dependencies, Node 18+).
