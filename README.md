# mcp-wake

> **English** · [中文](README.zh-CN.md)

Subscribe to an MCP resource. Turn *"something happened on the server"* into *"a local process exited"* — or *"a line got printed."*

## Why this exists

Most agent harnesses can only be woken up in two ways:

1. **A background process exits.**
2. **A process prints a line.**

That is the entire vocabulary. There is no "subscribe to a server push" entry point.

This is **not** a gap in MCP. The protocol has a perfectly good push channel: the client calls `resources/subscribe`, the server sends `notifications/resources/updated`. The gap is on the **client** side — many harnesses implement MCP only partially, and server-initiated notifications are the usual casualty. The client can *read* a resource but cannot *subscribe* to one, so a notification the server dutifully emits never reaches the agent.

The practical consequence: every time an agent needs to learn about something asynchronously — a long job finishing, an approval request appearing, a build going red — somebody hand-writes the same fragile glue again.

`mcp-wake` is that glue, written once. It is a real MCP client, speaking the standard protocol, and it knows nothing about any particular server.

## How it works

```
spawn the MCP server (stdio)
  → initialize
  → resources/subscribe
  → wait for notifications/resources/updated
  → resources/read to get the actual content
  → does it match what you're waiting for?
       once   → exit
       stream → print one line, keep waiting
```

Two design notes worth knowing:

- **MCP pushes carry no payload.** `notifications/resources/updated` only tells you *that* a resource changed, not *what* changed. Reading it back is a required second step, not an inefficiency.
- **It reads once immediately after subscribing.** A subscription only covers changes from that moment on, so without an initial read you would miss anything that already happened.

## Install

```bash
node install.mjs
```

Installs a global `mcp-wake`. The installer packs a tarball first and installs *that*, rather than `npm i -g <folder>` — a folder install creates a symlink back into the source tree, so the command breaks the moment you move, delete, or switch branches on the repo. A tarball install is a real copy.

The global location is tied to the Node version you installed under; switch Node versions and it appears to vanish. Just install again.

## Usage

```bash
mcp-wake --server "<command to launch an MCP server>" \
         --resource "<resource uri>" \
         [--match "<regex>"] [--mode once|stream]
```

Watch a Codex conversation and wake when the turn ends:

```bash
mcp-wake \
  --server "node /path/to/codex-conversation-bridge-mcp.mjs" \
  --resource "codex-conversation:///v1/conversations/cv_xxx/events?since=0" \
  --match '"type":\s*"turn\.(completed|failed|cancelled)"' \
  --timeout-minutes 150
```

Run it in the background; when it exits, your harness notifies you.

For per-event notifications instead — including mid-flight approvals — use `--mode stream`. It prints exactly one line per match and keeps watching until `--until` matches or the timeout hits. One line per notification is deliberate: for some callers, every printed line *is* a notification.

## Matching

`--match` is a regular expression applied to the resource's text content. That is intentionally dumb: this tool does not understand any resource's internal structure, and should not. You know what you are waiting for.

**Mind the whitespace.** Many servers return pretty-printed JSON, so the text is `"type": "turn.completed"` with a space. Write `"type":\s*"turn\.completed"`, not `"type":"turn.completed"`. This bites everyone once.

Omit `--match` entirely and any change wakes you.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Matched and finished |
| 3 | Timed out |
| 1 | Error — server wouldn't start, subscription refused, connection dropped |

Every outcome is an explicit signal. The tool never simply goes quiet and leaves you guessing whether it is still working or long dead.

## Options

| Option | Description |
|---|---|
| `--server <command>` | **Required.** The MCP server command to launch, as one string including arguments |
| `--resource <uri>` | **Required.** The resource URI to subscribe to |
| `--mode once\|stream` | Default `once` |
| `--match <regex>` | Only a matching resource body counts as a hit |
| `--until <regex>` | `stream` only: stop and exit when the body matches |
| `--timeout-minutes <n>` | Default 30; accepts fractions |
| `--cwd <dir>` | Working directory for the spawned server |
| `--print-content` | Include the resource body in the output |
| `--trace` | Print handshake / subscribe / read progress to stderr |

## Requirements

The MCP server must declare `capabilities.resources.subscribe` during initialize. If it does not, `mcp-wake` says so and exits rather than waiting forever for a push that can never arrive.

Transport today is **stdio** — `mcp-wake` launches the server itself. When a server is reachable over MCP's HTTP transport, only `src/mcp-client.mjs` needs a sibling implementation; the watch logic is transport-agnostic.

## Contributing

Issues and pull requests welcome. The codebase is deliberately small, has zero third-party dependencies, and uses only Node built-ins.

## License

[MIT](LICENSE)
