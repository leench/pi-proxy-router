import type { Dispatcher } from "undici";
import { SocksProxyAgent } from "socks-proxy-agent";import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

function headersToObject(headers: string[] | Record<string, string>): Record<string, string> {
  if (Array.isArray(headers)) {
    const out: Record<string, string> = {};
    for (let i = 0; i + 1 < headers.length; i += 2) {
      out[headers[i]] = headers[i + 1];
    }
    return out;
  }
  return headers;
}

function headersToArray(headers: Record<string, string | string[] | undefined>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        out.push(key, String(v));
      }
    } else {
      out.push(key, String(value));
    }
  }
  return out;
}

/**
 * 把 socks-proxy-agent（node http.Agent 风格）适配为 undici Dispatcher（dispatch()），
 * 使 undici fetch 可以走 SOCKS5 代理。
 *
 * 实现：把 undici 的 dispatch 调用转发为 node http/https.request，并传入
 * SocksProxyAgent 作为 agent —— node 的 Agent 流程（createSocket → connect）
 * 会自动完成 socks 隧道握手，再把响应事件转换为 undici 的 handler 回调。
 */
export class SocksDispatcher {
  private readonly agent: SocksProxyAgent;

  constructor(proxyUrl: string) {
    // 统一按远端解析（socks5h 语义）：本地解析在 clash/mihomo 的 fake-ip
    // 模式下会拿到虚拟 IP（198.18.x.x），TLS 握手会被重置。
    const normalized = proxyUrl.replace(/^socks5:\/\//i, "socks5h://");
    this.agent = new SocksProxyAgent(normalized);
  }

  // undici fetch 只依赖 dispatch()；其余 Dispatcher 方法不需要。
  // 参数用宽松类型：undici 内部传的 options/handler 结构由运行时保证。
  dispatch(options: any, handler: any): boolean {
    const url = new URL(options.origin as string);
    const isHttps = url.protocol === "https:";
    const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
    const method = options.method ?? "GET";
    const path = options.path || "/";
    const headers = headersToObject(
      options.headers as string[] | Record<string, string>,
    );
    const signal = options.signal as AbortSignal | undefined;

    // 通过 SOCKS 代理发送 HTTP(S) 请求（SocksProxyAgent 负责隧道）
    const req = (isHttps ? httpsRequest : httpRequest)({
      hostname: url.hostname,
      port,
      path,
      method,
      headers,
      agent: this.agent as never,
    } as never);

    const abort = () => req.destroy(new Error("The operation was aborted."));
    handler.onConnect?.(abort);
    signal?.addEventListener("abort", abort, { once: true });

    req.on("response", (res) => {
      handler.onResponseStarted?.();
      handler.onHeaders(
        res.statusCode ?? 0,
        headersToArray(res.headers),
        () => {},
        res.statusMessage,
      );
      res.on("data", (chunk: Buffer) => handler.onData(chunk));
      res.on("end", () => handler.onComplete([]));
      res.on("error", (e) => handler.onError(e));
    });
    req.on("error", (e) => {
      signal?.removeEventListener("abort", abort);
      handler.onError(e);
    });

    // 透传请求体（undici 内部 body 可能是 node 流或 web ReadableStream，
    // 跨 realm 时 instanceof 不可靠，按能力鸭子类型处理）
    const body = options.body as
      | { pipe: (dest: NodeJS.WritableStream) => unknown }
      | AsyncIterable<Uint8Array>
      | null
      | undefined;
    if (body && typeof (body as { pipe?: unknown }).pipe === "function") {
      (body as { pipe: (dest: NodeJS.WritableStream) => unknown }).pipe(req);
    } else if (body && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function") {
      void (async () => {
        try {
          for await (const chunk of body as AsyncIterable<Uint8Array>) {
            req.write(chunk as never);
          }
          req.end();
        } catch (e) {
          req.destroy(e as Error);
        }
      })();
    } else {
      req.end();
    }

    return true;
  }

  async close(): Promise<void> {
    (this.agent as unknown as { destroy(): void }).destroy();
  }

  async destroy(): Promise<void> {
    (this.agent as unknown as { destroy(): void }).destroy();
  }
}
