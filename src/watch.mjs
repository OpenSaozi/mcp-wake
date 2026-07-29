import { McpError, McpStdioClient } from "./mcp-client.mjs";

/**
 * 守望一个 MCP 资源。
 *
 * 流程就是标准 MCP 那一套,没有任何私货:
 *   握手 → resources/subscribe → 等 notifications/resources/updated
 *        → 收到推送就 resources/read 拿正文 → 按规则判断要不要叫醒
 *
 * 判断规则刻意做成「对正文做正则匹配」而不是某种查询语言:
 * 这个工具不认识任何一种资源的内部结构,也不该认识。调用方最清楚自己在等什么。
 */

export const EXIT = {
  woke: 0,        // 命中了,正常收尾
  error: 1,       // 出错:服务器起不来、订阅被拒、连接断了
  timeout: 3,     // 到点了还没等到
};

function nowIso(at = Date.now()) {
  return new Date(at).toISOString();
}

export async function watchResource(config, { onWake, onFinish, onTrace }) {
  const deadlineAt = Date.now() + config.timeoutMinutes * 60_000;
  let serverGone = null;

  const client = new McpStdioClient({
    command: config.serverCommand,
    args: config.serverArgs,
    cwd: config.cwd,
    onServerGone: (reason) => { serverGone = reason; },
  });

  let timer = null;
  let settle = null;
  const finished = new Promise((resolve) => { settle = resolve; });
  const finish = (reason, extra = {}) => {
    if (!settle) return;
    const done = settle;
    settle = null;
    if (timer) clearTimeout(timer);
    done({ reason, ...extra });
  };

  client.start();

  const offNotification = client.onNotification((message) => {
    if (message.method !== "notifications/resources/updated") {
      onTrace?.({ kind: "notification", method: message.method });
      return;
    }
    // 推送只说「这个资源变了」,不带正文 —— 这是 MCP 的设计。要详情得自己去读。
    if (message.params?.uri && message.params.uri !== config.resourceUri) return;
    void handlePush();
  });

  let reading = false;
  let pendingPush = false;
  async function handlePush() {
    // 推送可能密集到来;同一时刻只读一次,读完如果期间又有推送就再读一遍,
    // 既不漏最新状态,也不会把服务器读爆。
    if (reading) { pendingPush = true; return; }
    reading = true;
    try {
      do {
        pendingPush = false;
        const text = await client.readResourceText(config.resourceUri);
        onTrace?.({ kind: "read", bytes: text.length });
        if (config.match && !config.match.test(text)) continue;
        const hit = { at: nowIso(), text };
        if (config.mode === "once") { finish("woke", hit); return; }
        onWake?.(hit);
        if (config.until && config.until.test(text)) { finish("woke", hit); return; }
      } while (pendingPush);
    } catch (error) {
      finish("error", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      reading = false;
    }
  }

  try {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return { reason: "timeout" };
    timer = setTimeout(() => finish("timeout"), remaining);

    // 先探一下对面说哪一代协议(server/discover),探不到就退回老握手。
    const server = await client.connect();
    onTrace?.({
      kind: "connected",
      generation: server.generation,
      server: server.serverInfo?.name ?? null,
      versions: server.supportedVersions,
    });
    // 老协议靠 initialize 声明的能力位判断;新协议没有这个位,
    // 能不能订阅要看 subscriptions/listen 的确认回执,所以这里只拦老协议。
    if (server.generation === "legacy" && !server.capabilities?.resources?.subscribe) {
      throw new McpError(
        `这个 MCP 服务器没有声明资源订阅能力(capabilities.resources.subscribe)，`
          + `无法守望。服务器:${server.serverInfo?.name ?? "未知"}`,
      );
    }
    const subscription = await client.subscribeResource(config.resourceUri);
    onTrace?.({
      kind: "subscribed",
      uri: config.resourceUri,
      generation: server.generation,
      subscription_id: subscription.subscriptionId,
    });

    // 订阅只对「订阅之后的变化」负责。先主动读一次,免得要等的事情在订阅前就已经发生了。
    await handlePush();

    const result = await finished;
    if (result.reason === "error") return result;
    if (serverGone && result.reason !== "woke") {
      return { reason: "error", error: `MCP 服务器${serverGone}` };
    }
    return result;
  } catch (error) {
    if (serverGone) return { reason: "error", error: `MCP 服务器${serverGone}` };
    return { reason: "error", error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
    offNotification();
    client.close();
    onFinish?.();
  }
}
