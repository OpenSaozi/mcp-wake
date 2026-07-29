#!/usr/bin/env node
// mcp-wake:订阅一个 MCP 资源,把「远端发生了事」变成「本地进程退出」或「打印一行」。
//
// 为什么需要它:很多 AI 代理运行环境只有两种被叫醒的方式 —— 某个后台进程退出了,
// 或者某个进程打印了一行。MCP 协议本身有推送通道,但不少运行环境只实现了一半,
// 收不到服务端通知。这个工具就是补那一段,而且只补那一段。

import { EXIT, watchResource } from "../src/watch.mjs";

const DEFAULT_TIMEOUT_MINUTES = 30;

function usage() {
  return [
    "用法:mcp-wake (--url <地址> | --server <命令>) --resource <资源地址> [选项]",
    "",
    "去哪儿连(两者取其一,必填其一):",
    "  --url <地址>             远程 MCP 服务器的 HTTP 端点",
    "  --server <命令>          本地 MCP 服务器命令(整串,含参数),走 stdio",
    "",
    "必填:",
    "  --resource <uri>         要订阅的资源地址",
    "",
    "可选:",
    "  --header <名: 值>        仅 --url:附加请求头,可重复(鉴权用)",
    "  --mode once|stream       once=命中就退出(默认);stream=每次命中打印一行",
    "  --match <正则>           只有资源正文匹配它才算命中;省略表示任何变化都算",
    "  --until <正则>           仅 stream:正文匹配它就收尾退出",
    "  --timeout-minutes <分钟> 总时长,默认 30,可传小数",
    "  --cwd <目录>             仅 --server:被启动服务器的工作目录",
    "  --print-content          命中时把资源正文一并输出",
    "  --trace                  往标准错误打印握手/订阅/读取的过程",
    "",
    "退出码:0=命中收尾 3=超时 1=出错(服务器起不来、订阅被拒、连接断了)",
    "",
    "例一(远程):守望远端 MCP 服务器上的一个资源",
    "  mcp-wake --url https://example.com/mcp \\",
    "    --header 'Authorization: Bearer 你的令牌' \\",
    "    --resource 'task:///jobs/123' \\",
    "    --match '\"status\":\\s*\"(done|failed)\"'",
    "",
    "例二(本地):守望一个 Codex 对话,轮次跑完就叫醒我",
    "  mcp-wake \\",
    "    --server 'node /路径/codex-conversation-bridge-mcp.mjs' \\",
    "    --resource 'codex-conversation:///v1/conversations/cv_xxx/events?since=0' \\",
    "    --match '\"type\":\\s*\"turn\\.(completed|failed|cancelled)\"'",
  ].join("\n");
}

function parseArgv(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return { help: true };
  const values = new Map();
  const repeated = [];
  const flags = new Set();
  const booleans = new Set(["print-content", "trace"]);
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === "--help" || raw === "-h") return { help: true };
    if (!raw.startsWith("--")) throw new Error(`未知位置参数:${raw}`);
    const separator = raw.indexOf("=");
    const name = separator >= 0 ? raw.slice(2, separator) : raw.slice(2);
    if (booleans.has(name)) { flags.add(name); continue; }
    const value = separator >= 0 ? raw.slice(separator + 1) : argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} 缺少值`);
    // --header 是唯一允许重复的:一次请求常常要带好几个头。
    if (name === "header") { repeated.push(value); continue; }
    if (values.has(name)) throw new Error(`--${name} 不能重复`);
    values.set(name, value);
  }
  const known = new Set([
    "url", "server", "resource", "mode", "match", "until", "timeout-minutes", "cwd",
  ]);
  for (const name of values.keys()) {
    if (!known.has(name)) throw new Error(`未知参数:--${name}`);
  }

  const url = values.get("url");
  const server = values.get("server");
  if (url && server) throw new Error("--url 和 --server 只能给一个:要么连远程，要么起本地进程");
  if (!url && !server) throw new Error("要么给 --url(远程地址)，要么给 --server(本地命令)");
  if (url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`--url 不是合法地址:${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`--url 只支持 http/https，收到:${parsed.protocol}`);
    }
  }
  if (!url && repeated.length) throw new Error("--header 只在 --url 模式下有意义");
  const headers = {};
  for (const item of repeated) {
    const at = item.indexOf(":");
    if (at <= 0) throw new Error(`--header 格式应为「名: 值」，收到:${item}`);
    headers[item.slice(0, at).trim()] = item.slice(at + 1).trim();
  }
  // 整串命令按空白切开。参数里带空格的场景很少,真遇到再加专门的参数。
  const parts = server ? server.trim().split(/\s+/) : [];
  const resourceUri = values.get("resource");
  if (!resourceUri) throw new Error("--resource 必填:要订阅哪个资源");
  const mode = values.get("mode") ?? "once";
  if (mode !== "once" && mode !== "stream") throw new Error("--mode 只能是 once 或 stream");
  const timeoutMinutes = Number(values.get("timeout-minutes") ?? DEFAULT_TIMEOUT_MINUTES);
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new Error("--timeout-minutes 必须是大于 0 的数字");
  }
  const compile = (name) => {
    const raw = values.get(name);
    if (!raw) return null;
    try {
      return new RegExp(raw);
    } catch (error) {
      throw new Error(`--${name} 不是合法正则:${error instanceof Error ? error.message : error}`);
    }
  };
  const until = compile("until");
  if (until && mode !== "stream") throw new Error("--until 只在 --mode stream 下有意义");

  return {
    help: false,
    url,
    headers,
    serverCommand: parts[0],
    serverArgs: parts.slice(1),
    resourceUri,
    mode,
    match: compile("match"),
    until,
    timeoutMinutes,
    cwd: values.get("cwd"),
    printContent: flags.has("print-content"),
    trace: flags.has("trace"),
  };
}

function line(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

let config;
try {
  config = parseArgv(process.argv.slice(2));
  if (config.help) {
    process.stdout.write(`${usage()}\n`);
  } else {
    const result = await watchResource(config, {
      // 逐条模式下每次命中打印一行 —— 严格一行,因为对某些调用方来说一行就是一条通知。
      onWake: (hit) => line({
        version: 1,
        kind: "wake",
        resource: config.resourceUri,
        at: hit.at,
        ...(config.printContent ? { content: hit.text } : {}),
      }),
      onTrace: config.trace
        ? (entry) => process.stderr.write(`${JSON.stringify({ at: Date.now(), ...entry })}\n`)
        : undefined,
    });

    if (result.reason === "woke") {
      line({
        version: 1,
        kind: "wake",
        final: true,
        resource: config.resourceUri,
        at: result.at ?? new Date().toISOString(),
        ...(config.printContent && result.text ? { content: result.text } : {}),
      });
      process.exitCode = EXIT.woke;
    } else if (result.reason === "timeout") {
      line({ version: 1, kind: "timeout", final: true, resource: config.resourceUri });
      process.stderr.write(`mcp-wake:等了 ${config.timeoutMinutes} 分钟没等到\n`);
      process.exitCode = EXIT.timeout;
    } else {
      line({ version: 1, kind: "error", final: true, resource: config.resourceUri, error: result.error });
      process.stderr.write(`mcp-wake 出错:${result.error}\n`);
      process.exitCode = EXIT.error;
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  line({ version: 1, kind: "error", final: true, error: message });
  process.stderr.write(`mcp-wake 出错:${message}\n`);
  process.exitCode = EXIT.error;
}
