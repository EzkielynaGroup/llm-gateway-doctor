# Changelog

## 0.1.0 (unreleased)

First release.

- Profiles `chat`, `agent`, `anthropic`, `responses` with 36 data-defined checks in `checks/*.json`.
- Assertion vocabulary (`status`, `header`, `json`, `type`, `equals`, `one_of`, `nonempty`, `json_string`,
  `matches`, `some`, `every`, `any_of`, ...) and named evaluators for SSE streams and tool round-trips.
- Cost guard: plan + token estimate before sending, `max_tokens` <= 16 (64 for tool checks) enforced by the
  loader and the HTTP layer, `--dry-run`, confirmation prompt on interactive terminals, per-request timeouts.
- Outputs: terminal table, `--json`, self-contained `--html` report with redacted request/response excerpts and
  fix hints, `--badge` SVG. Existing files are never overwritten without `--force`.
- Key from an environment variable only; redacted everywhere, including when a server echoes it back.
- Presets for Anthropic, DeepSeek, Ezkielyna, Groq, LiteLLM proxy, Ollama, OpenAI, OpenRouter, Together AI, vLLM.
- Local mock server with switchable quirks and tests for each quirk.
