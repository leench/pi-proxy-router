import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import {
  Agent,
  fetch as undiciFetch,
  getGlobalDispatcher,
  ProxyAgent,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SocksDispatcher } from "./socks-dispatcher.ts";

// 日志开关：默认静默（console 输出会污染 pi 的 TUI 输入框）。
// 需要调试时设置环境变量 PI_MODEL_PROXY_DEBUG=1。
const DEBUG = process.env.PI_MODEL_PROXY_DEBUG === "1";
const log = (...args: unknown[]) => {
  if (DEBUG) console.log("[proxy-router]", ...args);
};
const logError = (...args: unknown[]) => {
  if (DEBUG) console.error("[proxy-router]", ...args);
};

function displayProxyUrl(proxyUrl: string | null): string {
  if (proxyUrl === null) return "direct";
  try {
    const url = new URL(proxyUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "[invalid proxy URL]";
  }
}

function displayEnvValue(name: string, value: string): string {
  if (!value) return "(not set)";
  if (name === "NO_PROXY") return "(set)";
  return displayProxyUrl(value);
}

/**
 * pi-proxy-router：按模型路由代理。
 *
 * 配置在独立的 proxy-router.json（全局 ~/.pi/agent/proxy-router.json 与项目
 * .pi/proxy-router.json，项目覆盖全局）；settings.json 中的旧配置仍兼容：
 *
 *   "proxy-router": {
 *     "models": {
 *       "openai-codex/*":  "socks5h://localhost:7890",
 *       "opencode-go/gpt*": "socks5h://proxy.example.test:7890"
 *     },
 *     "auth": {
 *       "openai-codex": "socks5h://localhost:7890"
 *     }
 *   }
 *
 * - models 的 key 为 "provider/模型模式"，* 通配（provider 用实际 id，如 opencode-go）
 * - auth 按 provider 配置会话内 OAuth 登录、token exchange 和 refresh 的代理
 * - value 为代理 URL（http://、https://、socks5h://）或 "direct"（直连）
 * - 优先级：--noproxy / /noproxy（禁用）> /allproxy（全局代理，临时）
 *   > 独立配置规则 > settings 兼容规则 > Pi 默认链路
 * - 主 agent 与子 agent 共用同一请求链路，规则自动对两者生效
 *
 * 限制：streamSimple 钩子只接管 api=openai-responses 的模型（opencode-go
 * 的 gpt-5.6-luna/grok-4.5、openai 的 gpt-*）；opencode-go 的
 * openai-completions（deepseek/glm）与 anthropic-messages（qwen/minimax）
 * 模型不经过模型级 hook；启用 /allproxy 时仍由临时进程级 dispatcher 统一代理。
 */

// ── 配置加载（mtime 缓存，改文件后自动重载）────────────────────────────

interface ProxyRule {
  pattern: string;
  url: string | null; // null = 显式直连
  regex: RegExp;
}

interface AuthRule {
  provider: string;
  url: string | null; // null = 显式直连
}

interface RouteDecision {
  matched: boolean;
  url: string | null;
}

interface LoadedRules {
  modelRules: ProxyRule[];
  authRules: AuthRule[];
}

const RULE_SOURCES = [
  { path: join(homedir(), ".pi", "agent", "settings.json"), dedicated: false },
  { path: join(process.cwd(), ".pi", "settings.json"), dedicated: false },
  { path: join(homedir(), ".pi", "agent", "proxy-router.json"), dedicated: true },
  { path: join(process.cwd(), ".pi", "proxy-router.json"), dedicated: true },
];

let rulesCache: (LoadedRules & { mtimes: number[] }) | null = null;

function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (/[.+?^${}()|[\]\\]/.test(ch)) re += `\\${ch}`;
    else re += ch;
  }
  return new RegExp(`^${re}$`);
}

function loadRules(): LoadedRules {
  const mtimes = RULE_SOURCES.map(({ path }) => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  });
  if (rulesCache && mtimes.every((m, i) => m === rulesCache!.mtimes[i])) {
    return rulesCache;
  }
  const mergedModels: Record<string, string | null> = {};
  const mergedAuth: Record<string, string | null> = {};
  for (const source of RULE_SOURCES) {
    try {
      if (!existsSync(source.path)) continue;
      const settings = JSON.parse(readFileSync(source.path, "utf8")) as Record<string, unknown>;
      const node = (source.dedicated
        ? (settings["proxy-router"] ?? settings)
        : (settings["proxy-router"] ?? settings["model-proxy"])) as
        | Record<string, unknown>
        | undefined;
      if (!node || typeof node !== "object") continue;
      const modelNode =
        node.models && typeof node.models === "object" && !Array.isArray(node.models)
          ? (node.models as Record<string, unknown>)
          : node;
      for (const [pattern, value] of Object.entries(modelNode)) {
        if (typeof value !== "string") continue;
        const trimmed = value.trim();
        mergedModels[pattern] = trimmed && !/^direct$/i.test(trimmed) ? trimmed : null;
      }
      const authNode = node.auth;
      if (authNode && typeof authNode === "object" && !Array.isArray(authNode)) {
        for (const [provider, value] of Object.entries(authNode as Record<string, unknown>)) {
          if (typeof value !== "string") continue;
          const trimmed = value.trim();
          mergedAuth[provider] = trimmed && !/^direct$/i.test(trimmed) ? trimmed : null;
        }
      }
    } catch (err) {
      logError(`config parse error (${source.path}):`, err);
    }
  }
  const modelRules = Object.entries(mergedModels).map(([pattern, url]) => ({
    pattern,
    url,
    regex: globToRegExp(pattern),
  }));
  const authRules = Object.entries(mergedAuth).map(([provider, url]) => ({ provider, url }));
  rulesCache = { modelRules, authRules, mtimes };
  return rulesCache;
}

// ── 代理 dispatcher 缓存 ─────────────────────────────────────────────

const dispatcherCache = new Map<string, Dispatcher>();
let directDispatcher: Dispatcher | undefined;

function getDispatcher(proxyUrl: string): Dispatcher | null {
  let dispatcher = dispatcherCache.get(proxyUrl);
  if (!dispatcher) {
    if (/^https?:\/\//i.test(proxyUrl)) {
      dispatcher = new ProxyAgent(proxyUrl) as Dispatcher;
    } else if (/^socks5/i.test(proxyUrl)) {
      dispatcher = new SocksDispatcher(proxyUrl) as unknown as Dispatcher;
    } else {
      return null; // 不支持的协议 → 直连
    }
    dispatcherCache.set(proxyUrl, dispatcher);
  }
  return dispatcher;
}

function getRouteDispatcher(proxyUrl: string | null): Dispatcher | null {
  if (proxyUrl === null) {
    directDispatcher ??= new Agent() as Dispatcher;
    return directDispatcher;
  }
  return getDispatcher(proxyUrl);
}

// 运行时状态
let commandDisabled = false; // /noproxy 禁用所有代理
let allProxyUrl: string | null = null; // /allproxy 全局代理（最高优先级，临时）

// 仅支持 Pi 当前已知的认证 endpoint；不开放任意 URL 通配，避免演变成
// GFWList。浏览器页面本身不会经过这里，只有 Pi 进程内的 token/device 请求会匹配。
const AUTH_ENDPOINTS = [
  {
    provider: "openai-codex",
    hostname: "auth.openai.com",
    path: /^\/(?:oauth\/token|api\/accounts\/deviceauth\/(?:usercode|token))$/,
  },
];

type ManagedDispatcher = Dispatcher & {
  __piProxyRouterGlobalDispatcher?: { fallback: Dispatcher };
};

const globalDispatcherState: { applied: Dispatcher | undefined } = { applied: undefined };

class GlobalRoutingDispatcher {
  readonly __piProxyRouterGlobalDispatcher: { fallback: Dispatcher };
  private readonly fallback: Dispatcher;
  private readonly noproxyFlag: boolean;

  constructor(fallback: Dispatcher, noproxyFlag: boolean) {
    this.fallback = fallback;
    this.noproxyFlag = noproxyFlag;
    this.__piProxyRouterGlobalDispatcher = { fallback };
  }

  dispatch(options: any, handler: any): boolean {
    const route = resolveGlobalRoute(this.noproxyFlag, options);
    if (route.matched) {
      const dispatcher = getRouteDispatcher(route.url);
      if (dispatcher) return dispatcher.dispatch(options, handler);
      logError(`unsupported global proxy URL, going direct: ${route.url}`);
    }
    return this.fallback.dispatch(options, handler);
  }

  close(): Promise<void> {
    return this.fallback.close();
  }

  destroy(): Promise<void> {
    return this.fallback.destroy();
  }
}

function unwrapManagedDispatcher(current: Dispatcher): Dispatcher {
  let base = current;
  const seen = new Set<Dispatcher>();
  while (!seen.has(base)) {
    seen.add(base);
    const marker = (base as ManagedDispatcher).__piProxyRouterGlobalDispatcher;
    if (!marker?.fallback) break;
    base = marker.fallback;
  }
  return base;
}

function ensureGlobalDispatcher(noproxyFlag: boolean): void {
  const current = getGlobalDispatcher() as Dispatcher;
  if (current === globalDispatcherState.applied) return;
  const dispatcher = new GlobalRoutingDispatcher(
    unwrapManagedDispatcher(current),
    noproxyFlag,
  ) as unknown as Dispatcher;
  setGlobalDispatcher(dispatcher);
  globalDispatcherState.applied = dispatcher;
  log("global auth dispatcher installed");
}

function applyAllProxy(noproxyFlag: boolean): void {
  // The dispatcher stays installed for auth rules; /allproxy only changes the
  // dynamic decision made by that dispatcher.
  ensureGlobalDispatcher(noproxyFlag);
}

function getRequestUrl(options: any): URL | null {
  try {
    if (!options?.origin) return null;
    return new URL(options.path || "/", String(options.origin));
  } catch {
    return null;
  }
}

function resolveAuthProvider(url: URL): string | null {
  const hostname = url.hostname.toLowerCase();
  return (
    AUTH_ENDPOINTS.find(
      (endpoint) => endpoint.hostname === hostname && endpoint.path.test(url.pathname),
    )?.provider ?? null
  );
}

function resolveGlobalRoute(noproxyFlag: boolean, options: any): RouteDecision {
  if (noproxyFlag || commandDisabled) return { matched: false, url: null };
  if (allProxyUrl) return { matched: true, url: allProxyUrl };

  const url = getRequestUrl(options);
  if (!url) return { matched: false, url: null };
  const provider = resolveAuthProvider(url);
  if (!provider) return { matched: false, url: null };
  const rule = loadRules().authRules.find((entry) => entry.provider === provider);
  if (!rule) return { matched: false, url: null };
  log(`auth route: ${provider}${url.pathname} -> ${displayProxyUrl(rule.url)}`);
  return { matched: true, url: rule.url };
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("noproxy", {
    description: "Disable proxy routing (models and temporary /allproxy requests go direct)",
    type: "boolean",
    default: false,
  });

  // Provider callbacks can outlive this extension activation across /reload or
  // session replacement. Snapshot the immutable CLI flag here so those
  // callbacks never call methods on the old ExtensionAPI instance later.
  const noproxyFlag = Boolean(pi.getFlag("noproxy"));

  pi.registerCommand("proxy", {
    description:
      "Show current proxy routing status: /proxy [provider/model] — optional arg resolves that model",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const target = args.trim();
      const lines: string[] = [];
      lines.push("[proxy-router] status");
      lines.push(`  --noproxy flag:  ${noproxyFlag ? "on (disabled)" : "off"}`);
      lines.push(`  /noproxy:        ${commandDisabled ? "off (direct)" : "on (rules active)"}`);
      lines.push(`  /allproxy:       ${allProxyUrl ? displayProxyUrl(allProxyUrl) : "not set"}`);
      // 环境变量中的代理设置（影响 pi 的 EnvHttpProxyAgent 默认链路）
      const envVars: [string, string][] = [
        ["HTTP_PROXY", process.env.HTTP_PROXY ?? ""],
        ["HTTPS_PROXY", process.env.HTTPS_PROXY ?? ""],
        ["ALL_PROXY", process.env.ALL_PROXY ?? ""],
        ["NO_PROXY", process.env.NO_PROXY ?? ""],
      ];
      lines.push("  env:");
      for (const [name, value] of envVars) {
        lines.push(`    ${name.padEnd(12)} ${displayEnvValue(name, value)}`);
      }
      const rules = loadRules();
      lines.push(`  model rules (${rules.modelRules.length}):`);
      for (const r of rules.modelRules) {
        lines.push(`    ${r.pattern.padEnd(24)} -> ${displayProxyUrl(r.url)}`);
      }
      lines.push(`  auth rules (${rules.authRules.length}):`);
      for (const r of rules.authRules) {
        lines.push(`    ${r.provider.padEnd(24)} -> ${displayProxyUrl(r.url)}`);
      }
      if (target) {
        const slash = target.indexOf("/");
        if (slash > 0 && slash < target.length - 1) {
          const provider = target.slice(0, slash);
          const model = target.slice(slash + 1);
          lines.push(
            `  resolve ${target} -> ${displayProxyUrl(resolveProxyUrl(noproxyFlag, provider, model))}`,
          );
        } else {
          lines.push(`  (usage: /proxy [provider/model] e.g. openai-codex/gpt-5.6-luna)`);
        }
      }
      const msg = lines.join("\n");
      log(msg);
      ctx.ui.notify(msg, "info");
    },
  });

  pi.registerCommand("noproxy", {
    description: "Toggle proxy routing for this session: /noproxy [on|off]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on") commandDisabled = false;
      else if (arg === "off") commandDisabled = true;
      else commandDisabled = !commandDisabled;
      applyAllProxy(noproxyFlag);
      const state = commandDisabled ? "off (direct)" : "on (rules active)";
      log(`/noproxy -> ${state}`);
      ctx.ui.notify(`proxy-router: ${state}`, "info");
    },
  });

  pi.registerCommand("allproxy", {
    description:
      "Force Pi HTTP(S) and all models through a proxy (session-only, not persisted): /allproxy [url] — no arg to cancel",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const url = args.trim();
      if (!url) {
        allProxyUrl = null;
        applyAllProxy(noproxyFlag);
        log("/allproxy -> off (rules active)");
        ctx.ui.notify("proxy-router: /allproxy off", "info");
        return;
      }
      if (!/^(https?|socks5h?):\/\//i.test(url)) {
        ctx.ui.notify("proxy-router: invalid proxy URL", "error");
        return;
      }
      allProxyUrl = url;
      applyAllProxy(noproxyFlag);
      log(`/allproxy -> ${displayProxyUrl(url)} (all models)`);
      ctx.ui.notify(`proxy-router: all models -> ${displayProxyUrl(url)}`, "info");
    },
  });

  // 运行时由 pi 的扩展加载器 alias 到内置 compat 入口（re-export
  // openAIResponsesApi / openAICodexResponsesApi）；npm 类型包未导出
  // 这些符号，这里按结构断言。
  type ResponsesApi = {
    streamSimple: (
      model: Model<any>,
      context: Context,
      options?: SimpleStreamOptions,
    ) => AssistantMessageEventStream;
  };
  const { openAIResponsesApi, openAICodexResponsesApi } = piAi as unknown as {
    openAIResponsesApi: () => ResponsesApi;
    openAICodexResponsesApi: () => ResponsesApi;
  };

  const makeRouteResponses =
    (api: ResponsesApi) =>
    (
      model: Model<any>,
      context: Context,
      options?: SimpleStreamOptions,
    ): AssistantMessageEventStream => {
      const route = resolveModelRoute(noproxyFlag, model.provider, model.id);
      const proxyUrl = route.matched ? route.url : null;
      const forceCodexSse =
        model.provider === "openai-codex" &&
        Boolean(proxyUrl);
      log(
        `route: ${model.provider}/${model.id} -> ${displayProxyUrl(proxyUrl)}`,
      );
      if (route.matched) {
        const dispatcher = getRouteDispatcher(route.url);
        if (dispatcher) {
          const routedOptions: SimpleStreamOptions = {
            ...options,
            fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
              try {
                return (await undiciFetch(input as never, {
                  ...(init as Record<string, unknown>),
                  dispatcher: dispatcher as never,
                } as never)) as unknown as Response;
              } catch (err) {
                logError("proxyFetch failed:", err);
                throw err;
              }
            }) as never,
          };
          if (forceCodexSse) routedOptions.transport = "sse";
          return api.streamSimple(model, context, routedOptions);
        }
        logError(`unsupported proxy URL, going direct: ${displayProxyUrl(proxyUrl)}`);
      }
      if (forceCodexSse) {
        return api.streamSimple(model, context, {
          ...options,
          transport: "sse",
        });
      }
      return api.streamSimple(model, context, options);
    };

  const routeResponses = makeRouteResponses(openAIResponsesApi());
  const routeCodexResponses = makeRouteResponses(openAICodexResponsesApi());

  // 只接管对应 api 的模型；其余 api 的模型走默认实现
  pi.registerProvider("opencode-go", {
    api: "openai-responses",
    streamSimple: routeResponses,
  });
  pi.registerProvider("openai", {
    api: "openai-responses",
    streamSimple: routeResponses,
  });
  pi.registerProvider("openai-codex", {
    api: "openai-codex-responses",
    streamSimple: routeCodexResponses,
  });

  // Pi may recreate its default dispatcher while runtime settings change.
  // Reinstall the auth-aware wrapper before a model turn when needed.
  pi.on("before_agent_start", () => applyAllProxy(noproxyFlag));

  ensureGlobalDispatcher(noproxyFlag);
  const rules = loadRules();
  log(
    `loaded (${rules.modelRules.length} model rules, ${rules.authRules.length} auth rules ` +
      `from proxy-router config). ` +
      `--noproxy / /noproxy to disable.`,
  );
}

function resolveModelRoute(
  noproxyFlag: boolean,
  provider: string,
  modelId: string,
): RouteDecision {
  if (commandDisabled || noproxyFlag) {
    return { matched: false, url: null };
  }
  // /allproxy 临时全局代理优先于模型规则
  if (allProxyUrl) {
    return { matched: true, url: allProxyUrl };
  }
  const target = `${provider}/${modelId}`;
  for (const rule of loadRules().modelRules) {
    if (rule.regex.test(target)) {
      return { matched: true, url: rule.url };
    }
  }
  return { matched: false, url: null };
}

function resolveProxyUrl(
  noproxyFlag: boolean,
  provider: string,
  modelId: string,
): string | null {
  const route = resolveModelRoute(noproxyFlag, provider, modelId);
  return route.matched ? route.url : null;
}
