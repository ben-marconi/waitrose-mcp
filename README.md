# waitrose-mcp

An unofficial, self-hosted MCP server for shopping on your own Waitrose
account. The source code is public; run the server privately. It uses the
Waitrose mobile app API through the vendored
[jonastemplestein/waitrose](https://github.com/jonastemplestein/waitrose)
client ([MIT license](LICENSE-UPSTREAM-waitrose)). This project is not
affiliated with or endorsed by Waitrose.

**Checkout stays in Waitrose.** The MCP server exposes no tools for placing,
paying for, cancelling, or starting an amendment of an order. Trolley and
slot writes, when enabled, can affect the account's active trolley or an
order already being amended in Waitrose.

## Terms of use

The server uses a private API that Waitrose can change or block at any time.
Check Waitrose's terms before use and keep requests infrequent. It is intended
for personal use on your own account.

## Tools

Read tools are always available.

| Tool | What it does |
|---|---|
| `waitrose_search` | Search the catalogue for names, prices, sizes and line numbers |
| `waitrose_browse` | Browse categories (start at `10051` for Groceries) |
| `waitrose_product_details` | View product details, including ingredients and nutrition where available |
| `waitrose_get_trolley` | View the current trolley, totals and conflicts |
| `waitrose_list_orders` / `waitrose_get_order` | View pending and past orders |
| `waitrose_get_current_slot` | View the booked delivery or collection slot |
| `waitrose_list_slot_days` | List available slots and charges |

Write tools are disabled by default. Their MCP annotations identify them as
writes; confirmation behavior depends on the client. Confirm the exact change
before running one. Check the Waitrose app before retrying a write that
returned an error.

| Tool | Required setting | What it changes |
|---|---|---|
| `waitrose_add_to_trolley` | `WAITROSE_ENABLE_WRITES=true` | Adds items to the trolley |
| `waitrose_update_trolley_item` | `WAITROSE_ENABLE_WRITES=true` | Changes quantities; zero removes the item |
| `waitrose_remove_from_trolley` | `WAITROSE_ENABLE_WRITES=true` | Removes an item |
| `waitrose_book_slot` | Both write and slot booking flags | Reserves a slot; delivery charges may apply |

## Setup

Use Node.js 22 or later, a Waitrose account and a client that supports MCP
Streamable HTTP.

```bash
npm ci --ignore-scripts
npm run build
cp .env.example .env
```

Edit the ignored `.env` file with your Waitrose login and a random bearer token
(for example, generate one with `openssl rand -hex 32`). Start with both write
flags off.

```bash
node --env-file=.env dist/src/server.js
```

If your environment already supplies the variables, use `npm start` after
building. The default MCP endpoint is `http://127.0.0.1:3000/mcp`; send
`Authorization: Bearer <your token>`. `GET /health` is unauthenticated and
reports only server status and whether write flags are enabled.

| Variable | Meaning |
|---|---|
| `WAITROSE_EMAIL` / `WAITROSE_PASSWORD` | Required for Waitrose calls. The server signs in lazily; restart it to refresh an expired session. |
| `MCP_AUTH_TOKEN` | Required unless the loopback only mode below is enabled. |
| `WAITROSE_ENABLE_WRITES` | Set to `true` to enable trolley writes. |
| `WAITROSE_ENABLE_SLOT_BOOKING` | Set to `true` alongside writes to enable booking. Leave off until you intend to reserve a real slot. |
| `HOST` / `PORT` | Defaults: `127.0.0.1` and `3000`. |
| `ALLOW_INSECURE_NO_AUTH` | Set to `1` and remove the bearer token only when a trusted tunnel or proxy handles access. Requires a loopback host (`127.0.0.1` or `::1`). Other processes on the machine can still access the listener. |

The server accepts native clients and server-to-server connections. It rejects
browser requests with an `Origin` header. In loopback only mode the client or
proxy must send the local endpoint's hostname and port as the `Host` header.

## Connecting from ChatGPT

Follow OpenAI's [custom MCP server setup](https://developers.openai.com/plugins/deploy/connect-chatgpt),
subject to your account and workspace policies. For a private server, use a
[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
to the loopback endpoint. If your client cannot supply a static bearer token,
let the authenticated tunnel or an OAuth proxy control access and use the
loopback only mode for the local connection. Avoid exposing the upstream
listener directly: even read tools return private account data.

## Testing

Run `npm test` after `npm ci --ignore-scripts`. The suite drives the MCP server
over local HTTP with a mocked Waitrose API. It checks authentication, write
gates, login, search, trolley reads and writes, and slot listing and booking.
CI runs it on Node.js 22 and 24.

Live Waitrose compatibility has not been verified. Start with both write flags
off and compare results from `waitrose_search`, `waitrose_get_trolley`, and
`waitrose_list_slot_days` with the Waitrose app. For a separate trolley write
check, use a product that is not already in the trolley and only test when no
order is being amended. Add one, verify it in Waitrose, then remove it and
verify the trolley returned to its starting state. Booking a slot is not a
routine smoke test.

## Files

- [Vendored Waitrose client](src/waitrose.ts)
- [Tool registry and write gates](src/tools.ts)
- [HTTP transport, authentication and login](src/server.ts)
- [MCP integration tests](test/server.test.ts)
