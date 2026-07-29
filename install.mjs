#!/usr/bin/env node
// 一条命令装好 mcp-wake。
//
// 为什么先打包再装,而不是直接 `npm i -g <这个目录>`:
// 实测过,目录装法装出来的是**软链**,全局命令仍然指着这个仓库 —— 仓库一挪、一删、
// 一换分支,命令就断。tar 包装法是**真拷贝**,装完就跟仓库彻底无关了。
//
// 用法:
//   node tools/mcp-wake/install.mjs              装到当前 node 的全局位置
//   node tools/mcp-wake/install.mjs --prefix <目录>   装到指定位置(测试用)

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const prefixIndex = args.indexOf("--prefix");
const prefix = prefixIndex >= 0 ? args[prefixIndex + 1] : undefined;
if (prefixIndex >= 0 && !prefix) fail("--prefix 缺少值");

const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-wake-pack-"));
try {
  const packed = run("npm", ["pack", "--silent", "--pack-destination", stageDir], packageDir)
    .trim()
    .split("\n")
    .pop();
  if (!packed) fail("npm pack 没有产出包名");
  const tarball = path.join(stageDir, path.basename(packed));
  if (!fs.existsSync(tarball)) fail(`打好的包不见了:${tarball}`);

  run("npm", ["i", "-g", ...(prefix ? ["--prefix", prefix] : []), tarball], packageDir);

  const binDir = prefix
    ? path.join(prefix, "bin")
    : run("npm", ["prefix", "-g"], packageDir).trim() + "/bin";
  console.log(`已安装:${path.join(binDir, "mcp-wake")}`);
  console.log("验证:mcp-wake --help");
  if (!prefix) {
    console.log("注意:全局位置跟当前 node 版本绑定,换 node 版本后需要重装。");
  }
} finally {
  fs.rmSync(stageDir, { recursive: true, force: true });
}

function run(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, { cwd, encoding: "utf8" });
  if (result.error) fail(`${command} 执行失败:${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} ${commandArgs.join(" ")} 退出码 ${result.status}\n${result.stderr || result.stdout}`);
  }
  return result.stdout || "";
}

function fail(message) {
  console.error(`安装失败:${message}`);
  process.exit(1);
}
