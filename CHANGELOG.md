# Changelog

## 1.2.3 - 2026-09-23

### Fixed

- Prevent process-wide endpoint fallback from applying a proxy rule to models sharing a `baseUrl` when their model-level routing decisions differ.

## 1.2.2 - 2026-09-10

### Fixed

- Route all model API types through the current model registry instead of only `openai-responses` and `openai-codex-responses`.
- Keep model proxy rules effective for foreground subagents through process-wide endpoint routing, including Codex WebSocket-to-SSE fallback.
- Add built-in OAuth endpoint mappings for Anthropic, GitHub Copilot, Kimi Coding, OpenRouter, and xAI.
- Fail instead of silently connecting directly when a configured proxy URL uses an unsupported protocol.

## 1.2.1 - 2026-09-07

### Fixed

- Support both the legacy Undici 7 Dispatcher handler callbacks and the Undici 8 callbacks used by Pi 0.85.x.
- Prevent `handler.onHeaders is not a function` from escaping a Node response event and terminating Pi.
- Bridge response-stream pause/resume and raw response headers for the Undici 8 handler.

### Verification

- TypeScript check passed for `socks-dispatcher.ts`.
- Local SOCKS5 integration passed for Undici 7 and 8, including GET and POST requests.

## 1.2.0 - 2026-08-27

- Route in-session auth requests by provider.
- Add dedicated `proxy-router.json` configuration with legacy `settings.json` fallback.
