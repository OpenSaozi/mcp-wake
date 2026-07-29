import { spawn } from "node:child_process";

/**
 * 一个刚好够用的 MCP 客户端（stdio 传输），同时会说两代协议。
 *
 * 只实现守望需要的那几件事:探测、握手、订阅资源、读资源、接收服务端推送。
 * 刻意不做成完整 SDK —— 这个工具的全部价值在于「把推送变成进程行为」,
 * 客户端本身越小越不容易坏。
 *
 * ## 为什么要认两代
 *
 * 2026-07-28 那版规范把协议改成了无状态:去掉 initialize 握手,协议版本和客户端
 * 能力改成每个请求都放在 _meta 里;订阅也从 resources/subscribe 换成了长连的
 * subscriptions/listen。
 *
 * 规范专门为 stdio 留了兼容办法:先发 server/discover 探一下。新服务器必须实现它;
 * 老服务器不认识这个方法,会回「方法不存在」,那就退回 initialize 那条老路。
 *
 * 传输层单独隔在这里:将来要加 MCP 的 HTTP 传输,只需要再写一个同样接口的实现,
 * 上层守望逻辑一行都不用动。
 */

const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSION = "2025-06-18";
const METHOD_NOT_FOUND = -32601;
const STDERR_KEEP_LINES = 20;

export class McpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

export class McpStdioClient {
  #child = null;
  #buffer = "";
  #nextId = 1;
  #pending = new Map();
  #notificationHandlers = new Set();
  #stderrTail = [];
  #generation = null; // "modern" | "legacy"

  constructor({ command, args = [], cwd, clientName = "mcp-wake", clientVersion = "0.3.0", onServerGone }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    this.onServerGone = onServerGone;
  }

  get generation() {
    return this.#generation;
  }

  start() {
    this.#child = spawn(this.command, this.args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk) => this.#onStderr(chunk));
    this.#child.on("error", (error) => this.#failAll(`无法启动 MCP 服务器:${error.message}`));
    this.#child.on("exit", (code, signal) => {
      const how = signal ? `被信号 ${signal} 结束` : `退出码 ${code}`;
      this.#failAll(`MCP 服务器${how}${this.stderrTail() ? `\n${this.stderrTail()}` : ""}`);
      this.onServerGone?.(how);
    });
  }

  stderrTail() {
    return this.#stderrTail.join("\n");
  }

  #onStderr(chunk) {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      this.#stderrTail.push(line);
      if (this.#stderrTail.length > STDERR_KEEP_LINES) this.#stderrTail.shift();
    }
  }

  // MCP 的 stdio 传输按行分隔 JSON,消息本身不含换行。
  #onStdout(chunk) {
    this.#buffer += chunk;
    let index;
    while ((index = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // 不是 JSON 的行一律忽略:有些服务器会往标准输出漏日志
      }
      this.#dispatch(message);
    }
  }

  #dispatch(message) {
    if (message.id !== undefined && this.#pending.has(message.id)) {
      const { resolve, reject } = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error) reject(new McpError(message.error.message, message.error.code));
      else resolve(message.result);
      return;
    }
    if (message.method) {
      for (const handler of this.#notificationHandlers) handler(message);
    }
  }

  #failAll(reason) {
    const error = new McpError(reason);
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
  }

  #write(payload) {
    if (!this.#child?.stdin.writable) throw new McpError("MCP 服务器的输入通道已关闭");
    this.#child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  /** 新协议要求每个请求都自带协议版本和客户端身份;老协议靠握手,不需要。 */
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

  /** 发一个请求并等应答。 */
  request(method, params) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  /**
   * 发一个「不等应答」的请求,只拿它的 JSON-RPC id。
   *
   * subscriptions/listen 就是这种:它的应答要等到订阅结束才来,
   * 中途的通知靠 id 关联。按普通请求去 await 会一直卡住。
   */
  requestWithoutWaiting(method, params) {
    const id = this.#nextId++;
    this.#write({ jsonrpc: "2.0", id, method, params });
    return id;
  }

  notify(method, params) {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  onNotification(handler) {
    this.#notificationHandlers.add(handler);
    return () => this.#notificationHandlers.delete(handler);
  }

  /**
   * 连上服务器并判定它说哪一代协议。
   *
   * 先探 server/discover:新服务器必须实现它;老服务器会回「方法不存在」,
   * 那就退回 initialize 握手。返回统一形状,上层不用关心走了哪条路。
   */
  async connect() {
    this.#generation = "modern"; // 让 #meta() 生效,好按新协议发探针
    try {
      const result = await this.request("server/discover", this.#withMeta());
      return {
        generation: "modern",
        serverInfo: result?._meta?.["io.modelcontextprotocol/serverInfo"] ?? null,
        supportedVersions: result?.supportedVersions ?? [],
        capabilities: result?.capabilities ?? {},
      };
    } catch (error) {
      if (!(error instanceof McpError) || error.code !== METHOD_NOT_FOUND) throw error;
      // 不认识 server/discover ⇒ 是老服务器,走握手那条路。
      this.#generation = "legacy";
      const result = await this.request("initialize", {
        protocolVersion: LEGACY_VERSION,
        capabilities: {},
        clientInfo: { name: this.clientName, version: this.clientVersion },
      });
      this.notify("notifications/initialized", {});
      return {
        generation: "legacy",
        serverInfo: result?.serverInfo ?? null,
        supportedVersions: result?.protocolVersion ? [result.protocolVersion] : [],
        capabilities: result?.capabilities ?? {},
      };
    }
  }

  /**
   * 订阅一个资源的变化。两代协议形状完全不同:
   * - 老:resources/subscribe,一问一答。
   * - 新:subscriptions/listen,长连流;服务端先回一条「已确认」通知,
   *      里面写明它实际答应了哪些订阅 —— 要核对,不能想当然。
   */
  async subscribeResource(uri, { ackTimeoutMs = 10_000 } = {}) {
    if (this.#generation === "legacy") {
      await this.request("resources/subscribe", { uri });
      return { subscriptionId: null };
    }
    return await new Promise((resolve, reject) => {
      let timer = null;
      const off = this.onNotification((message) => {
        if (message.method !== "notifications/subscriptions/acknowledged") return;
        if (message.params?._meta?.["io.modelcontextprotocol/subscriptionId"] !== id) return;
        off();
        if (timer) clearTimeout(timer);
        const honored = message.params?.notifications?.resourceSubscriptions;
        if (!Array.isArray(honored) || !honored.includes(uri)) {
          reject(new McpError(`服务器没有答应订阅这个资源:${uri}`));
          return;
        }
        resolve({ subscriptionId: id });
      });
      let id;
      try {
        id = this.requestWithoutWaiting(
          "subscriptions/listen",
          this.#withMeta({ notifications: { resourceSubscriptions: [uri] } }),
        );
      } catch (error) {
        off();
        reject(error);
        return;
      }
      timer = setTimeout(() => {
        off();
        reject(new McpError("等服务器确认订阅超时"));
      }, ackTimeoutMs);
    });
  }

  /** 读资源,把所有文本片段拼起来返回。 */
  async readResourceText(uri) {
    const result = await this.request("resources/read", this.#withMeta({ uri }));
    const contents = Array.isArray(result?.contents) ? result.contents : [];
    return contents
      .map((item) => (typeof item?.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("\n");
  }

  close() {
    if (!this.#child || this.#child.killed) return;
    try {
      this.#child.stdin.end();
    } catch {
      // 关不掉就直接杀
    }
    this.#child.kill();
  }
}
