# mcp-wake

> [English](README.md) · **中文**

订阅一个 MCP 资源，把「服务端发生了事」变成「本地进程退出了」——或者「打印了一行」。

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
启动 MCP 服务器（stdio）
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
node install.mjs
```

装出一个全局 `mcp-wake`。安装脚本刻意先打成 tar 包再装那个包，而不是 `npm i -g <目录>`——目录装法装出来是**软链**，命令仍然指着源码目录，你一挪仓库、一删、一换分支它就断。tar 包装法是**真拷贝**。

全局位置跟你安装时用的 Node 版本绑定；换了 Node 版本它看起来像消失了，重装一次即可。

## 用法

```bash
mcp-wake --server "<启动 MCP 服务器的命令>" \
         --resource "<资源地址>" \
         [--match "<正则>"] [--mode once|stream]
```

守望一个 Codex 对话，轮次跑完就叫醒我：

```bash
mcp-wake \
  --server "node /路径/codex-conversation-bridge-mcp.mjs" \
  --resource "codex-conversation:///v1/conversations/cv_xxx/events?since=0" \
  --match '"type":\s*"turn\.(completed|failed|cancelled)"' \
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
| `--server <命令>` | **必填。** 要启动的 MCP 服务器命令，整串（含参数） |
| `--resource <uri>` | **必填。** 要订阅的资源地址 |
| `--mode once\|stream` | 默认 `once` |
| `--match <正则>` | 只有正文匹配才算命中 |
| `--until <正则>` | 仅 `stream`：正文匹配就收尾退出 |
| `--timeout-minutes <分钟>` | 默认 30，可传小数 |
| `--cwd <目录>` | 被启动服务器的工作目录 |
| `--print-content` | 命中时把资源正文一并输出 |
| `--trace` | 往标准错误打印握手／订阅／读取的过程 |

## 前提条件

MCP 服务器必须在握手时声明 `capabilities.resources.subscribe`。没声明的话，`mcp-wake` 会直接说清楚并退出，而不是傻等一个永远不会来的推送。

当前传输是 **stdio**——`mcp-wake` 自己把服务器启动起来。等哪个服务器能走 MCP 的 HTTP 传输，只需要给 `src/mcp-client.mjs` 补一个同样接口的实现；守望逻辑与传输无关。

## 参与

欢迎提 issue 和 pull request。代码量刻意保持很小，零第三方依赖，只用 Node 内置模块。

## 许可证

[MIT](LICENSE)
