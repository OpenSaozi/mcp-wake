import { spawn } from "node:child_process";

/**
 * 一个刚好够用的 MCP 客户端（stdio 传输）。
 *
 * 只实现守望需要的那几件事:握手、订阅资源、读资源、接收服务端推送。
 * 刻意不做成完整 SDK —— 这个工具的全部价值在于「把推送变成进程行为」,
 * 客户端本身越小越不容易坏。
 *
 * 传输层单独隔在这里:将来 MCP over HTTP 可用时,只需要再写一个同样接口的
 * 传输实现,上层守望逻辑一行都不用动。
 */

const PROTOCOL_VERSION = "2025-06-18";
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
  #exited = null;

  /**
   * @param {object} options
   * @param {string} options.command 要启动的 MCP 服务器命令
   * @param {string[]} options.args 命令参数
   * @param {string} [options.cwd] 服务器的工作目录
   * @param {(reason: string) => void} [options.onServerGone] 服务器意外退出时的回调
   */
  constructor({ command, args = [], cwd, onServerGone }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.onServerGone = onServerGone;
  }

  start() {
    this.#child = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk) => this.#onStderr(chunk));
    this.#child.on("error", (error) => this.#fail(`无法启动 MCP 服务器:${error.message}`));
    this.#child.on("exit", (code, signal) => {
      this.#exited = signal ? `被信号 ${signal} 结束` : `退出码 ${code}`;
      this.#fail(`MCP 服务器${this.#exited}${this.stderrTail() ? `\n${this.stderrTail()}` : ""}`);
      this.onServerGone?.(this.#exited);
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

  #fail(reason) {
    const error = new McpError(reason);
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
  }

  #send(payload) {
    if (!this.#child?.stdin.writable) throw new McpError("MCP 服务器的输入通道已关闭");
    this.#child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(method, params) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  onNotification(handler) {
    this.#notificationHandlers.add(handler);
    return () => this.#notificationHandlers.delete(handler);
  }

  /** 握手,并返回服务端声明的能力。 */
  async initialize(clientName = "mcp-wake", clientVersion = "0.2.0") {
    const result = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: clientName, version: clientVersion },
    });
    this.notify("notifications/initialized", {});
    return result;
  }

  async subscribeResource(uri) {
    await this.request("resources/subscribe", { uri });
  }

  /** 读资源,把所有文本片段拼起来返回。 */
  async readResourceText(uri) {
    const result = await this.request("resources/read", { uri });
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
