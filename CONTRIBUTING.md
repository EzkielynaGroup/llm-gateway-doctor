# Contributing

Thanks for helping. The most useful contribution is a new **quirk check**: a behaviour you met in a real
endpoint that breaks a real client.

## Add a check (no code needed)

1. Add an entry to the right file in `checks/` (`chat.json`, `agent.json`, `anthropic.json`,
   `responses.json`) or create a new `checks/<topic>.json` with `{"checks": [...]}`.
2. Required fields: `id` (lowercase, dotted), `profile` (array), `title`, `severity` (`fail` only when
   common clients break; otherwise `warn`; `info` for observations), `request` or `uses`,
   `assertions` and/or `evaluator`, and a concrete `fix_hint` that tells an operator what to change.
3. Every POST body must set `max_tokens`, `max_completion_tokens` or `max_output_tokens` at 16 or less
   (64 with `"budget": "tool"`). The loader rejects anything else.
4. Prefer `"uses": "<other check id>"` when you can assert on a response another check already fetched.
   It costs the user nothing.

## Prove it with the mock

1. Teach `test/mock-server.mjs` the quirk behind a new flag in `QUIRKS`.
2. Add a test in `test/doctor.test.mjs` showing the clean mock passes and the quirky mock fails your check.
3. `npm test` must pass on Node 18, 20 and 22. Tests never use the network or a real key.

## Ground rules

- Keep zero runtime dependencies.
- No public rankings of other people's endpoints in this repo. Reports are for operators and users to
  share about endpoints they use.
- Fix hints are neutral and factual: describe the wire format, not a vendor.
- Fake keys in tests are built from parts (`'sk-' + 'test-...'`) so secret scanners stay quiet.

## Commit style

Small focused commits, imperative subject (`add check for stop sequences`). Update `CHANGELOG.md`.
