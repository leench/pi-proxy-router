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

/**
 * pi-proxy-router：按模型路由代理。
 *
 * 配置在 settings.json 的 "proxy-router" 节点（全局 ~/.pi/agent/settings.json
 * 与项目 .pi/settings.json，项目覆盖全局；旧键名 "model-proxy" 仍兼容）：
 *
 *   "proxy-router": {
 *     "openai/*":            "socks5h://localhost:7890",
 *     "opencode-go/gpt*":    "socks5h://proxy.example.test:7890",
 *     "opencode-go/glm*":    "direct"     // 显式直连
 *   }
 *
 * - key 为 "provider/模型模式"，* 通配（provider 用实际 id，如 opencode-go）
 * - value 为代理 URL（http://、https://、socks5h://，按书写顺序首个命中）
 *   或 "direct"（直连）；不在列表中的模型默认直连。规范写法：socks5h://
 *   （远端解析）；兼容旧写法 socks5://（自动归一化为 socks5h 语义）
 * - 优先级：--noproxy / /noproxy（禁用）> /allproxy（全局代理，临时）
 *   > settings 规则 > 默认直连
 * - 主 agent 与子 agent 共用同一请求链路，规则自动对两者生效
 *
 * 限制：streamSimple 钩子只接管 api=openai-responses 的模型（opencode-go
 * 的 gpt-5.6-luna/grok-4.5、openai 的 gpt-*）；opencode-go 的
 * openai-completions（deepseek/glm）与 anthropic-messages（qwen/minimax）
 * 模型不经过模型级 hook；启用 /allproxy 时仍由临时进程级 dispatcher 统一代理。
 */

// ── settings.json 规则加载（mtime 缓存，改文件后自动重载）─────────────

interface ProxyRule {
  pattern: string;
  url: string | null; // null = 显式直连
  regex: RegExp;
}

const SETTINGS_FILES = [
  join(homedir(), ".pi", "agent", "settings.json"),
  join(process.cwd(), ".pi", "settings.json"),
];

let rulesCache: { rules: ProxyRule[]; mtimes: number[] } | null = null;

function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (/[.+?^${}()|[\]\\]/.test(ch)) re += `\\${ch}`;
    else re += ch;
  }
  return new RegExp(`^${re}$`);
}

function loadRules(): ProxyRule[] {
  const mtimes = SETTINGS_FILES.map((f) => {
    try {
      return statSync(f).mtimeMs;
    } catch {
      return 0;
    }
  });
  if (rulesCache && mtimes.every((m, i) => m === rulesCache!.mtimes[i])) {
    return rulesCache.rules;
  }
  const merged: Record<string, string | null> = {};
  for (const file of SETTINGS_FILES) {
    try {
      if (!existsSync(file)) continue;
      const settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const node = (settings["proxy-router"] ?? settings["model-proxy"]) as
        | Record<string, unknown>
        | undefined;
      if (!node || typeof node !== "object") continue;
      for (const [pattern, value] of Object.entries(node as Record<string, unknown>)) {
        merged[pattern] =
          typeof value === "string" && value.trim() && !/^direct$/i.test(value)
            ? value.trim()
            : null;
      }
    } catch (err) {
      logError("settings.json parse error:", err);
    }
  }
  const rules = Object.entries(merged).map(([pattern, url]) => ({
    pattern,
    url,
    regex: globToRegExp(pattern),
  }));
  rulesCache = { rules, mtimes };
  return rules;
}

// ── 代理 dispatcher 缓存 ─────────────────────────────────────────────

const dispatcherCache = new Map<string, unknown>();

function getDispatcher(proxyUrl: string): unknown | null {
  let dispatcher = dispatcherCache.get(proxyUrl);
  if (!dispatcher) {
    if (/^https?:\/\//i.test(proxyUrl)) {
      dispatcher = new ProxyAgent(proxyUrl);
    } else if (/^socks5/i.test(proxyUrl)) {
      dispatcher = new SocksDispatcher(proxyUrl);
    } else {
      return null; // 不支持的协议 → 直连
    }
    dispatcherCache.set(proxyUrl, dispatcher);
  }
  return dispatcher;
}

// 运行时状态
let commandDisabled = false; // /noproxy 禁用所有代理
let allProxyUrl: string | null = null; // /allproxy 全局代理（最高优先级，临时）

interface GlobalDispatcherState {
  managedUrl: string | undefined;
  previous: Dispatcher | undefined;
  applied: Dispatcher | undefined;
}

const globalDispatcherState: GlobalDispatcherState = {
  managedUrl: undefined,
  previous: undefined,
  applied: undefined,
};

function effectiveAllProxyUrl(noproxyFlag: boolean): string | null {
  if (noproxyFlag || commandDisabled) return null;
  return allProxyUrl;
}

/**
 * Install the temporary /allproxy URL as Pi's process-wide Undici dispatcher.
 * This intentionally applies only while /allproxy is active; ordinary model
 * routing remains scoped to the matching provider/model rule.
 */
function applyAllProxy(noproxyFlag: boolean): void {
  const desired = effectiveAllProxyUrl(noproxyFlag);

  const current = getGlobalDispatcher();
  if (desired === null) {
    if (globalDispatcherState.managedUrl === undefined) return;
    const restore =
      current === globalDispatcherState.applied
        ? (globalDispatcherState.previous ?? current)
        : current;
    setGlobalDispatcher(restore);
    globalDispatcherState.managedUrl = undefined;
    globalDispatcherState.previous = undefined;
    globalDispatcherState.applied = undefined;
    log("/allproxy -> off (restore Pi dispatcher)");
    return;
  }

  const dispatcher = getDispatcher(desired) as Dispatcher | null;
  if (!dispatcher) {
    logError(`unsupported /allproxy URL, keeping current dispatcher: ${desired}`);
    return;
  }

  if (globalDispatcherState.managedUrl === undefined) {
    globalDispatcherState.previous = current;
  } else if (current !== globalDispatcherState.applied) {
    // Pi may recreate its EnvHttpProxyAgent when runtime settings change.
    // Preserve that fresh dispatcher as the restore target.
    globalDispatcherState.previous = current;
  }

  if (current !== dispatcher) setGlobalDispatcher(dispatcher);
  globalDispatcherState.managedUrl = desired;
  globalDispatcherState.applied = dispatcher;
  log(`/allproxy dispatcher -> ${desired}`);
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
      lines.push(`  /allproxy:       ${allProxyUrl ?? "not set"}`);
      // 环境变量中的代理设置（影响 pi 的 EnvHttpProxyAgent 默认链路）
      const envVars: [string, string][] = [
        ["HTTP_PROXY", process.env.HTTP_PROXY ?? ""],
        ["HTTPS_PROXY", process.env.HTTPS_PROXY ?? ""],
        ["ALL_PROXY", process.env.ALL_PROXY ?? ""],
        ["NO_PROXY", process.env.NO_PROXY ?? ""],
      ];
      lines.push("  env:");
      for (const [name, value] of envVars) {
        lines.push(`    ${name.padEnd(12)} ${value ? value : "(not set)"}`);
      }
      const rules = loadRules();
      lines.push(`  rules (${rules.length}):`);
      for (const r of rules) {
        lines.push(`    ${r.pattern.padEnd(24)} -> ${r.url ?? "direct"}`);
      }
      if (target) {
        const slash = target.indexOf("/");
        if (slash > 0 && slash < target.length - 1) {
          const provider = target.slice(0, slash);
          const model = target.slice(slash + 1);
          lines.push(
            `  resolve ${target} -> ${resolveProxyUrl(noproxyFlag, provider, model) ?? "direct"}`,
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
        ctx.ui.notify(`proxy-router: invalid proxy URL: ${url}`, "error");
        return;
      }
      allProxyUrl = url;
      applyAllProxy(noproxyFlag);
      log(`/allproxy -> ${url} (all models)`);
      ctx.ui.notify(`proxy-router: all models -> ${url}`, "info");
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
      const proxyUrl = resolveProxyUrl(noproxyFlag, model.provider, model.id);
      const forceCodexSse =
        model.provider === "openai-codex" &&
        Boolean(proxyUrl);
      log(
        `route: ${model.provider}/${model.id} -> ${proxyUrl ?? "direct"}`,
      );
      if (proxyUrl) {
        const dispatcher = getDispatcher(proxyUrl);
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
        logError(
          `unsupported proxy URL, going direct: ${proxyUrl}`,
        );
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
  // Reapply the temporary /allproxy dispatcher before a model turn when set.
  pi.on("before_agent_start", () => applyAllProxy(noproxyFlag));

  const ruleCount = loadRules().length;
  log(
    `loaded (${ruleCount} rules from settings.json). ` +
      `--noproxy / /noproxy to disable.`,
  );
}

function resolveProxyUrl(
  noproxyFlag: boolean,
  provider: string,
  modelId: string,
): string | null {
  if (commandDisabled || noproxyFlag) {
    return null;
  }
  // /allproxy 临时全局代理优先于模型规则
  if (allProxyUrl) {
    return allProxyUrl;
  }
  const target = `${provider}/${modelId}`;
  for (const rule of loadRules()) {
    if (rule.regex.test(target)) {
      return rule.url;
    }
  }
  return null;
}
