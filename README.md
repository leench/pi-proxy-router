# pi-proxy-router

[中文说明 (Chinese README)](README.zh-CN.md)

Per-model and auth-flow proxy routing extension for the [Pi](https://github.com/earendil-works/pi) coding agent. Route each model and in-session OAuth flow through its own proxy (SOCKS5 / HTTP) with per-session toggles — no provider config changes required.

See [CHANGELOG.md](CHANGELOG.md) for release compatibility and upgrade notes.

## Features

- **Per-model rules**: match `provider/model` patterns (`*` wildcard), each model gets its own proxy or direct connection
- **Per-provider auth rules**: route in-session OAuth login, token exchange, refresh, and device-code requests by provider
- **Multiple protocols**: `socks5h://`, `http://`, `https://` proxies, or `direct` to force a direct connection
- **Dedicated config**: rules are read first from `~/.pi/agent/proxy-router.json` or project `.pi/proxy-router.json`, with automatic mtime-based reload; legacy `settings.json` rules remain supported
- **Startup flag**: `pi --noproxy` disables all proxy rules
- **Session commands**:
  - `/allproxy <url>` — force Pi HTTP(S) traffic and all models through one proxy (session-only, nothing persisted)
  - `/noproxy [on|off]` — disable/restore rules
  - `/proxy [provider/model]` — show current proxy status (including environment variables)
- **Works for subagents**: background children may load this extension; foreground children still inherit the parent process's endpoint fallback even when ambient extensions are disabled

## Install

```bash
# Global install (~/.pi/agent/extensions/)
mkdir -p ~/.pi/agent/extensions/pi-proxy-router
cd ~/.pi/agent/extensions/pi-proxy-router
# copy this package's files (index.ts, socks-dispatcher.ts, package.json) here
npm install
```

Then run `/reload` in pi, or restart — you should see `[proxy-router] loaded` in the startup log.

> Project-local install: put it in `.pi/extensions/pi-proxy-router/` (requires trusting the project first).

Or install as a pi package:

```bash
pi install npm:pi-proxy-router
```

## Compatibility and upgrade

- `1.2.1` supports the Undici 8 Dispatcher used by Pi 0.85.x while retaining compatibility with the Undici 7 Dispatcher.
- If Pi exits with `handler.onHeaders is not a function`, update the extension and restart Pi; existing proxy configuration does not need to change.
- The unreleased routing changes also cover all model API types and foreground subagents; see `CHANGELOG.md` for details.

## Configuration

Use a dedicated config file: global `~/.pi/agent/proxy-router.json`, or project `.pi/proxy-router.json`. Project rules override the same keys from the global file; global rules provide defaults. A dedicated file may use `models` / `auth` at the root, and the wrapped `proxy-router` form is also accepted:

```json
{
  "models": {
    "openai-codex/*":        "socks5h://127.0.0.1:7890",
    "openai/*":              "socks5h://127.0.0.1:7890",
    "opencode-go/gpt*":      "socks5h://proxy.example.test:7890",
    "opencode-go/deepseek*": "direct",
    "opencode-go/glm*":      "direct"
  },
  "auth": {
    "openai-codex": "socks5h://127.0.0.1:7890"
  }
}
```

For migration, legacy global/project `settings.json` entries under `proxy-router` are still read, and the old `model-proxy` key is also supported. They are lower-priority fallbacks in this order: legacy global `settings.json` → legacy project `settings.json` → dedicated global config → dedicated project config.

### Rule syntax

- **models key**: `provider/model-pattern`, `*` matches any characters (e.g. `openai-codex/gpt*`, `opencode-go/*`)
- **auth key**: provider id (e.g. `openai-codex`), matched only against Pi's known auth endpoints
- **value**:
  - Proxy URL: `socks5h://` (recommended, remote DNS resolution), `socks5://` (normalized to socks5h), `http://`, `https://`
  - `direct`: explicitly bypass the proxy
- First matching `models` rule in merged declaration order wins; models not listed use Pi's default pipeline
- An `auth` rule applies only to that provider's supported auth flow; unconfigured auth uses Pi's default pipeline

### Priority

```
--noproxy / /noproxy (disable) > /allproxy (temporary process proxy) > dedicated config rule > legacy settings rule > Pi's default pipeline
```

### In-session OAuth authentication

`auth` rules currently cover these built-in endpoints:

- `openai-codex`: `auth.openai.com/oauth/token`, `auth.openai.com/api/accounts/deviceauth/usercode`, `auth.openai.com/api/accounts/deviceauth/token`
- `anthropic`: `platform.claude.com/v1/oauth/token`
- `github-copilot`: GitHub device/OAuth endpoints and `api.github.com` / `api.individual.githubcopilot.com` Copilot token endpoints
- `kimi-coding`: `auth.kimi.com/api/oauth/device_authorization`, `auth.kimi.com/api/oauth/token`
- `openrouter`: `openrouter.ai/api/v1/auth/keys`
- `xai`: `auth.x.ai/oauth2/device/code`, `auth.x.ai/oauth2/token`

Token exchange, refresh, and device-code requests from an in-session `/login` flow use the provider rule. Browser authorization pages are outside the extension, and the standalone `pi auth ...` command does not load extensions; use `HTTP_PROXY` / `HTTPS_PROXY` for that process.

## Commands

| Command | Description |
|---|---|
| `/proxy` | Show current status: flags, toggles, allproxy, environment variables, model and auth rules |
| `/proxy openai-codex/gpt-5.6-luna` | With an argument, also shows the resolved route for that model |
| `/allproxy http://127.0.0.1:7890` | Force Pi HTTP(S) traffic, OAuth refresh, and all models through this proxy (session-only, not persisted) |
| `/allproxy` | Cancel the temporary proxy, fall back to rules |
| `/noproxy` | Toggle disable/restore (toggles when no argument) |
| `/noproxy on` / `/noproxy off` | Explicitly set |
| `pi --noproxy` | Disable all proxy rules at startup |

## How it works

This extension has three routing layers:

- `models` wraps `stream` / `streamSimple` in the current session's model registry, resolves rules by model id for every API type, and injects undici fetch with a custom dispatcher.
- The process-wide dispatcher also routes known model endpoints by their `baseUrl`, covering foreground children and HTTP APIs that bypass the provider wrapper.
- `auth` installs a process-wide wrapper around Pi's default dispatcher. It selects a provider dispatcher only for known OAuth endpoints and delegates all other requests to Pi's original pipeline.

- `http://` / `https://` → undici `ProxyAgent`
- `socks5h://` → built-in `SocksDispatcher` (implements the undici Dispatcher interface over `socks-proxy-agent`, forwarded to node http/https.request)

While `/allproxy` is active, the routing wrapper sends Pi's default HTTP(S) requests, including OAuth, and all model requests through the temporary proxy. It is not read from `settings.json` and is disabled when `/allproxy` is cancelled. Routed model requests use an explicit dispatcher instead of environment proxies. Codex requests are forced to SSE when proxied because the default WebSocket transport does not accept the injected fetch dispatcher; foreground children use the endpoint fallback and are forced from a routed WebSocket to SSE as well.

### URL matching (planned)

Arbitrary URL or hostname rules such as the following are intentionally not supported yet:

```json
"urls": {
  "*.abc.com": "socks5h://127.0.0.1:7890"
}
```

If needed later, this will be evaluated as an explicit `urls` section with separate semantics for host, port, path, redirects, and precedence. It will remain separate from `models` and `auth` rather than becoming a general-purpose GFWList.

### Environment variables

Pi installs an `EnvHttpProxyAgent` globally at startup, so all fetch calls read `HTTP_PROXY` / `HTTPS_PROXY`. This means:

- Models matching a rule use the explicit dispatcher (rules win, environment not consulted)
- Known model endpoints used by foreground children use the same rules
- While `/allproxy` is active, Pi's default HTTP(S) pipeline (including OAuth) uses the selected dispatcher
- Models without a matching rule still use Pi's default pipeline; if proxy environment variables are set, they will go through the HTTP proxy

## Known limitations

- The endpoint fallback relies on `baseUrl` from the current model registry. Since a URL cannot identify the model for a request, the extension installs a fallback only when all known models sharing that endpoint resolve to the same routing decision. If a model is unrouted or has a different route, it logs a debug message and skips that endpoint fallback. The current session's provider wrapper still applies rules by model ID; requests without that wrapper use Pi's default pipeline. To proxy foreground subagent requests by model, use a consistent rule for models sharing an endpoint or configure separate endpoints.
- `/allproxy` covers Pi's process HTTP(S) traffic only while it is active; it does not cover browser navigation, arbitrary child-process networking, unrelated native WebSocket clients, or the standalone `pi auth ...` command handled before extensions load.
- `auth` only covers built-in provider auth endpoint mappings; adding a provider requires adding its endpoint mapping, not an arbitrary URL wildcard.

## License

MIT
