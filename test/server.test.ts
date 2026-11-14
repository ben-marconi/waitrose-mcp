import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttp } from "../src/server.js";

const nativeFetch = globalThis.fetch;
const token = "test-token";
const authHeaders = { Authorization: `Bearer ${token}` };
const waitroseEmail = "shopper@example.test";

function env(t: TestContext, overrides: Record<string, string | undefined> = {}) {
  const values = {
    HOST: "127.0.0.1",
    MCP_AUTH_TOKEN: token,
    ALLOW_INSECURE_NO_AUTH: undefined,
    WAITROSE_ENABLE_WRITES: undefined,
    WAITROSE_ENABLE_SLOT_BOOKING: undefined,
    WAITROSE_EMAIL: waitroseEmail,
    WAITROSE_PASSWORD: "fixture-password",
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    const set = (next: string | undefined) => {
      if (next === undefined) delete process.env[key];
      else process.env[key] = next;
    };
    set(value);
    t.after(() => set(previous));
  }

  // The MCP transport uses nativeFetch directly. The server never talks to
  // the network in these tests, including on accidental extra API calls.
  t.mock.method(globalThis, "fetch", async () => {
    assert.fail("Unexpected upstream request");
  });
}

async function endpoint(t: TestContext) {
  const server = startHttp(0);
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return new URL(`http://127.0.0.1:${port}/mcp`);
}

async function connect(t: TestContext, url: URL, headers: HeadersInit = authHeaders) {
  const client = new Client({ name: "waitrose-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(url, {
    fetch: nativeFetch,
    requestInit: { headers },
  }));
  return client;
}

type UpstreamCall = { operation: string; variables: Record<string, unknown> };
type Reply = (call: UpstreamCall) => Response | object;

function mockWaitrose(reply: Reply) {
  const calls: UpstreamCall[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://www.waitrose.com");
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body));
    const operation = url.pathname.includes("/graphql-prod/")
      ? /^(?:query|mutation) (\w+)/.exec(body.query)?.[1]
      : url.pathname.includes("/productcontent/search/") ? "Search" : undefined;
    assert.ok(operation, `Unexpected upstream request: ${url.pathname}`);
    assert.equal(new Headers(init?.headers).get("Authorization"),
      operation === "NewSession" ? null : "Bearer fixture-access");
    const call = { operation, variables: body.variables ?? body };
    calls.push(call);
    const response = reply(call);
    return response instanceof Response ? response : Response.json(response);
  };
  return calls;
}

function loginReply(call: UpstreamCall) {
  assert.equal(call.operation, "NewSession");
  assert.deepEqual(call.variables.input, {
    username: waitroseEmail,
    password: "fixture-password",
    clientId: "ANDROID_APP",
  });
  return {
    data: { generateSession: {
      accessToken: "fixture-access",
      refreshToken: "fixture-refresh",
      customerId: "customer-1",
      customerOrderId: "order-1",
      customerOrderState: "OPEN",
      defaultBranchId: "branch-1",
      expiresIn: 3600,
      failures: null,
    } },
  };
}

function trolley(quantity: number) {
  return {
    products: [],
    failures: null,
    trolley: {
      orderId: "order-1",
      trolleyItems: quantity ? [{ lineNumber: "088903", quantity: { amount: quantity, uom: "C62" } }] : [],
    },
  };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
}

function payload(result: Awaited<ReturnType<typeof call>>) {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.ok(Array.isArray(result.content));
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

const readTools = [
  "waitrose_browse",
  "waitrose_get_current_slot",
  "waitrose_get_order",
  "waitrose_get_trolley",
  "waitrose_list_orders",
  "waitrose_list_slot_days",
  "waitrose_product_details",
  "waitrose_search",
];

test("MCP initializes and exposes only read tools by default, without a Waitrose login", async (t) => {
  env(t, { WAITROSE_ENABLE_SLOT_BOOKING: "true" });
  const calls = mockWaitrose(() => assert.fail("Read-only discovery must not contact Waitrose"));
  const client = await connect(t, await endpoint(t));
  assert.equal(client.getServerVersion()?.name, "waitrose");
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name).sort(), readTools);
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
  }
  assert.equal((await call(client, "waitrose_add_to_trolley", { lineNumber: "088903", quantity: 1 })).isError, true);
  assert.equal((await call(client, "waitrose_book_slot", { slotId: "slot-1", slotType: "DELIVERY" })).isError, true);
  assert.equal(calls.length, 0);
});

test("HTTP requires the bearer token at /mcp even if the local bypass flag is set", async (t) => {
  env(t, { ALLOW_INSECURE_NO_AUTH: "1" });
  const url = await endpoint(t);
  const health = await nativeFetch(new URL("/health", url));
  assert.deepEqual(await health.json(), { ok: true, writes: false, slotBooking: false });
  for (const headers of [{}, { Authorization: "Bearer wrong" }]) {
    const response = await nativeFetch(url, { method: "POST", headers, body: "{}" });
    assert.equal(response.status, 401);
    await response.body?.cancel();
  }
  const client = await connect(t, url);
  assert.equal((await client.listTools()).tools.length, readTools.length);
});

test("HTTP refuses to start without auth configuration", (t) => {
  env(t, { MCP_AUTH_TOKEN: undefined });
  assert.throws(() => startHttp(0), /Set MCP_AUTH_TOKEN/);
});

test("HTTP refuses to serve unauthenticated MCP on a public interface", (t) => {
  env(t, { HOST: "0.0.0.0", MCP_AUTH_TOKEN: undefined, ALLOW_INSECURE_NO_AUTH: "1" });
  assert.throws(() => startHttp(0), /requires HOST=127\.0\.0\.1 or HOST=::1/);
});

test("the loopback bypass accepts local MCP clients and rejects browser and rebound hosts", async (t) => {
  env(t, { MCP_AUTH_TOKEN: undefined, ALLOW_INSECURE_NO_AUTH: "1" });
  const url = await endpoint(t);
  for (const headers of [{ Origin: "https://untrusted.example" }, { Host: `rebound.example:${url.port}` }]) {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(url, { method: "POST", headers }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on("error", reject);
      req.end("{}");
    });
    assert.equal(status, 403);
  }
  const client = await connect(t, url, {});
  assert.equal((await client.listTools()).tools.length, readTools.length);
});

test("search and trolley reads share a lazy login and return Waitrose results over MCP", async (t) => {
  env(t);
  const cart = trolley(1);
  const calls = mockWaitrose((entry) => {
    if (entry.operation === "Search") {
      assert.deepEqual(entry.variables.customerSearchRequest, {
        queryParams: { searchTerm: "milk", start: 0, sortBy: "RELEVANCE", size: 2 },
      });
      return { totalMatches: 1, componentsAndProducts: [
        { searchProduct: { lineNumber: "088903", name: "Semi Skimmed Milk", displayPrice: "£1.85" } },
        { notAProduct: {} },
      ] };
    }
    if (entry.operation === "GetTrolley") {
      assert.deepEqual(entry.variables, { orderId: "order-1" });
      return { data: { getTrolley: cart } };
    }
    return loginReply(entry);
  });
  const client = await connect(t, await endpoint(t));
  assert.equal(calls.length, 0);
  assert.deepEqual(payload(await call(client, "waitrose_search", { query: "milk", limit: 2 })), {
    totalMatches: 1,
    products: [{ lineNumber: "088903", name: "Semi Skimmed Milk", price: "£1.85" }],
  });
  assert.deepEqual(payload(await call(client, "waitrose_get_trolley")), cart);
  assert.deepEqual(calls.map((entry) => entry.operation), ["NewSession", "Search", "GetTrolley"]);
});

test("trolley writes validate input and send the requested add, update, and remove through MCP", async (t) => {
  env(t, { WAITROSE_ENABLE_WRITES: "true" });
  const calls = mockWaitrose((entry) => {
    if (entry.operation !== "UpdateTrolleyItems") return loginReply(entry);
    const items = entry.variables.trolleyItemsInput as { quantity: { amount: number } }[];
    return { data: { updateTrolleyItems: trolley(items[0].quantity.amount) } };
  });
  const client = await connect(t, await endpoint(t));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.filter((tool) => !tool.annotations?.readOnlyHint).map(({ name }) => name).sort(), [
    "waitrose_add_to_trolley", "waitrose_remove_from_trolley", "waitrose_update_trolley_item",
  ]);
  for (const name of ["waitrose_remove_from_trolley", "waitrose_update_trolley_item"]) {
    assert.equal(tools.find((tool) => tool.name === name)?.annotations?.destructiveHint, true);
  }
  const item = { lineNumber: "088903" };
  assert.equal((await call(client, "waitrose_add_to_trolley", { ...item, quantity: 0 })).isError, true);
  assert.equal((await call(client, "waitrose_book_slot", { slotId: "slot-1", slotType: "DELIVERY" })).isError, true);
  assert.equal(calls.length, 0);

  const added = { ...item, quantity: 1 };
  assert.deepEqual(payload(await call(client, "waitrose_add_to_trolley", added)), { added, trolley: trolley(1) });
  const updated = { ...item, quantity: 2 };
  assert.deepEqual(payload(await call(client, "waitrose_update_trolley_item", updated)), { updated, trolley: trolley(2) });
  assert.deepEqual(payload(await call(client, "waitrose_remove_from_trolley", item)), { removed: "088903", trolley: trolley(0) });
  assert.deepEqual(calls.slice(1), [1, 2, 0].map((amount) => ({
    operation: "UpdateTrolleyItems",
    variables: { orderId: "order-1", trolleyItemsInput: [{ ...item, quantity: { amount, uom: "C62" } }] },
  })));
});

test("a Waitrose trolley rejection is a tool error, never a successful add", async (t) => {
  env(t, { WAITROSE_ENABLE_WRITES: "true" });
  mockWaitrose((entry) => entry.operation !== "UpdateTrolleyItems" ? loginReply(entry) : {
    data: { updateTrolleyItems: { ...trolley(0), failures: [{ message: "private upstream detail" }] } },
  });
  const client = await connect(t, await endpoint(t));
  const result = await call(client, "waitrose_add_to_trolley", { lineNumber: "088903", quantity: 1 });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /Check the Waitrose app/);
  assert.doesNotMatch(JSON.stringify(result), /private upstream detail|added/);
});

test("when both gates are enabled, MCP can list and book a mocked slot but never exposes checkout", async (t) => {
  env(t, { WAITROSE_ENABLE_WRITES: "true", WAITROSE_ENABLE_SLOT_BOOKING: "true" });
  const slot = { id: "slot-1", deliveryCharge: { amount: 3, currencyCode: "GBP" } };
  const days = [{ date: "2026-11-20", slots: [slot] }];
  const booked = { slotExpiryDateTime: "2026-11-15T12:00:00Z", failures: null };
  const calls = mockWaitrose((entry) => {
    if (entry.operation === "SlotDays") {
      assert.deepEqual(entry.variables.slotDaysInput, {
        slotType: "DELIVERY", branchId: "branch-1", customerOrderId: "order-1", fromDate: "2026-11-20",
      });
      return { data: { slotDays: { content: days, failures: null } } };
    }
    if (entry.operation === "BookSlot") {
      assert.deepEqual(entry.variables.input, { slotId: "slot-1", slotType: "DELIVERY" });
      return { data: { bookSlot: booked } };
    }
    return loginReply(entry);
  });
  const client = await connect(t, await endpoint(t));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name).sort(), [
    ...readTools, "waitrose_add_to_trolley", "waitrose_book_slot",
    "waitrose_remove_from_trolley", "waitrose_update_trolley_item",
  ].sort());
  assert.equal(tools.find(({ name }) => name === "waitrose_book_slot")?.annotations?.readOnlyHint, false);
  assert.equal((await call(client, "waitrose_place_order")).isError, true);
  assert.equal(calls.length, 0);
  assert.deepEqual(payload(await call(client, "waitrose_list_slot_days", { slotType: "DELIVERY", fromDate: "2026-11-20" })), { days });
  assert.deepEqual(payload(await call(client, "waitrose_book_slot", { slotId: slot.id, slotType: "DELIVERY" })), { booked });
  assert.deepEqual(calls.map(({ operation }) => operation), ["NewSession", "SlotDays", "BookSlot"]);
});

test("missing Waitrose configuration produces actionable MCP feedback", async (t) => {
  env(t, { WAITROSE_EMAIL: undefined, WAITROSE_PASSWORD: undefined });
  const calls = mockWaitrose(() => assert.fail("Must check credentials before calling Waitrose"));
  const client = await connect(t, await endpoint(t));
  const result = await call(client, "waitrose_search", { query: "milk" });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /Set WAITROSE_EMAIL and WAITROSE_PASSWORD/);
  assert.equal(calls.length, 0);
});

test("login errors do not disclose upstream responses or credentials, and a later call can sign in", async (t) => {
  env(t);
  let loginAttempts = 0;
  const calls = mockWaitrose((entry) => {
    if (entry.operation === "Search") return { totalMatches: 0 };
    if (++loginAttempts === 1) {
      return new Response("upstream echoed fixture-password", { status: 401 });
    }
    return loginReply(entry);
  });
  const client = await connect(t, await endpoint(t));
  const result = await call(client, "waitrose_search", { query: "milk" });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /Waitrose login failed/);
  assert.doesNotMatch(JSON.stringify(result), /fixture-password|upstream echoed/);
  assert.deepEqual(payload(await call(client, "waitrose_search", { query: "milk" })), { totalMatches: 0, products: [] });
  assert.deepEqual(calls.map(({ operation }) => operation), ["NewSession", "NewSession", "Search"]);
});
