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
    WAITROSE_ENABLE_CHECKOUT: undefined,
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
type Reply = (call: UpstreamCall) => object | Promise<object>;

function mockWaitrose(reply: Reply) {
  const calls: UpstreamCall[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://www.waitrose.com");
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body));
    let operation: string | undefined;
    if (url.pathname.includes("/graphql-prod/")) operation = /^(?:query|mutation) (\w+)/.exec(body.query)?.[1];
    if (url.pathname.includes("/productcontent/search/")) operation = "Search";
    if (url.pathname === "/api/order-orchestration-prod/v1/orders/order-1/place") {
      operation = "PlaceOrder";
      assert.equal(init?.redirect, "manual");
    }
    assert.ok(operation, `Unexpected upstream request: ${url.pathname}`);
    assert.equal(new Headers(init?.headers).get("Authorization"),
      operation === "NewSession" ? null : "Bearer fixture-access");
    const call = { operation, variables: body.variables ?? body };
    calls.push(call);
    const response = await reply(call);
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
  "waitrose_get_checkout",
  "waitrose_get_current_slot",
  "waitrose_get_order",
  "waitrose_get_trolley",
  "waitrose_list_orders",
  "waitrose_list_slot_days",
  "waitrose_product_details",
  "waitrose_search",
];

test("MCP initializes and exposes only read tools by default, without a Waitrose login", async (t) => {
  env(t, { WAITROSE_ENABLE_SLOT_BOOKING: "true", WAITROSE_ENABLE_CHECKOUT: "true" });
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
  assert.equal((await call(client, "waitrose_place_order")).isError, true);
  assert.equal(calls.length, 0);
});

test("HTTP requires the bearer token at /mcp even if the local bypass flag is set", async (t) => {
  env(t, { ALLOW_INSECURE_NO_AUTH: "1" });
  const url = await endpoint(t);
  const health = await nativeFetch(new URL("/health", url));
  assert.deepEqual(await health.json(), { ok: true, writes: false, slotBooking: false, checkout: false });
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

test("slot booking and order placement have separate gates", async (t) => {
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

const checkoutFlags = { WAITROSE_ENABLE_WRITES: "true", WAITROSE_ENABLE_CHECKOUT: "true" };
const expectedTotal = { amount: 60.5, currencyCode: "GBP" };
const fixtures = {
  customerOrderId: "order-1",
  totals: { estimated: { total: expectedTotal }, actual: null },
  slots: [],
};

function checkoutFixture() {
  const cart = trolley(2);
  const context = { customerOrderId: "order-1", defaultBranchId: "branch-1" };
  const order = {
    ...cart,
    instantCheckout: "ALLOWED",
    checkoutReadiness: { slotTypeValid: true },
    products: [{ lineNumber: "088903", name: "Milk" }],
    trolley: {
      ...cart.trolley,
      trolleyItems: cart.trolley.trolleyItems.map((item) => ({ ...item, trolleyItemId: 1 })),
      trolleyTotals: { totalEstimatedCost: { ...expectedTotal }, minimumSpendThresholdMet: true, trolleyItemCounts: { hardConflicts: 0 } },
    },
  };
  const slot = {
    slotType: "DELIVERY",
    addressId: "address-1",
    postcode: "AB1 2CD",
    startDateTime: "2099-01-01T12:00:00Z",
    endDateTime: "2099-01-01T13:00:00Z",
    expiryDateTime: "2099-01-01T00:00:00Z",
    deliveryCharge: { amount: 3, currencyCode: "GBP" },
  };
  function reply(entry: UpstreamCall) {
    switch (entry.operation) {
      case "GetShoppingContext":
        return { data: { shoppingContext: context } };
      case "GetTrolley":
        assert.equal(entry.variables.orderId, context.customerOrderId);
        return { data: { getTrolley: order } };
      case "CurrentSlot":
        assert.deepEqual(entry.variables.input, { customerOrderId: context.customerOrderId });
        return { data: { currentSlot: slot } };
      default:
        return loginReply(entry);
    }
  }
  return { context, order, slot, reply };
}

test("checkout review works in read-only mode and reports blockers when placement is enabled", async (t) => {
  env(t);
  const { order, reply } = checkoutFixture();
  const calls = mockWaitrose(reply);
  const client = await connect(t, await endpoint(t));

  const preview = payload(await call(client, "waitrose_get_checkout"));
  assert.equal(preview.placementEnabled, false);
  assert.equal(preview.reviewId, null);
  assert.equal(preview.canPlaceOrder, true);
  assert.deepEqual(preview.estimatedTotal, expectedTotal);
  assert.equal(preview.items[0].name, "Milk");
  assert.equal(preview.slot.type, "DELIVERY");

  Object.assign(process.env, checkoutFlags);
  order.instantCheckout = "NOT_ALLOWED";
  const blocked = payload(await call(client, "waitrose_get_checkout"));
  assert.equal(blocked.placementEnabled, true);
  assert.equal(blocked.canPlaceOrder, false);
  assert.equal(blocked.reviewId, null);
  assert.match(blocked.blockers.join(" "), /NOT_ALLOWED/);
  assert.equal(calls.some(({ operation }) => operation === "PlaceOrder"), false);
});

test("placement requires a fresh review and sends one POST for the confirmed order", async (t) => {
  env(t, checkoutFlags);
  const { context, order, reply } = checkoutFixture();
  const calls = mockWaitrose((entry) => {
    if (entry.operation !== "PlaceOrder") return reply(entry);
    assert.deepEqual(entry.variables, { instantCheckout: true, event: "PLACE" });
    return fixtures;
  });
  const client = await connect(t, await endpoint(t));
  const { tools } = await client.listTools();
  const tool = tools.find(({ name }) => name === "waitrose_place_order");
  assert.equal(tool?.annotations?.readOnlyHint, false);
  assert.equal(tool?.annotations?.destructiveHint, true);
  assert.equal(tools.some(({ name }) => name === "waitrose_book_slot"), false);
  const invalid = await call(client, "waitrose_place_order", { reviewId: "21ed9354-75ae-44d1-8bf5-02e62ac4aa24" });
  assert.equal(invalid.isError, true);

  const { reviewId } = payload(await call(client, "waitrose_get_checkout"));
  assert.equal(typeof reviewId, "string");
  assert.deepEqual(payload(await call(client, "waitrose_place_order", { reviewId })), { placed: fixtures });
  assert.equal((await call(client, "waitrose_place_order", { reviewId })).isError, true);
  const after = payload(await call(client, "waitrose_get_checkout"));
  assert.equal(after.reviewId, null);
  assert.match(after.blockers.join(" "), /already attempted/);

  context.customerOrderId = "order-2";
  order.trolley.orderId = "order-2";
  assert.equal(payload(await call(client, "waitrose_get_trolley")).trolley.orderId, "order-2");
  assert.equal(calls.filter(({ operation }) => operation === "PlaceOrder").length, 1);
});

test("a changed order, total, item quantity or slot prevents placement", async (t) => {
  env(t, checkoutFlags);
  const { context, order, slot, reply } = checkoutFixture();
  const calls = mockWaitrose(reply);
  const client = await connect(t, await endpoint(t));

  const changes = [
    () => { context.customerOrderId = "order-2"; order.trolley.orderId = "order-2"; },
    () => { order.trolley.trolleyTotals.totalEstimatedCost.amount += 1; },
    () => { order.trolley.trolleyItems[0].quantity.amount += 1; },
    () => { slot.addressId = "address-2"; },
  ];
  for (const change of changes) {
    const { reviewId } = payload(await call(client, "waitrose_get_checkout"));
    assert.equal(typeof reviewId, "string");
    change();
    const result = await call(client, "waitrose_place_order", { reviewId });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /changed/);
    assert.equal((await call(client, "waitrose_place_order", { reviewId })).isError, true);
  }
  assert.equal(calls.some(({ operation }) => operation === "PlaceOrder"), false);
});

test("an expired checkout review cannot be submitted", async (t) => {
  env(t, checkoutFlags);
  const { reply } = checkoutFixture();
  const calls = mockWaitrose(reply);
  const client = await connect(t, await endpoint(t));
  const now = Date.now();
  const clock = t.mock.method(Date, "now", () => now);
  const { reviewId } = payload(await call(client, "waitrose_get_checkout"));
  clock.mock.mockImplementation(() => now + 5 * 60_000);
  const result = await call(client, "waitrose_place_order", { reviewId });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /expired/);
  assert.equal(calls.some(({ operation }) => operation === "PlaceOrder"), false);
});

test("a write cannot race with placement, and an uncertain response blocks another attempt", async (t) => {
  env(t, checkoutFlags);
  const { reply } = checkoutFixture();
  let signalStarted: () => void;
  let finishPlacement: (response: Response) => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const finish = new Promise<Response>((resolve) => { finishPlacement = resolve; });
  const calls = mockWaitrose((entry) => {
    if (entry.operation !== "PlaceOrder") return reply(entry);
    signalStarted();
    return finish;
  });
  const url = await endpoint(t);
  const client = await connect(t, url);
  const secondClient = await connect(t, url);
  const { reviewId } = payload(await call(client, "waitrose_get_checkout"));
  const placement = call(client, "waitrose_place_order", { reviewId });
  try {
    await Promise.race([
      started,
      placement.then((result) => assert.fail(JSON.stringify(result))),
    ]);
    const update = await call(secondClient, "waitrose_add_to_trolley", { lineNumber: "088903", quantity: 1 });
    assert.equal(update.isError, true);
    assert.match(JSON.stringify(update), /in progress/);
  } finally {
    finishPlacement(new Response("private upstream response", { status: 503 }));
  }
  const failed = await placement;
  assert.equal(failed.isError, true);
  assert.match(JSON.stringify(failed), /may already have placed order order-1/);
  assert.doesNotMatch(JSON.stringify(failed), /private upstream response/);
  const after = payload(await call(client, "waitrose_get_checkout"));
  assert.equal(after.reviewId, null);
  assert.equal((await call(client, "waitrose_place_order", { reviewId })).isError, true);
  assert.equal(calls.filter(({ operation }) => operation === "PlaceOrder").length, 1);
  assert.equal(calls.some(({ operation }) => operation === "UpdateTrolleyItems"), false);
});
