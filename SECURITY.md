# Security policy

## Your API key

- `llm-gateway-doctor` reads the key only from an environment variable (`--key-env`), never from a flag.
- The key is sent only to the `--base-url` you pass, as `Authorization: Bearer` (OpenAI format) or
  `x-api-key` (Anthropic format). Nothing is sent anywhere else: no telemetry, no update checks.
- The key, auth headers, `--header` values, URL credentials and query strings, and any key-shaped string
  in a response are replaced with `[REDACTED]` in the table, JSON and HTML output.
- The bad-key check uses a fixed fake key, never a variation of yours.
- A warning is printed if you use plain `http://` with a non-local host.

Still, review an HTML or JSON report before you post it publicly: response bodies are excerpts of what
the server returned.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting
("Security" tab, "Report a vulnerability") on the repository. We aim to reply within 7 days.

## Supported versions

Only the latest released version receives fixes.
