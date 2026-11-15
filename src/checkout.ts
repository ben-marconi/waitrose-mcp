import { randomUUID } from "node:crypto";
import { CheckoutOutcomeUnknownError, type CheckoutReview, type WaitroseClient } from "./waitrose.js";

const REVIEW_LIFETIME_MS = 5 * 60_000;

export class CheckoutToolError extends Error {}

function checkoutDetails(review: CheckoutReview) {
  const { orderId, estimatedTotal, trolley: { trolley, products }, slot } = review;
  const productNames = new Map(products.map(({ lineNumber, name }) => [lineNumber, name]));
  const items = [...trolley.trolleyItems]
    .sort((a, b) => a.lineNumber.localeCompare(b.lineNumber) || a.trolleyItemId - b.trolleyItemId)
    .map(({ trolleyItemId, lineNumber, quantity, totalPrice, canSubstitute, noteToShopper, personalisedMessage }) => ({
      trolleyItemId,
      lineNumber,
      name: productNames.get(lineNumber),
      quantity: { amount: quantity.amount, uom: quantity.uom },
      totalPrice: totalPrice && { amount: totalPrice.amount, currencyCode: totalPrice.currencyCode },
      canSubstitute,
      noteToShopper,
      personalisedMessage: personalisedMessage ?? null,
    }));

  return {
    orderId,
    estimatedTotal: estimatedTotal && { amount: estimatedTotal.amount, currencyCode: estimatedTotal.currencyCode },
    items,
    slot: slot && {
      type: slot.slotType,
      branchId: slot.branchId,
      addressId: slot.addressId,
      postcode: slot.postcode,
      start: slot.startDateTime,
      end: slot.endDateTime,
      deliveryCharge: slot.deliveryCharge && { amount: slot.deliveryCharge.amount, currencyCode: slot.deliveryCharge.currencyCode },
    },
  };
}

export class Checkout {
  private review?: { id: string; expiresAt: number; details: ReturnType<typeof checkoutDetails> };
  private readonly attemptedOrders = new Set<string>();

  constructor(private readonly client: WaitroseClient) {}

  async getReview(placementEnabled: boolean) {
    const review = await this.client.getCheckout();
    const details = checkoutDetails(review);
    const attempted = this.attemptedOrders.has(review.orderId);
    const blockers = [...review.blockers];
    if (attempted) blockers.push("This server already attempted placement for this order. Check the order in Waitrose.");
    const canPlaceOrder = review.canPlaceOrder && !attempted;
    const id = placementEnabled && canPlaceOrder ? randomUUID() : null;
    const expiresAt = id ? Date.now() + REVIEW_LIFETIME_MS : null;
    this.review = id ? { id, expiresAt, details } : undefined;

    return { ...details, canPlaceOrder, blockers, placementEnabled,
      reviewId: id, reviewExpiresAt: expiresAt && new Date(expiresAt).toISOString(),
      checkoutUrl: review.checkoutUrl };
  }

  async place(reviewId: string) {
    const review = this.review;
    if (!review || review.id !== reviewId || review.expiresAt <= Date.now()) {
      throw new CheckoutToolError("Review ID is missing, expired or already used. Review checkout again before confirming placement.");
    }
    const { orderId, estimatedTotal } = review.details;
    if (this.attemptedOrders.has(orderId)) {
      throw new CheckoutToolError("This server already attempted placement for that order. Check the order in Waitrose.");
    }
    this.review = undefined;
    try {
      return await this.client.placeOrder({
        orderId,
        expectedTotal: estimatedTotal,
        beforePlacement: (freshReview) => {
          if (Date.now() >= review.expiresAt || JSON.stringify(checkoutDetails(freshReview)) !== JSON.stringify(review.details)) {
            throw new CheckoutToolError("Checkout details changed or the review expired. Review the order again and reconfirm it.");
          }
          this.attemptedOrders.add(orderId);
        },
      });
    } catch (error) {
      if (error instanceof CheckoutOutcomeUnknownError) {
        throw new CheckoutToolError(`Waitrose may already have placed order ${orderId}. Check waitrose_get_order or the Waitrose app before taking any other action.`);
      }
      throw error;
    }
  }
}
