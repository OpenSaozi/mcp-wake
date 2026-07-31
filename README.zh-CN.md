# mcp-wake

> [English](README.md) · **中文**

Claude Code 这类客户端对 MCP 的支持并不完整。通过 MCP 派一个长任务出去——比如指挥 Codex 干活——你没法订阅服务端的事件，也就拿不到任务的最新进展。

**`mcp-wake` 按 MCP 标准协议实现了这个通知订阅能力，替客户端补上这块缺口**，让 Claude Code 或者任何其他客户端都能收到服务端的消息。它把服务端的推送变成每个 AI 代理运行环境本来就认得的信号：一个会退出的进程，或者一行输出。

## 为什么需要它

绝大多数 AI 代理运行环境，只有两种被叫醒的方式：

1. **某个后台进程退出了**
2. **某个进程打印了一行**

就这两种。它们没有「订阅服务端推送」这个入口。

**这不是 MCP 的毛病。** 协议本身有一条挺好的推送通道：客户端调 `resources/subscribe`，服务端发 `notifications/resources/updated`。缺口在**客户端**——很多运行环境只实现了 MCP 的一部分，而服务端主动发来的通知恰恰是最常被省掉的那部分。客户端能**读**资源，却不能**订阅**资源，于是服务端老老实实推出去的通知，永远到不了代理手里。

实际后果就是：每当需要让代理异步地知道点什么——长任务跑完了、有审批要批了、构建挂了——总得有人再手写一遍同样脆弱的胶水。

`mcp-wake` 就是那段胶水，写一次。它是一个**真正的 MCP 客户端**，讲标准协议，而且不认识任何一个具体的服务器。

## 它怎么工作

```
连上 MCP 服务器（一个远程地址，或本地起一个进程走 stdio）
  → 握手 initialize
  → resources/subscribe 订阅
  → 等 notifications/resources/updated 推送
  → 收到推送后 resources/read 拿正文
  → 正文是不是你在等的？
       once   → 退出
       stream → 打印一行，继续等
```

两个值得知道的设计点：

- **MCP 的推送不带正文。** `notifications/resources/updated` 只告诉你「这个资源变了」，不告诉你变成什么样。回头读一次是协议要求的第二步，不是多余的开销。
- **订阅之后立刻先读一次。** 订阅只对「订阅之后的变化」负责；不先读一次，你要等的事情如果在订阅前就已经发生，就永远等不到了。

## 安装

```bash
npm install -g mcp-wake
```

不想装也可以直接跑：

```bash
npx mcp-wake --help
```

<details>
<summary>从源码目录安装</summary>

```bash
node install.mjs
```

这个脚本刻意先打成 tar 包再装那个包，而不是 `npm i -g <目录>`——目录装法装出来是**软链**，命令仍然指着源码目录，你一挪仓库、一删、一换分支它就断。tar 包装法是**真拷贝**。

</details>

不管哪种装法都要知道一件事：全局位置跟**你安装时用的那个 Node 版本**绑定。换了 Node 版本命令看起来像消失了，重装一次即可。

## 用法

```bash
mcp-wake --server "<启动 MCP 服务器的命令>" \
         --resource "<资源地址>" \
         [--match "<正则>"] [--mode once|stream]
```

起一个本地 MCP 服务器（走 stdio），守望其中一项长任务，跑完就叫醒我：

```bash
mcp-wake \
  --server "node ./my-mcp-server.mjs" \
  --resource "jobs:///builds/42" \
  --match '"state":\s*"(succeeded|failed)"' \
  --timeout-minutes 150
```

放后台跑，它退出就是通知。

想要**每发生一件事叫一声**（比如中途的审批也要叫），用 `--mode stream`。每命中一次严格打印一行，直到 `--until` 命中或者超时。一次一行是刻意的：对某些调用方来说，**每一行输出就是一条通知**。

## 匹配规则

`--match` 是对资源正文做的**正则匹配**。刻意做得这么笨：这个工具不认识任何一种资源的内部结构，也不该认识。你最清楚自己在等什么。

**注意空格。** 很多服务器返回的是带缩进的 JSON，正文里是 `"type": "turn.completed"`，冒号后面有空格。所以要写 `"type":\s*"turn\.completed"`，不能写 `"type":"turn.completed"`。这个坑每个人都会踩一次。

不传 `--match` 就是任何变化都叫醒你。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 命中并收尾 |
| 3 | 超时 |
| 1 | 出错——服务器起不来、订阅被拒、连接断了 |

每一种结局都是明确的信号。它绝不会安安静静地待着，让你分不清是还在干活还是早就死了。

## 选项

| 选项 | 说明 |
|---|---|
| `--url <地址>` | **二选一。** 远程 MCP 服务器的 HTTP 端点 |
| `--server <命令>` | **二选一。** 本地 MCP 服务器命令（走 stdio），整串含参数 |
| `--resource <uri>` | **必填。** 要订阅的资源地址 |
| `--header <名: 值>` | 仅 `--url`，可重复。鉴权就靠它 |
| `--mode once\|stream` | 默认 `once` |
| `--match <正则>` | 只有正文匹配才算命中 |
| `--until <正则>` | 仅 `stream`：正文匹配就收尾退出 |
| `--timeout-minutes <分钟>` | 默认 30，可传小数 |
| `--cwd <目录>` | 被启动服务器的工作目录 |
| `--print-content` | 命中时把资源正文一并输出 |
| `--trace` | 往标准错误打印握手／订阅／读取的过程 |

## 传输方式：远程和本地都行

一个参数决定走哪种。

**远程，走 MCP 的 HTTP 传输**——本地除了 `mcp-wake` 自己，什么都不用跑：

```bash
mcp-wake --url https://example.com/mcp \
         --header "Authorization: Bearer $TOKEN" \
         --resource "task:///jobs/123" \
         --match '"status":\s*"(done|failed)"'
```

`--header` 可以重复给，鉴权就靠它。

**本地，走 stdio**——`mcp-wake` 自己把服务器启动起来：

```bash
mcp-wake --server "node ./某个-mcp-server.mjs" --resource "..."
```

`--url` 和 `--server` 给且只给一个。

## 什么样的服务器能被守望

**不是所有 MCP 服务器都行。** 资源订阅在 MCP 里是**可选能力**——一个只提供工具（tools）的服务器完全合规，但就是没法被守望。硬要求只有一条：**你关心的东西必须以「资源」暴露出来，而且这个资源支持订阅**。服务器不提供这个，`mcp-wake` 会当场说清并退出，而不是傻等一个永远不会来的推送。

具体到方法，服务器必须实现：

| | 老协议 | `2026-07-28` |
|---|---|---|
| 声明 | `capabilities.resources.subscribe: true` | `server/discover` |
| 订阅 | `resources/subscribe` | `subscriptions/listen` |
| 推送 | `notifications/resources/updated` | 同左，但之前要先发确认回执 |
| 读取 | `resources/read` | 同左 |

## 协议兼容

`mcp-wake` **两代 MCP 协议都会说**，而且自动挑对的那条。

`2026-07-28` 那版把 MCP 改成了无状态：去掉 `initialize` 握手，协议版本和客户端能力改成每个请求都放在 `_meta` 里，订阅也从 `resources/subscribe` 换成了长连的 `subscriptions/listen`。规范预料到了新老混杂的局面，并且规定了办法：在 stdio 上，先发 `server/discover` 探一下。

启动时就是这么干的：

| 服务器认不认 `server/discover` | 接下来 |
|---|---|
| 认 → 是 `2026-07-28` 那代 | 每个请求都带 `_meta`；用 `subscriptions/listen` 订阅，并**核对确认回执里真的有你要的资源** |
| 不认（方法不存在）→ 是老一代 | 退回 `initialize` 握手 + `resources/subscribe` |

两条路出来的行为一模一样。加 `--trace` 能看到探到的是哪一代。

**两代各自的前提：**

- 老服务器必须声明 `capabilities.resources.subscribe`。没声明就直接说清并退出，不傻等一个永远不会来的推送。
- `2026-07-28` 服务器必须在 `notifications/subscriptions/acknowledged` 回执里列出你要的资源地址。规范允许服务端只答应一部分，所以这里是**核对**，不是想当然。

两条路都有真实测试覆盖。`test/fake-modern-server.mjs` 是照着规范原文搭的最小 `2026-07-28` 服务器——写这个工具的时候还没有真的新协议服务器，而把没验证过的协议代码直接发出去，比搭个替身更糟。

两种传输都有真实测试覆盖：`test/fake-modern-server.mjs`（stdio）和 `test/fake-http-server.mjs`（HTTP，两代协议都能扮）。跑 `node test/http-e2e.mjs` 即可。

## 参与

欢迎提 issue 和 pull request。代码量刻意保持很小，零第三方依赖，只用 Node 内置模块。

## 许可证

[MIT](LICENSE)
