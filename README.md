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
- **Works for subagents**: child agents share the main agent's request pipeline, rules apply automatically

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
- This release only fixes Dispatcher callbacks and response-stream pause/resume handling. Model rules, auth rules, and session commands are unchanged.

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

`auth` rules currently cover these `openai-codex` endpoints:

- `auth.openai.com/oauth/token`
- `auth.openai.com/api/accounts/deviceauth/usercode`
- `auth.openai.com/api/accounts/deviceauth/token`

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

Pi's provider-composer lets extensions override the streaming implementation for a provider on a **specific API type** via `pi.registerProvider(name, { api, streamSimple })`. This extension has two routing paths:

- `models` resolves rules by model id inside the `streamSimple` hook and injects the transport layer with undici fetch + a custom dispatcher.
- `auth` installs a process-wide wrapper around Pi's default dispatcher. It selects a provider dispatcher only for known OAuth endpoints and delegates all other requests to Pi's original pipeline.

- `http://` / `https://` → undici `ProxyAgent`
- `socks5h://` → built-in `SocksDispatcher` (implements the undici Dispatcher interface over `socks-proxy-agent`, forwarded to node http/https.request)

While `/allproxy` is active, the routing wrapper sends Pi's default HTTP(S) requests, including OAuth, and all model requests through the temporary proxy. It is not read from `settings.json` and is disabled when `/allproxy` is cancelled. Codex model requests are forced to SSE while proxied because the default WebSocket transport does not accept the injected fetch dispatcher.

```typescript
pi.registerProvider("openai-codex", {
  api: "openai-codex-responses",
  streamSimple: (model, context, options) => {
    const proxy = resolveProxyUrl(false, model.provider, model.id);
    // proxy matched → fetch with injected dispatcher; otherwise direct
  },
});
```

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

- Models **intercepted** by this extension use the explicit dispatcher (rules win, environment not consulted)
- While `/allproxy` is active, Pi's default HTTP(S) pipeline (including OAuth) uses the selected dispatcher
- Models **not intercepted** (see limits below) use the default pipeline — if proxy environment variables are set, they will go through the HTTP proxy

## Known limitations

- **One API type per provider**: an extension can only register a hook for one `api` per provider. Currently intercepted:
  - `opencode-go` / `openai` → `openai-responses` (gpt-* etc.)
  - `openai-codex` → `openai-codex-responses` (gpt-5.6-luna etc.)
  - NOT intercepted: `openai-completions` (opencode-go/deepseek-*, glm-*) and `anthropic-messages` (qwen, minimax) — those models use pi's default pipeline (direct, or via `HTTP_PROXY` if set)
- To cover these API types, register hooks for them as well (PRs welcome)
- `/allproxy` covers Pi's process HTTP(S) traffic only while it is active; it does not cover browser navigation, arbitrary child-process networking, unrelated native WebSocket clients, or the standalone `pi auth ...` command handled before extensions load.
- `auth` only covers built-in provider auth endpoint mappings; adding a provider requires adding its endpoint mapping, not an arbitrary URL wildcard.

## License

MIT
