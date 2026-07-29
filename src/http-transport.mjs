import { createRequire } from "node:module";

/**
 * MCP 的 HTTP 传输客户端，两代协议都会说。对外接口跟 McpStdioClient 一模一样，
 * 上层守望逻辑不用关心底下是本地进程还是远程服务器。
 *
 * ## 两代的形状差很多
 *
 * 2026-07-28（Streamable HTTP，无状态）:
 *   - 每条 JSON-RPC 消息都是一次新的 POST，请求头必须带 MCP-Protocol-Version
 *   - Accept 必须同时声明 application/json 和 text/event-stream
 *   - 服务端可以用单个 JSON 回，也可以回一条 SSE 流
 *   - subscriptions/listen 的**响应体本身就是 SSE 流**，推送顺着它下来
 *   - 没有 GET 流端点了（那是上一代的设计）
 *
 * 2025-06-18 及更早（Streamable HTTP，有会话）:
 *   - POST 发请求，initialize 的响应头里带 Mcp-Session-Id，之后每次请求都要回传
 *   - 服务端到客户端的消息走**另开的一条 GET SSE 流**
 *
 * 用 node:http 而不是 fetch，有两个原因:一是 SSE 要拿原始流边收边解析,
 * 二是 fetch 在带沙箱的环境里会拉起 TLS 初始化，往标准错误喷一堆钥匙串告警
 * （见 mcp-client.mjs 顶部的说明）。用 createRequire 加载同理。
 */

const require = createRequire(import.meta.url);
const http = require("node:http");

const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSION = "2025-06-18";
const METHOD_NOT_FOUND = -32601;

export class McpHttpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "McpError"; // 跟 stdio 那边保持同一个名字,上层只认这一种
    this.code = code;
  }
}

/** 从字节流里一帧一帧地切 SSE。返回 {event, data} 或 null。 */
function nextFrame(buffer) {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return null;
  const useCrlf = crlf >= 0 && (lf < 0 || crlf < lf);
  const index = useCrlf ? crlf : lf;
  return { raw: buffer.slice(0, index), rest: buffer.slice(index + (useCrlf ? 4 : 2)) };
}

function parseFrame(raw) {
  let event = "message";
  const data = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return { event, data: data.join("\n") };
}

export class McpHttpClient {
  #generation = null;
  #sessionId = null;
  #notificationHandlers = new Set();
  #openStreams = new Set();
  #closed = false;

  constructor({ url, headers = {}, clientName = "mcp-wake", clientVersion = "0.4.0", onServerGone }) {
    this.url = url;
    this.extraHeaders = headers;
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    this.onServerGone = onServerGone;
  }

  get generation() {
    return this.#generation;
  }

  start() {
    const parsed = new URL(this.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new McpHttpError(`--url 只支持 http/https，收到:${parsed.protocol}`);
    }
  }

  stderrTail() {
    return "";
  }

  onNotification(handler) {
    this.#notificationHandlers.add(handler);
    return () => this.#notificationHandlers.delete(handler);
  }

  #emit(message) {
    for (const handler of this.#notificationHandlers) handler(message);
  }

  #meta() {
    if (this.#generation !== "modern") return undefined;
    return {
      "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
      "io.modelcontextprotocol/clientInfo": { name: this.clientName, version: this.clientVersion },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
  }

  #withMeta(params = {}) {
    const meta = this.#meta();
    return meta ? { ...params, _meta: meta } : params;
  }

  #headersFor(method) {
    const headers = {
      "content-type": "application/json",
      // 规范要求两种都声明:服务端可以用单个 JSON 回,也可以回一条 SSE 流。
      accept: "application/json, text/event-stream",
      ...this.extraHeaders,
    };
    if (this.#generation === "modern") headers["MCP-Protocol-Version"] = MODERN_VERSION;
    if (this.#sessionId) headers["Mcp-Session-Id"] = this.#sessionId;
    if (method) headers["x-mcp-wake-method"] = method;
    return headers;
  }

  #open({ method = "POST", body, headers, signal }) {
    const target = new URL(this.url);
    const transport = target.protocol === "https:" ? require("node:https") : http;
    return new Promise((resolve, reject) => {
      const finalHeaders = body === undefined
        ? { ...headers }
        : { ...headers, "content-length": Buffer.byteLength(body) };
      const request = transport.request(target, { method, headers: finalHeaders }, (response) => {
        resolve({ status: response.statusCode ?? 0, headers: response.headers, stream: response });
      });
      const onAbort = () => request.destroy(new McpHttpError("请求已中断"));
      signal?.addEventListener("abort", onAbort, { once: true });
      request.on("close", () => signal?.removeEventListener("abort", onAbort));
      request.on("error", reject);
      if (body === undefined) request.end();
      else request.end(body);
    });
  }

  /**
   * 消费一条 SSE 流:每帧解析成 JSON-RPC 消息交给回调。
   * onMessage 返回 false 表示不再需要这条流。
   */
  async #consume(stream, onMessage) {
    this.#openStreams.add(stream);
    stream.setEncoding("utf8");
    let buffer = "";
    try {
      for await (const chunk of stream) {
        buffer += chunk;
        let cut;
        while ((cut = nextFrame(buffer))) {
          buffer = cut.rest;
          const { data } = parseFrame(cut.raw);
          if (!data) continue;
          let message;
          try {
            message = JSON.parse(data);
          } catch {
            continue;
          }
          if (onMessage(message) === false) return;
        }
      }
    } finally {
      this.#openStreams.delete(stream);
      stream.destroy();
    }
  }

  /**
   * 发一个请求并等它的应答。服务端可能用单个 JSON 回，也可能回一条 SSE 流
   * （流上先来若干通知，最后才是应答）—— 两种都要认。
   */
  async request(method, params, { signal } = {}) {
    const id = `w-${method}-${Number(process.hrtime.bigint() % 1000000n)}`;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const response = await this.#open({ body, headers: this.#headersFor(method), signal });

    const sessionId = response.headers["mcp-session-id"];
    if (typeof sessionId === "string" && sessionId) this.#sessionId = sessionId;

    const contentType = String(response.headers["content-type"] || "");
    if (response.status < 200 || response.status >= 300) {
      const text = await this.#readAll(response.stream);
      let payload;
      try { payload = JSON.parse(text); } catch { payload = null; }
      const rpcError = payload?.error;
      throw new McpHttpError(
        rpcError?.message || `HTTP ${response.status}${text ? `:${text.slice(0, 200)}` : ""}`,
        rpcError?.code,
      );
    }

    if (contentType.startsWith("text/event-stream")) {
      return await new Promise((resolve, reject) => {
        this.#consume(response.stream, (message) => {
          if (message.id === id) {
            if (message.error) reject(new McpHttpError(message.error.message, message.error.code));
            else resolve(message.result);
            return false; // 拿到应答就收流
          }
          if (message.method) this.#emit(message);
          return true;
        }).catch(reject);
      });
    }

    const text = await this.#readAll(response.stream);
    const message = text ? JSON.parse(text) : {};
    if (message.error) throw new McpHttpError(message.error.message, message.error.code);
    return message.result;
  }

  #readAll(stream) {
    return new Promise((resolve, reject) => {
      stream.setEncoding("utf8");
      let text = "";
      stream.on("data", (chunk) => { text += chunk; });
      stream.on("end", () => resolve(text));
      stream.on("error", reject);
    });
  }

  async notify(method, params) {
    const body = JSON.stringify({ jsonrpc: "2.0", method, params });
    const response = await this.#open({ body, headers: this.#headersFor(method) });
    response.stream.resume(); // 通知不关心响应体
  }

  async connect() {
    this.#generation = "modern";
    try {
      const result = await this.request("server/discover", this.#withMeta());
      return {
        generation: "modern",
        serverInfo: result?._meta?.["io.modelcontextprotocol/serverInfo"] ?? null,
        supportedVersions: result?.supportedVersions ?? [],
        capabilities: result?.capabilities ?? {},
      };
    } catch (error) {
      if (error?.code !== METHOD_NOT_FOUND) throw error;
      this.#generation = "legacy";
      const result = await this.request("initialize", {
        protocolVersion: LEGACY_VERSION,
        capabilities: {},
        clientInfo: { name: this.clientName, version: this.clientVersion },
      });
      await this.notify("notifications/initialized", {});
      return {
        generation: "legacy",
        serverInfo: result?.serverInfo ?? null,
        supportedVersions: result?.protocolVersion ? [result.protocolVersion] : [],
        capabilities: result?.capabilities ?? {},
      };
    }
  }

  /** 老协议:服务端到客户端的消息走另开的一条 GET SSE 流。 */
  async #openLegacyStream() {
    const headers = { ...this.#headersFor(null), accept: "text/event-stream" };
    delete headers["content-type"];
    const response = await this.#open({ method: "GET", headers });
    if (response.status === 405 || response.status === 404) {
      response.stream.resume();
      throw new McpHttpError("服务器不提供 GET 事件流，无法接收推送（老协议 HTTP 传输必须支持它）");
    }
    if (response.status < 200 || response.status >= 300) {
      response.stream.resume();
      throw new McpHttpError(`打开事件流失败:HTTP ${response.status}`);
    }
    void this.#consume(response.stream, (message) => {
      if (message.method) this.#emit(message);
      return true;
    }).catch((error) => {
      if (!this.#closed) this.onServerGone?.(`事件流中断:${error.message}`);
    });
  }

  async subscribeResource(uri, { ackTimeoutMs = 10_000 } = {}) {
    if (this.#generation === "legacy") {
      await this.#openLegacyStream();
      await this.request("resources/subscribe", { uri });
      return { subscriptionId: null };
    }
    // 新协议:subscriptions/listen 的响应体本身就是 SSE 流,推送顺着它下来。
    // 它的最终应答要等订阅结束才来,所以这里不能用普通 request() 去等。
    const id = `w-listen-${Number(process.hrtime.bigint() % 1000000n)}`;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "subscriptions/listen",
      params: this.#withMeta({ notifications: { resourceSubscriptions: [uri] } }),
    });
    const response = await this.#open({ body, headers: this.#headersFor("subscriptions/listen") });
    if (response.status < 200 || response.status >= 300) {
      const text = await this.#readAll(response.stream);
      throw new McpHttpError(`订阅失败:HTTP ${response.status}${text ? `:${text.slice(0, 200)}` : ""}`);
    }
    if (!String(response.headers["content-type"] || "").startsWith("text/event-stream")) {
      response.stream.resume();
      throw new McpHttpError("subscriptions/listen 没有返回 SSE 流");
    }
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new McpHttpError("等服务器确认订阅超时")), ackTimeoutMs);
      let acknowledged = false;
      this.#consume(response.stream, (message) => {
        if (!acknowledged && message.method === "notifications/subscriptions/acknowledged") {
          acknowledged = true;
          clearTimeout(timer);
          const honored = message.params?.notifications?.resourceSubscriptions;
          if (!Array.isArray(honored) || !honored.includes(uri)) {
            reject(new McpHttpError(`服务器没有答应订阅这个资源:${uri}`));
            return false;
          }
          resolve({ subscriptionId: id });
          return true; // 流继续开着收推送
        }
        if (message.method) this.#emit(message);
        return true;
      }).catch((error) => {
        clearTimeout(timer);
        if (!acknowledged) reject(error);
        else if (!this.#closed) this.onServerGone?.(`订阅流中断:${error.message}`);
      });
    });
  }

  async readResourceText(uri) {
    const result = await this.request("resources/read", this.#withMeta({ uri }));
    const contents = Array.isArray(result?.contents) ? result.contents : [];
    return contents
      .map((item) => (typeof item?.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("\n");
  }

  close() {
    this.#closed = true;
    for (const stream of this.#openStreams) stream.destroy();
    this.#openStreams.clear();
  }
}
