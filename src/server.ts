/**
 * Waitrose MCP server: streamable HTTP transport, bearer-token auth,
 * lazy Waitrose login. Single-user, personal use.
 *
 * Env:
 *   WAITROSE_EMAIL, WAITROSE_PASSWORD  - Waitrose account credentials (required for API calls)
 *   MCP_AUTH_TOKEN                     - bearer token clients must send; required unless
 *                                        ALLOW_INSECURE_NO_AUTH=1 (localhost-only use)
 *   WAITROSE_ENABLE_WRITES=true        - register trolley write tools (default: read-only)
 *   WAITROSE_ENABLE_SLOT_BOOKING=true  - register slot booking when writes are enabled
 *   PORT                               - listen port (default 3000)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import WaitroseClient from "./waitrose.js";
import { activeTools, type ToolContext } from "./tools.js";

const SERVER_INSTRUCTIONS =
  "Waitrose grocery tools. Typical sequence: waitrose_search to find products and line numbers, then (when writes are enabled and the user has confirmed the exact items) waitrose_add_to_trolley. Check waitrose_list_slot_days / waitrose_get_current_slot for delivery timing. Never place orders: final checkout is manual in the Waitrose app. Waitrose slot bookings and trolley changes affect the user's real account; always confirm details with the user before write tools.";

class LoginError extends Error {}

export function createContext(): ToolContext {
  const client = new WaitroseClient();
  let loggedIn = false;
  let loggingIn: Promise<void> | null = null;

  const doLogin = async () => {
    const email = process.env.WAITROSE_EMAIL;
    const password = process.env.WAITROSE_PASSWORD;
    if (!email || !password) {
      throw new LoginError(
        "Waitrose credentials not configured. Set WAITROSE_EMAIL and WAITROSE_PASSWORD in the server environment."
      );
    }
    try {
      await client.login(email, password);
      if (!client.isAuthenticated()) throw new Error("Missing Waitrose session");
    } catch {
      throw new LoginError("Waitrose login failed. Check your account and server credentials.");
    }
    loggedIn = true;
  };

  return {
    client,
    ensureLoggedIn: async () => {
      if (loggedIn) return;
      if (!loggingIn) {
        loggingIn = doLogin().finally(() => {
          loggingIn = null;
        });
      }
      await loggingIn;
    },
  };
}

export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: "waitrose", version: "0.2.2" },
    { instructions: SERVER_INSTRUCTIONS }
  );

  for (const tool of activeTools()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema,
        annotations: tool.annotations,
      },
      async (args) => {
        try {
          return (await tool.handler(ctx, args)) as any;
        } catch (err) {
          // Upstream exceptions can contain entire response bodies, including account data.
          const message = err instanceof LoginError ? err.message
            : tool.annotations.readOnlyHint
              ? "Waitrose could not complete this request. If the session expired, restart the server to sign in again."
              : "Waitrose could not confirm this change. Check the Waitrose app before trying again.";
          return {
            isError: true,
            content: [{ type: "text" as const, text: message }],
          };
        }
      }
    );
  }
  return server;
}

function respondError(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

export function startHttp(port = Number(process.env.PORT ?? 3000)) {
  // Bind localhost by default: the expected deployments are a local tunnel
  // client or a TLS/OAuth-terminating proxy on the same host. Set HOST to
  // override (e.g. 0.0.0.0 inside a container with its own network policy).
  const host = process.env.HOST ?? "127.0.0.1";
  const token = process.env.MCP_AUTH_TOKEN;
  const expectedAuth = token ? Buffer.from(`Bearer ${token}`) : null;
  if (!expectedAuth) {
    if (process.env.ALLOW_INSECURE_NO_AUTH !== "1") {
      throw new Error("Set MCP_AUTH_TOKEN, or explicitly enable local-only ALLOW_INSECURE_NO_AUTH=1.");
    }
    if (host !== "127.0.0.1" && host !== "::1") {
      throw new Error("ALLOW_INSECURE_NO_AUTH requires HOST=127.0.0.1 or HOST=::1.");
    }
  }
  const ctx = createContext();
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = req.url?.split("?", 1)[0];
    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, writes: process.env.WAITROSE_ENABLE_WRITES === "true", slotBooking: process.env.WAITROSE_ENABLE_SLOT_BOOKING === "true" && process.env.WAITROSE_ENABLE_WRITES === "true" }));
      return;
    }
    if (path !== "/mcp") {
      res.writeHead(404).end("Not found. MCP endpoint is /mcp");
      return;
    }
    // Only native and server-side clients are supported. A web page must
    // never use a local unauthenticated MCP endpoint via DNS rebinding.
    if (req.headers.origin !== undefined) {
      respondError(res, 403, "Browser origins are not accepted by this MCP server.");
      return;
    }
    if (expectedAuth) {
      const suppliedAuth = Buffer.from(req.headers.authorization ?? "");
      if (suppliedAuth.length !== expectedAuth.length || !timingSafeEqual(suppliedAuth, expectedAuth)) {
        respondError(res, 401, "Unauthorized: missing or wrong bearer token.");
        return;
      }
    } else {
      const loopbackHost = host === "::1" ? "[::1]" : host;
      const requestHost = req.headers.host?.toLowerCase();
      const localPort = req.socket.localPort;
      const isLocalHost = [loopbackHost, "localhost"].some((name) =>
        requestHost === `${name}:${localPort}` || (localPort === 80 && requestHost === name));
      if (!isLocalHost) {
        respondError(res, 403, "Host must match the loopback MCP endpoint.");
        return;
      }
    }
    // Stateless streamable HTTP: one transport + server per request.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildMcpServer(ctx);
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  httpServer.listen(port, host, () => {
    const writes = process.env.WAITROSE_ENABLE_WRITES === "true";
    const slots = writes && process.env.WAITROSE_ENABLE_SLOT_BOOKING === "true";
    console.log(
      `waitrose-mcp listening on ${host === "::1" ? "[::1]" : host}:${(httpServer.address() as { port: number }).port} /mcp (read tools: 8, trolley write tools: ${writes ? "3 ENABLED" : "disabled"}, slot booking: ${slots ? "ENABLED" : "disabled"})`
    );
  });
  return httpServer;
}

// Run directly: node dist/src/server.js
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) startHttp();
