# Changelog

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
