# pi-proxy-router

[Pi](https://github.com/earendil-works/pi) coding agent 的按模型和认证流程路由代理扩展。为不同模型、会话内 OAuth 认证配置代理策略（SOCKS5 / HTTP），支持会话级临时开关，无需修改任何 provider 配置。

当前版本的[变更日志](CHANGELOG.md)记录了版本兼容性和升级说明。

## 特性

- **按模型规则路由**：`provider/模型模式` 匹配（`*` 通配），每个模型可独立指定代理或直连
- **按认证 provider 路由**：会话内 OAuth 登录、token exchange、refresh 和 device-code 请求按 provider 指定代理
- **多协议支持**：`socks5h://`、`http://`、`https://` 代理，或 `direct` 显式直连
- **独立配置文件**：优先读取 `~/.pi/agent/proxy-router.json` 或项目 `.pi/proxy-router.json`，修改后自动重载（mtime 检测）；旧 `settings.json` 配置仍兼容
- **启动开关**：`pi --noproxy` 禁用全部代理规则
- **会话内命令**：
  - `/allproxy <url>` — Pi 的 HTTP(S) 流量及全部模型强制走一个代理（临时，不写配置）
  - `/noproxy [on|off]` — 禁用/恢复规则
  - `/proxy [provider/model]` — 查看当前代理状态（含环境变量）
- **主/子 agent 通用**：子 agent 与主 agent 共享请求链路，规则自动生效

## 安装

```bash
# 全局安装（~/.pi/agent/extensions/）
mkdir -p ~/.pi/agent/extensions/pi-proxy-router
cd ~/.pi/agent/extensions/pi-proxy-router
# 将本项目文件复制到该目录（index.ts、socks-dispatcher.ts、package.json）
npm install
```

然后在 pi 中 `/reload`，或在下次启动时自动加载。启动日志中看到 `[proxy-router] loaded` 即成功。

> 项目级安装：放到 `.pi/extensions/pi-proxy-router/`（需先信任项目目录）。

或作为 pi 包安装：

```bash
pi install npm:pi-proxy-router
```

## 兼容性与升级

- `1.2.1` 兼容 Pi 0.85.x 使用的 Undici 8 Dispatcher，同时保留对 Undici 7 Dispatcher 的兼容。
- 如果 Pi 出现 `handler.onHeaders is not a function` 并退出，更新扩展后重启 Pi；不需要修改现有代理配置。
- 本次更新只修复 Dispatcher 回调和响应流的暂停/恢复处理，模型规则、认证规则和会话命令保持不变。

## 配置

推荐使用独立配置文件：全局 `~/.pi/agent/proxy-router.json`，或项目 `.pi/proxy-router.json`。项目配置在同名规则上覆盖全局配置；全局配置作为默认值。独立文件可以直接写 `models` / `auth`，也兼容外层包裹 `proxy-router`：

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

旧配置仍会从全局/项目 `settings.json` 的 `proxy-router` 节点读取，旧键名 `model-proxy` 也兼容；它们作为迁移期间的低优先级回退。规则来源优先级为：旧全局 `settings.json` → 旧项目 `settings.json` → 独立全局配置 → 独立项目配置。

### 规则语法

- **models key**：`provider/模型模式`，`*` 通配任意字符（如 `openai-codex/gpt*`、`opencode-go/*`）
- **auth key**：provider id（如 `openai-codex`），只匹配 Pi 已知的认证 endpoint
- **value**：
  - 代理 URL：`socks5h://`（推荐，远端 DNS 解析）、`socks5://`（自动归一化为 socks5h）、`http://`、`https://`
  - `direct`：显式直连
- `models` 按合并后的书写顺序**首个命中**生效；不在列表中的模型使用 Pi 默认链路
- `auth` 只对配置了 provider 的认证流程生效；未配置的认证请求使用 Pi 默认链路

### 优先级

```
--noproxy / /noproxy（禁用） > /allproxy（临时进程代理） > 独立配置规则 > 旧 settings 规则 > Pi 默认链路
```

### 会话内 OAuth 认证

`auth` 规则只覆盖扩展已经声明的 Pi 认证 endpoint。目前支持 `openai-codex` 的：

- `auth.openai.com/oauth/token`
- `auth.openai.com/api/accounts/deviceauth/usercode`
- `auth.openai.com/api/accounts/deviceauth/token`

会话内 `/login` 的 token exchange、refresh 和 device-code 请求会经过该规则。浏览器打开的授权页面不经过扩展；独立执行的 `pi auth ...` 也不会加载扩展，仍需使用 `HTTP_PROXY` / `HTTPS_PROXY` 等环境变量。

## 命令

| 命令 | 说明 |
|---|---|
| `/proxy` | 查看当前状态：flag、开关、allproxy、环境变量、模型规则和认证规则 |
| `/proxy openai-codex/gpt-5.6-luna` | 附带参数时额外显示该模型的实际解析结果 |
| `/allproxy http://127.0.0.1:7890` | Pi 的 HTTP(S) 流量、OAuth 刷新及全部模型强制走该代理（会话级临时，不写配置） |
| `/allproxy` | 取消临时代理，恢复规则 |
| `/noproxy` | 切换禁用/恢复（不带参数时 toggle） |
| `/noproxy on` / `/noproxy off` | 显式设置 |
| `pi --noproxy` | 启动时禁用全部代理规则 |

## 架构与原理

pi 的 provider-composer 允许扩展通过 `pi.registerProvider(name, { api, streamSimple })` 覆盖指定 provider 在**指定 API 类型**上的流式实现。本扩展分两条链路路由：

- `models` 在 `streamSimple` 钩子中按模型 id 解析规则，命中时用 undici fetch + 自定义 dispatcher 注入传输层。
- `auth` 在 Pi 进程内安装一个保留默认 dispatcher 的路由包装器，只对已知 OAuth endpoint 选择认证 provider 的 dispatcher，其他请求继续交给 Pi 默认链路。

- `http://` / `https://` → undici `ProxyAgent`
- `socks5h://` → 内置 `SocksDispatcher`（基于 `socks-proxy-agent` 实现 undici Dispatcher 接口，转发为 node http/https.request）

启用 `/allproxy` 后，路由包装器会把 Pi 默认 HTTP(S) 请求（包括 OAuth）和全部模型请求交给临时代理。该设置不写入 `settings.json`，取消 `/allproxy` 后恢复。Codex 模型启用代理时会固定使用 SSE，因为默认 WebSocket 链路不能使用注入的 fetch dispatcher。

```typescript
pi.registerProvider("openai-codex", {
  api: "openai-codex-responses",
  streamSimple: (model, context, options) => {
    const proxy = resolveProxyUrl(false, model.provider, model.id);
    // proxy 命中 → 用注入 dispatcher 的 fetch；否则直连
  },
});
```

### URL 匹配（待实现）

暂不支持把任意 URL 或域名写成规则，例如：

```json
"urls": {
  "*.abc.com": "socks5h://127.0.0.1:7890"
}
```

该能力需要单独定义 URL、域名、端口、路径、重定向和规则优先级，且容易扩大代理范围。后续如确有需要，将作为显式的 `urls` 节点评估，不与 `models`、`auth` 规则混用。

### 环境变量

pi 启动时全局安装 `EnvHttpProxyAgent`（undici），所有 fetch 默认读取 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量。因此：

- 被扩展接管的模型走显式 dispatcher（规则优先，不受环境变量影响）
- 执行 `/allproxy` 后，Pi 的默认 HTTP(S) 链路（包括 OAuth）也走选定的 dispatcher
- **不被接管的模型**（见下方限制）走默认链路——设置了代理环境变量时它们会走 HTTP 代理

## 已知限制

- **API 类型接管限制**：一个 provider 只能注册一种 `api` 的钩子。目前接管：
  - `opencode-go` / `openai` → `openai-responses`（gpt-* 等）
  - `openai-codex` → `openai-codex-responses`（gpt-5.6-luna 等）
  - 不接管 `openai-completions`（opencode-go/deepseek-*、glm-*）与 `anthropic-messages`（qwen、minimax）—— 这些模型走 pi 默认链路（直连，或随 `HTTP_PROXY` 环境变量走代理）
- 若要覆盖这些 api，需要再扩展对应 api 的注册（欢迎 PR）
- `/allproxy` 只在启用期间覆盖 Pi 进程内的 HTTP(S) 流量，不包括浏览器导航、任意子进程自己的网络请求、无关的原生 WebSocket 客户端，以及扩展加载前处理的独立 `pi auth ...` 命令。
- `auth` 只覆盖扩展内置的 provider 认证 endpoint；新增 provider 需要补充 endpoint 映射，不接受任意 URL 通配。

## License

MIT
