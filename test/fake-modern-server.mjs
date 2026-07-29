#!/usr/bin/env node
// 一个只说 2026-07-28 协议的假 MCP 服务器,用来测 mcp-wake 的新协议那条路。
//
// 真实的新协议服务器现在还没有(我们自己的桥说的是 2025-11-25),所以拿这个
// 按规范原文搭出来的替身来测 —— 总比把没验证过的协议代码直接发出去强。
//
// 它做四件事:
//   1. server/discover  → 声明只支持 2026-07-28
//   2. subscriptions/listen → 回一条「已确认」通知,然后开始定时推变化
//   3. resources/read   → 返回一段会变的正文
//   4. 请求里少了 _meta.protocolVersion 就报错(验证客户端真的每次都带上了)
//
// 环境变量:
//   FAKE_PUSH_EVERY_MS  多久推一次(默认 300)
//   FAKE_FLIP_AFTER     推第几次后把正文改成「命中态」(默认 3)
//   FAKE_REFUSE_SUB     设为 1 则确认回执里不包含所请求的资源(测拒绝路径)

const PROTOCOL = "2026-07-28";
const PUSH_EVERY_MS = Number(process.env.FAKE_PUSH_EVERY_MS || 300);
const FLIP_AFTER = Number(process.env.FAKE_FLIP_AFTER || 3);
const REFUSE_SUB = process.env.FAKE_REFUSE_SUB === "1";

let pushCount = 0;
let buffer = "";

function write(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function metaOf(message) {
  return message?.params?._meta ?? {};
}

function requireProtocol(message) {
  const version = metaOf(message)["io.modelcontextprotocol/protocolVersion"];
  if (version !== PROTOCOL) {
    write({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32022, message: `UnsupportedProtocolVersion: 需要 ${PROTOCOL}，收到 ${version ?? "(没带)"}` },
    });
    return false;
  }
  return true;
}

function currentBody() {
  // 推够 FLIP_AFTER 次之后翻成「命中态」,好让 --match 能命中并收尾。
  const status = pushCount >= FLIP_AFTER ? "turn.completed" : "turn.in_progress";
  return JSON.stringify({ pushCount, events: [{ "type": status }] }, null, 2);
}

function handle(message) {
  const { id, method } = message;

  if (method === "server/discover") {
    if (!requireProtocol(message)) return;
    write({
      jsonrpc: "2.0",
      id,
      result: {
        resultType: "complete",
        supportedVersions: [PROTOCOL],
        capabilities: { resources: {} },
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "fake-modern-server", version: "1.0.0" } },
        instructions: "只用于测试 mcp-wake 的新协议路径。",
        ttlMs: 60_000,
        cacheScope: "private",
      },
    });
    return;
  }

  if (method === "subscriptions/listen") {
    if (!requireProtocol(message)) return;
    const requested = message.params?.notifications?.resourceSubscriptions ?? [];
    // 规范:确认回执里写明服务端实际答应了哪些;客户端必须核对。
    write({
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: {
        _meta: { "io.modelcontextprotocol/subscriptionId": id },
        notifications: { resourceSubscriptions: REFUSE_SUB ? [] : requested },
      },
    });
    if (REFUSE_SUB) return;
    const timer = setInterval(() => {
      pushCount += 1;
      write({
        jsonrpc: "2.0",
        method: "notifications/resources/updated",
        params: { _meta: { "io.modelcontextprotocol/subscriptionId": id }, uri: requested[0] },
      });
      if (pushCount > FLIP_AFTER + 6) clearInterval(timer);
    }, PUSH_EVERY_MS);
    timer.unref?.();
    return;
  }

  if (method === "resources/read") {
    if (!requireProtocol(message)) return;
    write({
      jsonrpc: "2.0",
      id,
      result: {
        resultType: "complete",
        contents: [{ uri: message.params?.uri, mimeType: "application/json", text: currentBody() }],
        ttlMs: 1_000,
        cacheScope: "private",
      },
    });
    return;
  }

  if (id !== undefined) {
    write({ jsonrpc: "2.0", id, error: { code: -32601, message: `方法不存在:${method}` } });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // 坏行忽略
    }
  }
});
