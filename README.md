# pi-proxy-router

[中文说明 (Chinese README)](README.zh-CN.md)

Per-model proxy routing extension for the [Pi](https://github.com/earendil-works/pi) coding agent. Route each model through its own proxy (SOCKS5 / HTTP) with per-session toggles — no provider config changes required.

## Features

- **Per-model rules**: match `provider/model` patterns (`*` wildcard), each model gets its own proxy or direct connection
- **Multiple protocols**: `socks5h://`, `http://`, `https://` proxies, or `direct` to force a direct connection
- **Hot-reload config**: rules are read from the `proxy-router` key in `settings.json` (legacy `model-proxy` key still supported); editing the file reloads them automatically (mtime-based)
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

## Configuration

Add a `proxy-router` key to `settings.json` (global `~/.pi/agent/settings.json` or project `.pi/settings.json`; project overrides global). The old `model-proxy` key name is still read as a fallback:

```json
{
  "proxy-router": {
    "openai-codex/*":       "socks5h://127.0.0.1:7890",
    "openai/*":             "socks5h://127.0.0.1:7890",
    "opencode-go/gpt*":     "socks5h://proxy.example.test:7890",
    "opencode-go/deepseek*": "direct",
    "opencode-go/glm*":     "direct"
  }
}
```

### Rule syntax

- **key**: `provider/model-pattern`, `*` matches any characters (e.g. `openai-codex/gpt*`, `opencode-go/*`)
- **value**:
  - Proxy URL: `socks5h://` (recommended, remote DNS resolution), `socks5://` (normalized to socks5h), `http://`, `https://`
  - `direct`: explicitly bypass the proxy
- First matching rule in declaration order wins; models not listed go direct by default

### Priority

```
--noproxy / /noproxy (disable) > /allproxy (temporary process proxy) > model settings rules > direct (default)
```

## Commands

| Command | Description |
|---|---|
| `/proxy` | Show current status: flags, toggles, allproxy, environment variables, rule list |
| `/proxy openai-codex/gpt-5.6-luna` | With an argument, also shows the resolved route for that model |
| `/allproxy http://127.0.0.1:7890` | Force Pi HTTP(S) traffic, OAuth refresh, and all models through this proxy (session-only, not persisted) |
| `/allproxy` | Cancel the temporary proxy, fall back to rules |
| `/noproxy` | Toggle disable/restore (toggles when no argument) |
| `/noproxy on` / `/noproxy off` | Explicitly set |
| `pi --noproxy` | Disable all proxy rules at startup |

## How it works

Pi's provider-composer lets extensions override the streaming implementation for a provider on a **specific API type** via `pi.registerProvider(name, { api, streamSimple })`. This extension resolves proxy rules by model id inside the `streamSimple` hook and injects the transport layer with undici fetch + a custom dispatcher:

- `http://` / `https://` → undici `ProxyAgent`
- `socks5h://` → built-in `SocksDispatcher` (implements the undici Dispatcher interface over `socks-proxy-agent`, forwarded to node http/https.request)

While `/allproxy` is active, the extension also installs the selected dispatcher with Undici's `setGlobalDispatcher()`. This temporary mode covers Pi's default HTTP(S) requests, including OAuth refresh, and all model requests. It is not read from `settings.json` and is restored when `/allproxy` is cancelled. Codex model requests are forced to SSE while proxied because the default WebSocket transport does not accept the injected fetch dispatcher.

```typescript
pi.registerProvider("openai-codex", {
  api: "openai-codex-responses",
  streamSimple: (model, context, options) => {
    const proxy = resolveProxy(model.provider, model.id);
    // proxy matched → fetch with injected dispatcher; otherwise direct
  },
});
```

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

## License

MIT
