/**
 * Tool registry for the Waitrose MCP server.
 *
 * Read tools are annotated readOnlyHint: true so MCP clients (ChatGPT,
 * Claude, ...) can treat them as safe reads. Write tools are registered
 * only when the corresponding gates are enabled. Their annotations let
 * clients distinguish writes from reads and apply confirmation policies.
 *
 * Cancellation, amendment and emptying the entire trolley stay in Waitrose.
 */
import { z } from "zod";
import WaitroseClient from "./waitrose.js";
import type { SlotType, TrolleyResponse } from "./waitrose.js";
import type { Checkout } from "./checkout.js";

export interface ToolContext {
  client: WaitroseClient;
  checkout: Checkout;
  /** Lazily logs in with env credentials on first API call. */
  ensureLoggedIn: () => Promise<void>;
  runWrite: <T>(action: () => Promise<T>) => Promise<T>;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  schema: z.ZodRawShape;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  handler: (ctx: ToolContext, args: any) => Promise<unknown>;
}

export function writesEnabled(): boolean {
  return process.env.WAITROSE_ENABLE_WRITES === "true";
}

/**
 * Slot booking may incur a charge (delivery fees under Waitrose's current
 * terms) on the real account, so it has its own gate on top of the general write gate: both
 * WAITROSE_ENABLE_WRITES=true AND WAITROSE_ENABLE_SLOT_BOOKING=true are
 * required. Keep it off until the user has explicitly approved slot
 * booking under current Waitrose terms.
 */
export function slotBookingEnabled(): boolean {
  return writesEnabled() && process.env.WAITROSE_ENABLE_SLOT_BOOKING === "true";
}

export function checkoutEnabled(): boolean {
  return writesEnabled() && process.env.WAITROSE_ENABLE_CHECKOUT === "true";
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function trolleyChangeResult(trolley: TrolleyResponse, change: object) {
  if (!trolley?.trolley || trolley.failures?.length) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: "Waitrose did not confirm the trolley change. Check the Waitrose app before trying again." }],
    };
  }
  return json({ ...change, trolley });
}

const READ_ANNOTATIONS = (title: string) => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
});

const WRITE_ANNOTATIONS = (title: string, destructive: boolean) => ({
  title,
  readOnlyHint: false,
  destructiveHint: destructive,
  idempotentHint: false,
  openWorldHint: true,
});

const READ_TOOLS: ToolDef[] = [
  {
    name: "waitrose_get_checkout",
    title: "Review Waitrose checkout",
    description:
      "Review the current trolley, estimated total and delivery or collection slot. Shows any checkout blockers. If placement is enabled and the order is eligible, returns a short-lived review ID. Show the user the items, estimated total and slot before asking them to confirm placement.",
    schema: {},
    annotations: { ...READ_ANNOTATIONS("Review Waitrose checkout"), idempotentHint: false },
    handler: async (ctx) => {
      await ctx.ensureLoggedIn();
      return json(await ctx.checkout.getReview(checkoutEnabled()));
    },
  },
  {
    name: "waitrose_search",
    title: "Search Waitrose products",
    description:
      "Search the live Waitrose grocery catalogue by text. Use this when the user wants to find products, check prices or compare items. Returns product names, prices, sizes and line numbers (needed for trolley tools).",
    schema: {
      query: z.string().describe("Search text, e.g. 'semi skimmed milk'"),
      limit: z.number().int().min(1).max(50).optional().describe("Max products to return (default 10)"),
    },
    annotations: READ_ANNOTATIONS("Search Waitrose products"),
    handler: async (ctx, args: { query: string; limit?: number }) => {
      await ctx.ensureLoggedIn();
      const res = await ctx.client.searchProducts(args.query, { size: args.limit ?? 10 });
      return json({
        totalMatches: res.totalMatches,
        products: res.products.map((p: any) => ({
          lineNumber: p.lineNumber,
          name: p.name,
          brand: p.brandName,
          price: p.displayPrice,
          size: p.size,
          pricePerUnit: p.displayPriceQualifier ?? undefined,
          promotion: p.promotionDescription ?? undefined,
          outOfStock: p.outOfStock ?? undefined,
        })),
      });
    },
  },
  {
    name: "waitrose_browse",
    title: "Browse Waitrose category",
    description:
      "Browse products in a Waitrose category by its numeric ID. Start at '10051' (Groceries) and drill down via returned subCategories. Use this when the user wants to explore a department rather than search by text.",
    schema: {
      categoryId: z.string().describe("Category ID, e.g. '10051' for Groceries"),
      limit: z.number().int().min(1).max(50).optional().describe("Max products to return (default 10)"),
    },
    annotations: READ_ANNOTATIONS("Browse Waitrose category"),
    handler: async (ctx, args: { categoryId: string; limit?: number }) => {
      await ctx.ensureLoggedIn();
      const res = await ctx.client.browseProducts(args.categoryId, { size: args.limit ?? 10 });
      return json({
        totalMatches: res.totalMatches,
        subCategories: res.subCategories ?? [],
        products: res.products.map((p: any) => ({
          lineNumber: p.lineNumber,
          name: p.name,
          price: p.displayPrice,
          size: p.size,
        })),
      });
    },
  },
  {
    name: "waitrose_product_details",
    title: "Get Waitrose product details",
    description:
      "Get full details (ingredients, nutrition, storage, size) for one or more products by line number, as returned by waitrose_search. Use this before recommending a product with dietary constraints.",
    schema: {
      lineNumbers: z.array(z.string()).min(1).max(10).describe("Product line numbers, e.g. ['088903']"),
    },
    annotations: READ_ANNOTATIONS("Get Waitrose product details"),
    handler: async (ctx, args: { lineNumbers: string[] }) => {
      await ctx.ensureLoggedIn();
      const products = await ctx.client.getProductsByLineNumbers(args.lineNumbers);
      return json({ products });
    },
  },
  {
    name: "waitrose_get_trolley",
    title: "View Waitrose trolley",
    description:
      "View the current Waitrose trolley: items, quantities, prices, estimated total, conflicts and whether a delivery slot is booked. Read-only; does not change anything.",
    schema: {},
    annotations: READ_ANNOTATIONS("View Waitrose trolley"),
    handler: async (ctx) => {
      await ctx.ensureLoggedIn();
      const t = await ctx.client.getTrolley();
      return json(t);
    },
  },
  {
    name: "waitrose_list_orders",
    title: "List Waitrose orders",
    description:
      "List pending and recent previous Waitrose orders with totals and delivery slot times. Read-only.",
    schema: {
      limit: z.number().int().min(1).max(25).optional().describe("Max orders per list (default 10)"),
    },
    annotations: READ_ANNOTATIONS("List Waitrose orders"),
    handler: async (ctx, args: { limit?: number }) => {
      await ctx.ensureLoggedIn();
      const orders = await ctx.client.getOrders(args.limit ?? 10);
      return json(orders);
    },
  },
  {
    name: "waitrose_get_order",
    title: "Get Waitrose order details",
    description:
      "Get full details of one Waitrose order by customer order ID: lines, quantities, totals, slot, payment summary. Read-only.",
    schema: {
      customerOrderId: z.string().describe("The customerOrderId from waitrose_list_orders"),
    },
    annotations: READ_ANNOTATIONS("Get Waitrose order details"),
    handler: async (ctx, args: { customerOrderId: string }) => {
      await ctx.ensureLoggedIn();
      const order = await ctx.client.getOrder(args.customerOrderId);
      return json(order);
    },
  },
  {
    name: "waitrose_get_current_slot",
    title: "View current delivery slot",
    description:
      "Show the currently booked Waitrose delivery or collection slot, if any: time window, charge, cutoff times. Read-only.",
    schema: {},
    annotations: READ_ANNOTATIONS("View current delivery slot"),
    handler: async (ctx) => {
      await ctx.ensureLoggedIn();
      const slot = await ctx.client.getCurrentSlot();
      return json({ slot });
    },
  },
  {
    name: "waitrose_list_slot_days",
    title: "List available delivery slots",
    description:
      "List Waitrose delivery or collection slots from a date (YYYY-MM-DD), with times, charges and availability. Use this when the user asks when their shopping could arrive. Read-only; use waitrose_book_slot (when enabled) to book.",
    schema: {
      slotType: z.enum(["DELIVERY", "COLLECTION"]).describe("DELIVERY or COLLECTION"),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("First date to check, YYYY-MM-DD"),
    },
    annotations: READ_ANNOTATIONS("List available delivery slots"),
    handler: async (ctx, args: { slotType: SlotType; fromDate: string }) => {
      await ctx.ensureLoggedIn();
      const days = await ctx.client.getSlotDays(args.slotType, args.fromDate);
      return json({ days });
    },
  },
];

const WRITE_TOOLS: ToolDef[] = [
  {
    name: "waitrose_add_to_trolley",
    title: "Add item to Waitrose trolley",
    description:
      "Add a product to the live Waitrose trolley by line number (from waitrose_search). This CHANGES the real trolley, including an open upcoming order: confirm the product, quantity and current total with the user first.",
    schema: {
      lineNumber: z.string().describe("Product line number, e.g. '088903'"),
      quantity: z.number().int().min(1).max(99).describe("How many to add"),
    },
    annotations: WRITE_ANNOTATIONS("Add item to Waitrose trolley", false),
    handler: async (ctx, args: { lineNumber: string; quantity: number }) => {
      await ctx.ensureLoggedIn();
      const t = await ctx.client.addToTrolley(args.lineNumber, args.quantity);
      return trolleyChangeResult(t, { added: args });
    },
  },
  {
    name: "waitrose_update_trolley_item",
    title: "Update trolley item quantity",
    description:
      "Change the quantity of an item already in the Waitrose trolley. This CHANGES the real trolley; confirm with the user first.",
    schema: {
      lineNumber: z.string().describe("Product line number"),
      quantity: z.number().int().min(0).max(99).describe("New quantity (0 removes the item)"),
    },
    annotations: WRITE_ANNOTATIONS("Update trolley item quantity", true),
    handler: async (ctx, args: { lineNumber: string; quantity: number }) => {
      await ctx.ensureLoggedIn();
      const t = await ctx.client.updateTrolleyItems([
        { lineNumber: args.lineNumber, quantity: { amount: args.quantity, uom: "C62" } },
      ]);
      return trolleyChangeResult(t, { updated: args });
    },
  },
  {
    name: "waitrose_remove_from_trolley",
    title: "Remove item from Waitrose trolley",
    description:
      "Remove an item from the live Waitrose trolley by line number. This CHANGES the real trolley and cannot be undone from here; confirm with the user first.",
    schema: {
      lineNumber: z.string().describe("Product line number to remove"),
    },
    annotations: WRITE_ANNOTATIONS("Remove item from Waitrose trolley", true),
    handler: async (ctx, args: { lineNumber: string }) => {
      await ctx.ensureLoggedIn();
      const t = await ctx.client.removeFromTrolley(args.lineNumber);
      return trolleyChangeResult(t, { removed: args.lineNumber });
    },
  },
];

const SLOT_BOOKING_TOOLS: ToolDef[] = [
  {
    name: "waitrose_book_slot",
    title: "Book Waitrose delivery slot",
    description:
      "Book a Waitrose delivery or collection slot by slot ID (from waitrose_list_slot_days). This COMMITS the slot on the real account and may carry a delivery charge; always confirm the exact slot time and charge with the user first.",
    schema: {
      slotId: z.string().describe("Slot ID from waitrose_list_slot_days"),
      slotType: z.enum(["DELIVERY", "COLLECTION"]),
    },
    annotations: WRITE_ANNOTATIONS("Book Waitrose delivery slot", false),
    handler: async (ctx, args: { slotId: string; slotType: SlotType }) => {
      await ctx.ensureLoggedIn();
      const result = await ctx.client.bookSlot(args.slotId, args.slotType);
      return json({ booked: result });
    },
  },
];

const CHECKOUT_TOOL: ToolDef = {
  name: "waitrose_place_order",
  title: "Place Waitrose order",
  description:
    "Places a real order using the account's existing payment setup and can charge the user. Call only after the user explicitly confirms the items, estimated total and slot from waitrose_get_checkout. Use that review ID, once. If placement is uncertain, check the order in Waitrose before taking any other action.",
  schema: {
    reviewId: z.uuid().describe("The review ID from the checkout summary the user just confirmed"),
  },
  annotations: WRITE_ANNOTATIONS("Place Waitrose order", true),
  handler: async (ctx, args: { reviewId: string }) => {
    await ctx.ensureLoggedIn();
    return json({ placed: await ctx.checkout.place(args.reviewId) });
  },
};

/** The tool set to register, honouring the write gates. */
export function activeTools(): ToolDef[] {
  const tools = [...READ_TOOLS];
  if (writesEnabled()) tools.push(...WRITE_TOOLS);
  if (slotBookingEnabled()) tools.push(...SLOT_BOOKING_TOOLS);
  if (checkoutEnabled()) tools.push(CHECKOUT_TOOL);
  return tools;
}
