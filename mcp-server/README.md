# sutra-mcp

A small, **read-only** MCP server that exposes your Sutra memory to AI tools you run on your own
computer. It speaks the Model Context Protocol over stdio (for any MCP client) and bridges to the
Sutra app on your phone over a local, token-paired WebSocket. Nothing is shared until you turn it on
in Sutra and pair this server with the pairing token — and audio never exists to share.

Privacy posture (unchanged from the app): your memory stays on your device. Data leaves the phone
only to this one local process you run, only after you pair it, and only read-only. Redaction and
field-whitelisting are enforced on the phone (the data holder), never trusted to this process.

## What it exposes

Ten read-only tools:

- `search_memory` — ranked memory cards for a query
- `get_conversation` — one conversation's summary, memory, participants, events, minutes, and (if you
  allow transcripts) its turns
- `list_conversations` — recent conversations with summaries, importance, tags, action counts
- `list_people` — people known across your conversations
- `get_graph_neighborhood` — the knowledge graph of people, projects, and topics around an entity
- `list_action_items` — action items by status
- `upcoming_events` — upcoming dated events
- `get_minutes` — meeting minutes for a conversation, if any
- `get_your_context` — standing beliefs you chose to share (may be outdated; not ground truth)
- `ask_memory` — a grounded, cited answer synthesized from your memory

Plus three addressable resources:

- `sutra://privacy` — current privacy mode and the audio-handling promise
- `sutra://conversation/{id}` — same payload as `get_conversation`
- `sutra://daily-rollup/{day}` — the daily summary for a `YYYY-MM-DD` day

All of it is read-only. This server cannot change anything in your memory.

## Build

```sh
npm install
npm run build      # tsc → dist/
```

Develop without a build with `npm run dev` (runs `src/index.ts` via tsx).

## Pairing token

1. In Sutra, open **Settings → External access** and turn on sharing.
2. Reveal the **pairing token** and copy it.
3. Give that token to this server as the `SUTRA_MCP_TOKEN` environment variable (see configs below).

The server proves knowledge of the token to the app, and the app proves it back, before any data
flows. The token is never logged and never appears in any output. Rotate it any time from Settings;
update `SUTRA_MCP_TOKEN` to match.

## Connect your phone to this server

This server listens on `127.0.0.1:8765` and the phone dials in.

**USB (recommended):** with the phone plugged in and USB debugging on, forward the port so the phone's
`localhost:8765` reaches this machine:

```sh
adb reverse tcp:8765 tcp:8765
```

Leave the bridge URL in Sutra at its default `ws://localhost:8765`. Re-run `adb reverse` after each
reconnect or reboot of the phone.

**LAN (no USB):** set the bridge URL in Sutra's External access section to this machine's LAN address,
e.g. `ws://192.168.1.50:8765`, and start the server bound to all interfaces:

```sh
SUTRA_MCP_TOKEN=<token> SUTRA_BRIDGE_HOST=0.0.0.0 sutra-mcp
```

> Caveat: `SUTRA_BRIDGE_HOST=0.0.0.0` exposes the bridge to your whole local network. On connect the
> server presents the pairing token to whoever dials in, so anyone who can reach this port on a trusted
> network learns the token — only enable this on a network you control, and prefer a firewall rule that
> limits inbound `8765` to your phone's IP over relying on the token gate alone. For everyday use, keep
> the default `127.0.0.1` bind and use `adb reverse` (USB) instead.

**Web dev:** the app running at `http://localhost:5173` connects directly to `ws://localhost:8765`
with no forwarding — the same code path, fully testable on a laptop.

## Use it from an MCP client

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "sutra": {
      "command": "node",
      "args": ["/Users/adityapratapsingh/code/Sutra/mcp-server/dist/index.js"],
      "env": {
        "SUTRA_MCP_TOKEN": "<paste the pairing token from Sutra Settings>"
      }
    }
  }
}
```

### Claude Code

```sh
claude mcp add sutra --env SUTRA_MCP_TOKEN=<token> -- node /Users/adityapratapsingh/code/Sutra/mcp-server/dist/index.js
```

(Use the absolute path to your built `dist/index.js`.)

## Environment

| Var | Default | Purpose |
|-----|---------|---------|
| `SUTRA_MCP_TOKEN` | — (required) | Pairing token from Sutra Settings. Missing → the server exits with instructions. |
| `SUTRA_BRIDGE_PORT` | `8765` | Port the phone connects to. |
| `SUTRA_BRIDGE_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only for the LAN flow above. |
| `SUTRA_REQUEST_TIMEOUT_MS` | `30000` | Per-call timeout. `search_memory` and `ask_memory` get a longer budget automatically. |

All logging goes to stderr; stdout carries only the protocol, so the server is safe to launch from an
MCP client.

## Verify

```sh
SUTRA_MCP_TOKEN=<token> npm run e2e
```

Spawns the server, lists the tools and resources, and calls each tool with sample arguments. With no
phone connected it prints a friendly "Phone unreachable" for each call and still exits successfully —
useful for sanity-checking the wiring before you pair a device.
