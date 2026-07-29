#!/usr/bin/env node
// 一个假的 MCP HTTP 服务器,两代协议都能扮,用来测 mcp-wake 的 HTTP 传输。
//
// 环境变量:
//   FAKE_GENERATION  modern(默认)| legacy
//   FAKE_PORT        端口,默认 0(随机);启动后往标准输出打印 "LISTENING <port>"
//   FAKE_PUSH_EVERY_MS  多久推一次,默认 300
//   FAKE_FLIP_AFTER  推第几次后把正文翻成命中态,默认 3
//   FAKE_NEED_HEADER 设了就要求请求带这个头(形如 "authorization: Bearer x"),否则 401
//
// 两代的区别正是要测的地方:
//   modern: 每个消息一次 POST,必须带 MCP-Protocol-Version 头;
//           subscriptions/listen 的响应体本身是 SSE 流。
//   legacy: POST 发请求,initialize 响应头给 Mcp-Session-Id;
//           推送走另开的一条 GET SSE 流。

import { createRequire } from "node:module";

// 用 createRequire 而不是 import 加载 node:http:ESM 那条路会触发 macOS 钥匙串探测,
// 在沙箱里往标准错误喷一堆告警,把测试输出淹掉。
const require = createRequire(import.meta.url);
const http = require("node:http");

const GENERATION = process.env.FAKE_GENERATION || "modern";
const PUSH_EVERY_MS = Number(process.env.FAKE_PUSH_EVERY_MS || 300);
const FLIP_AFTER = Number(process.env.FAKE_FLIP_AFTER || 3);
const NEED_HEADER = process.env.FAKE_NEED_HEADER || "";
const MODERN = "2026-07-28";
const SESSION_ID = "fake-session-1";

let pushCount = 0;
const legacyStreams = new Set();

function body() {
  const status = pushCount >= FLIP_AFTER ? "turn.completed" : "turn.in_progress";
  return JSON.stringify({ pushCount, events: [{ "type": status }] }, null, 2);
}

function sendJson(res, payload, extraHeaders = {}) {
  const text = JSON.stringify(payload);
  res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...extraHeaders });
  res.end(text);
}

function sseHead(res, extraHeaders = {}) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...extraHeaders,
  });
  // writeHead 只是把响应头记下来,不会真发出去;不 flush 的话客户端会一直等,
  // 以为连接还没建立。真实的 SSE 服务端也都会立刻发点东西。
  res.flushHeaders();
}

function sseSend(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function checkAuth(req, res) {
  if (!NEED_HEADER) return true;
  const at = NEED_HEADER.indexOf(":");
  const name = NEED_HEADER.slice(0, at).trim().toLowerCase();
  const want = NEED_HEADER.slice(at + 1).trim();
  if (req.headers[name] === want) return true;
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "缺少或错误的鉴权头" }));
  return false;
}

function startPushing(send, uri) {
  const timer = setInterval(() => {
    pushCount += 1;
    send({
      jsonrpc: "2.0",
      method: "notifications/resources/updated",
      params: { uri, ...(GENERATION === "modern" ? {} : {}) },
    });
    if (pushCount > FLIP_AFTER + 8) clearInterval(timer);
  }, PUSH_EVERY_MS);
  timer.unref?.();
  return timer;
}

const server = http.createServer((req, res) => {
  if (!checkAuth(req, res)) return;

  // 老协议:服务端到客户端的消息走另开的一条 GET SSE 流。
  if (req.method === "GET") {
    if (GENERATION !== "legacy") { res.writeHead(405).end(); return; }
    sseHead(res);
    legacyStreams.add(res);
    res.on("close", () => legacyStreams.delete(res));
    return;
  }

  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    let message;
    try { message = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
    const { id, method, params } = message;

    if (GENERATION === "modern" && req.headers["mcp-protocol-version"] !== MODERN) {
      sendJson(res, { jsonrpc: "2.0", id, error: { code: -32022, message: "缺少或不匹配的 MCP-Protocol-Version 头" } });
      return;
    }

    if (method === "server/discover") {
      if (GENERATION !== "modern") {
        sendJson(res, { jsonrpc: "2.0", id, error: { code: -32601, message: "方法不存在" } });
        return;
      }
      sendJson(res, {
        jsonrpc: "2.0",
        id,
        result: {
          resultType: "complete",
          supportedVersions: [MODERN],
          capabilities: { resources: {} },
          _meta: { "io.modelcontextprotocol/serverInfo": { name: "fake-http-modern", version: "1.0.0" } },
        },
      });
      return;
    }

    if (method === "initialize") {
      sendJson(res, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { resources: { subscribe: true } },
          serverInfo: { name: "fake-http-legacy", version: "1.0.0" },
        },
      }, { "mcp-session-id": SESSION_ID });
      return;
    }

    if (method === "notifications/initialized") { res.writeHead(202).end(); return; }

    if (method === "resources/subscribe") {
      if (GENERATION !== "legacy") {
        sendJson(res, { jsonrpc: "2.0", id, error: { code: -32601, message: "方法不存在" } });
        return;
      }
      if (req.headers["mcp-session-id"] !== SESSION_ID) {
        sendJson(res, { jsonrpc: "2.0", id, error: { code: -32000, message: "缺少 Mcp-Session-Id" } });
        return;
      }
      sendJson(res, { jsonrpc: "2.0", id, result: {} });
      startPushing((payload) => { for (const stream of legacyStreams) sseSend(stream, payload); }, params?.uri);
      return;
    }

    if (method === "subscriptions/listen") {
      if (GENERATION !== "modern") {
        sendJson(res, { jsonrpc: "2.0", id, error: { code: -32601, message: "方法不存在" } });
        return;
      }
      const uri = params?.notifications?.resourceSubscriptions?.[0];
      sseHead(res);
      sseSend(res, {
        jsonrpc: "2.0",
        method: "notifications/subscriptions/acknowledged",
        params: {
          _meta: { "io.modelcontextprotocol/subscriptionId": id },
          notifications: { resourceSubscriptions: [uri] },
        },
      });
      // 注意监听的是 res 不是 req:POST 的请求体读完后 req 会立刻触发 close,
      // 拿它当「连接断了」用会把推送定时器当场清掉,一条都推不出去。
      const timer = startPushing((payload) => sseSend(res, payload), uri);
      res.on("close", () => clearInterval(timer));
      return;
    }

    if (method === "resources/read") {
      sendJson(res, {
        jsonrpc: "2.0",
        id,
        result: { contents: [{ uri: params?.uri, mimeType: "application/json", text: body() }] },
      });
      return;
    }

    sendJson(res, { jsonrpc: "2.0", id, error: { code: -32601, message: `方法不存在:${method}` } });
  });
});

server.listen(Number(process.env.FAKE_PORT || 0), "127.0.0.1", () => {
  process.stdout.write(`LISTENING ${server.address().port}\n`);
});
