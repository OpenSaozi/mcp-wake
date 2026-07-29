#!/usr/bin/env node
// HTTP 传输的端到端测试:起一个假服务器,等它真的在听,再用 mcp-wake 连它。
//
// 在同一个 Node 进程里等「LISTENING <端口>」这行就绪信号,不靠 shell 里 sleep 几秒
// 猜时机 —— 那种写法在慢机器上会假失败,在快机器上会假通过。
//
// 跑法:node test/http-e2e.mjs

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const cli = path.join(projectRoot, "bin", "mcp-wake.mjs");
const fakeServer = path.join(here, "fake-http-server.mjs");

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`  ${ok ? "✅" : "❌"} ${label}（退出码 ${actual}${ok ? "" : `，应为 ${expected}`}）`);
  if (ok) passed += 1;
  else failed += 1;
}

/** 起假服务器,等它打印出真实端口再返回。 */
function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fakeServer], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("假服务器 10 秒内没报告端口"));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const match = buffer.match(/LISTENING (\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve({ child, port: Number(match[1]) });
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`假服务器提前退出，码 ${code}`)); });
  });
}

function runWake(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("exit", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

async function withServer(env, run) {
  const { child, port } = await startServer(env);
  try {
    return await run(port);
  } finally {
    child.kill();
  }
}

const MATCH = String.raw`"type":\s*"turn\.completed"`;

console.log("=== HTTP 传输端到端 ===");

// 新协议:每个消息一次 POST,subscriptions/listen 的响应体就是 SSE 流。
await withServer({ FAKE_GENERATION: "modern" }, async (port) => {
  const result = await runWake([
    "--url", `http://127.0.0.1:${port}`,
    "--resource", "task:///job1",
    "--match", MATCH,
    "--timeout-minutes", "0.5",
    "--trace",
  ]);
  check("新协议 2026-07-28：连上、订阅、收推送、命中收尾", result.code, 0);
  const modern = /"generation":"modern"/.test(result.err);
  console.log(`  ${modern ? "✅" : "❌"} 探针把它认成了新协议`);
  modern ? (passed += 1) : (failed += 1);
});

// 老协议:POST 发请求 + 另开一条 GET SSE 流收推送,还要回传 Mcp-Session-Id。
await withServer({ FAKE_GENERATION: "legacy" }, async (port) => {
  const result = await runWake([
    "--url", `http://127.0.0.1:${port}`,
    "--resource", "task:///job1",
    "--match", MATCH,
    "--timeout-minutes", "0.5",
    "--trace",
  ]);
  check("老协议 2025-06-18：探针被拒后退回握手、GET 流收推送、命中收尾", result.code, 0);
  const legacy = /"generation":"legacy"/.test(result.err);
  console.log(`  ${legacy ? "✅" : "❌"} 探针把它认成了老协议`);
  legacy ? (passed += 1) : (failed += 1);
});

// 鉴权头:服务器要求带头,不带就 401。
await withServer({ FAKE_GENERATION: "modern", FAKE_NEED_HEADER: "authorization: Bearer s3cret" }, async (port) => {
  const missing = await runWake([
    "--url", `http://127.0.0.1:${port}`, "--resource", "task:///job1", "--timeout-minutes", "0.2",
  ]);
  check("不带鉴权头 → 明确报错", missing.code, 1);
  const withHeader = await runWake([
    "--url", `http://127.0.0.1:${port}`,
    "--header", "Authorization: Bearer s3cret",
    "--resource", "task:///job1",
    "--match", MATCH,
    "--timeout-minutes", "0.5",
  ]);
  check("带上鉴权头 → 正常命中收尾", withHeader.code, 0);
});

// 地址存在但没人应答。
{
  const result = await runWake([
    "--url", "http://127.0.0.1:9", "--resource", "task:///job1", "--timeout-minutes", "0.2",
  ]);
  check("连不上远端 → 明确报错", result.code, 1);
}

console.log(`\n结果:${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
