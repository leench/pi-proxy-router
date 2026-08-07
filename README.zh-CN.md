# pi-proxy-router

[Pi](https://github.com/earendil-works/pi) coding agent 的按模型路由代理扩展。为不同模型配置不同的代理策略（SOCKS5 / HTTP），支持会话级临时开关，无需修改任何 provider 配置。

## 特性

- **按模型规则路由**：`provider/模型模式` 匹配（`*` 通配），每个模型可独立指定代理或直连
- **多协议支持**：`socks5h://`、`http://`、`https://` 代理，或 `direct` 显式直连
- **配置即改即生效**：读取 `settings.json` 的 `proxy-router` 节点（旧键名 `model-proxy` 仍兼容），修改文件后自动重载（mtime 检测）
- **启动开关**：`pi --noproxy` 禁用全部代理规则
- **会话内命令**：
  - `/allproxy <url>` — 全局强制代理（临时，不写配置）
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
# 或通过 git
pi install git:github.com/leench/pi-proxy-router
```

## 配置

在 `settings.json`（全局 `~/.pi/agent/settings.json` 或项目 `.pi/settings.json`，项目覆盖全局）中添加 `proxy-router` 节点（旧键名 `model-proxy` 仍会被兼容读取）：

```json
{
  "proxy-router": {
    "openai-codex/*":       "socks5h://127.0.0.1:7890",
    "openai/*":             "socks5h://127.0.0.1:7890",
    "opencode-go/gpt*":     "socks5h://192.168.1.100:7890",
    "opencode-go/deepseek*": "direct",
    "opencode-go/glm*":     "direct"
  }
}
```

### 规则语法

- **key**：`provider/模型模式`，`*` 通配任意字符（如 `openai-codex/gpt*`、`opencode-go/*`）
- **value**：
  - 代理 URL：`socks5h://`（推荐，远端 DNS 解析）、`socks5://`（自动归一化为 socks5h）、`http://`、`https://`
  - `direct`：显式直连
- 按书写顺序**首个命中**生效；不在列表中的模型默认直连

### 优先级

```
--noproxy / /noproxy（禁用） > /allproxy（全局代理） > settings 规则 > 默认直连
```

## 命令

| 命令 | 说明 |
|---|---|
| `/proxy` | 查看当前状态：flag、开关、allproxy、环境变量、规则列表 |
| `/proxy openai-codex/gpt-5.6-luna` | 附带参数时额外显示该模型的实际解析结果 |
| `/allproxy http://127.0.0.1:7890` | 全部模型强制走该代理（会话级临时，不写配置） |
| `/allproxy` | 取消全局代理，恢复规则 |
| `/noproxy` | 切换禁用/恢复（不带参数时 toggle） |
| `/noproxy on` / `/noproxy off` | 显式设置 |
| `pi --noproxy` | 启动时禁用全部代理规则 |

## 架构与原理

pi 的 provider-composer 允许扩展通过 `pi.registerProvider(name, { api, streamSimple })` 覆盖指定 provider 在**指定 API 类型**上的流式实现。本扩展在 `streamSimple` 钩子中按模型 id 解析代理规则，命中时用 undici fetch + 自定义 dispatcher 注入传输层：

- `http://` / `https://` → undici `ProxyAgent`
- `socks5h://` → 内置 `SocksDispatcher`（基于 `socks-proxy-agent` 实现 undici Dispatcher 接口，转发为 node http/https.request）

```typescript
pi.registerProvider("openai-codex", {
  api: "openai-codex-responses",
  streamSimple: (model, context, options) => {
    const proxy = resolveProxy(model.provider, model.id);
    // proxy 命中 → 用注入 dispatcher 的 fetch；否则直连
  },
});
```

### 环境变量

pi 启动时全局安装 `EnvHttpProxyAgent`（undici），所有 fetch 默认读取 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量。因此：

- 被扩展接管的模型走显式 dispatcher（规则优先，不受环境变量影响）
- **不被接管的模型**（见下方限制）走默认链路 —— 设置了代理环境变量时它们也会走 HTTP 代理

## 已知限制

- **API 类型接管限制**：一个 provider 只能注册一种 `api` 的钩子。目前接管：
  - `opencode-go` / `openai` → `openai-responses`（gpt-* 等）
  - `openai-codex` → `openai-codex-responses`（gpt-5.6-luna 等）
  - 不接管 `openai-completions`（opencode-go/deepseek-*、glm-*）与 `anthropic-messages`（qwen、minimax）—— 这些模型走 pi 默认链路（直连，或随 `HTTP_PROXY` 环境变量走代理）
- 若要覆盖这些 api，需要再扩展对应 api 的注册（欢迎 PR）

## License

MIT
