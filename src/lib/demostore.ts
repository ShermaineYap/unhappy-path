// "Kedai Kopi" demo store: a tiny merchant that implements the Unhappy Path test
// contract twice. mode "buggy" contains five classic PayPal integration
// mistakes; mode "fixed" is the same shop done right. Both use the same
// sandbox PayPal app; orders are tagged with custom_id so each mode only
// touches its own orders.

import { kv } from "./store";
import { PayPal, captureOf, type Creds } from "./paypal";

export type Mode = "buggy" | "fixed";

export const CATALOG: Record<string, { name: string; price: string }> = {
  "tee-classic": { name: "Kopi-O tee", price: "25.00" },
  "beans-250g": { name: "House beans 250g", price: "18.00" },
};

type Order = { id: string; mode: Mode; status: "pending" | "paid" | "refunded" | "failed"; fulfilled: number; amount: string; captureId?: string };

export const demoCreds = (): Creds => ({
  clientId: process.env.PAYPAL_CLIENT_ID!,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
});

const key = (mode: Mode, id: string) => `demo:${mode}:order:${id}`;
const getOrder = (mode: Mode, id: string) => kv.get<Order>(key(mode, id));
const save = (o: Order) => kv.set(key(o.mode, o.id), o);

async function fulfil(o: Order, mode: Mode) {
  if (mode === "fixed") {
    // Fixed: fulfil exactly once per order.
    const first = await kv.setnx(`demo:fixed:fulfilled:${o.id}`, 1);
    if (first) o.fulfilled = 1;
  } else {
    // Bug #4: fulfils every time it's told, from any code path.
    o.fulfilled += 1;
  }
}

export async function checkout(mode: Mode, body: { sku?: string; quantity?: number; price?: string }) {
  const item = CATALOG[body.sku ?? "tee-classic"] ?? CATALOG["tee-classic"];
  const qty = Math.max(1, Math.min(10, Number(body.quantity ?? 1)));
  // Bug #1 (buggy): trusts the price the browser sent.
  const unit = mode === "buggy" && body.price ? body.price : item.price;
  const value = (Number(unit) * qty).toFixed(2);
  const pp = new PayPal(demoCreds());
  const r = await pp.call("POST", "/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [{ amount: { currency_code: "USD", value }, description: item.name, custom_id: `kedai:${mode}` }],
  });
  if (r.status >= 400) throw new Error("PayPal create order failed");
  await save({ id: r.body.id, mode, status: "pending", fulfilled: 0, amount: value });
  return { order_id: r.body.id as string };
}

export async function approve(mode: Mode, orderId: string, mockHeader?: string | null) {
  const o = await getOrder(mode, orderId);
  if (!o) return { http: 404, body: { error: "unknown order" } };
  const pp = new PayPal(demoCreds());
  // Sandbox test hook: forward X-Unhappy-Mock as PayPal-Mock-Response.
  const headers: Record<string, string> = mockHeader ? { "PayPal-Mock-Response": mockHeader } : {};
  const r = await pp.call("POST", `/v2/checkout/orders/${orderId}/capture`, {}, { headers });
  const cap = captureOf(r.body);
  if (mode === "buggy") {
    // Bug #2: marks the order paid as soon as the buyer comes back, whatever capture returned.
    o.status = "paid";
    await fulfil(o, mode);
    if (cap?.id) {
      o.captureId = cap.id;
      await kv.set(`demo:cap:${cap.id}`, orderId);
    }
    await save(o);
    return { http: 200, body: { ok: true, status: o.status } };
  }
  if (r.status >= 400 || cap?.status !== "COMPLETED") {
    o.status = "failed";
    await save(o);
    return { http: 402, body: { ok: false, reason: r.body?.details?.[0]?.issue ?? cap?.status ?? "CAPTURE_FAILED" } };
  }
  o.status = "paid";
  o.captureId = cap.id;
  await kv.set(`demo:cap:${cap.id}`, orderId);
  await fulfil(o, mode);
  await save(o);
  return { http: 200, body: { ok: true, status: o.status } };
}

export async function probe(mode: Mode, orderId: string) {
  const o = await getOrder(mode, orderId);
  if (!o) return null;
  return { status: o.status, fulfilled: o.fulfilled, amount: o.amount };
}

async function verifySignature(headers: Headers, rawEvent: any, webhookId: string | undefined) {
  if (!webhookId) return false;
  const pp = new PayPal(demoCreds());
  const r = await pp.call("POST", "/v1/notifications/verify-webhook-signature", {
    auth_algo: headers.get("paypal-auth-algo"),
    cert_url: headers.get("paypal-cert-url"),
    transmission_id: headers.get("paypal-transmission-id"),
    transmission_sig: headers.get("paypal-transmission-sig"),
    transmission_time: headers.get("paypal-transmission-time"),
    webhook_id: webhookId,
    webhook_event: rawEvent,
  });
  return r.body?.verification_status === "SUCCESS";
}

async function orderIdFor(event: any): Promise<string | undefined> {
  const res = event?.resource ?? {};
  const direct = res?.supplementary_data?.related_ids?.order_id;
  if (direct) return direct;
  // Refund resources link "up" to the capture.
  const up = (res.links ?? []).find((l: any) => l.rel === "up")?.href as string | undefined;
  const capId = up?.split("/captures/")[1]?.split(/[/?]/)[0];
  if (capId) return (await kv.get<string>(`demo:cap:${capId}`)) ?? undefined;
  return undefined;
}

export async function webhook(mode: Mode, headers: Headers, event: any) {
  if (mode === "fixed") {
    const ok = await verifySignature(headers, event, process.env.PAYPAL_WEBHOOK_ID_FIXED);
    if (!ok) return { http: 400, body: { error: "signature verification failed" } };
    // De-duplicate by event id.
    const first = await kv.setnx(`demo:fixed:event:${event.id}`, 1);
    if (!first) return { http: 200, body: { ok: true, duplicate: true } };
  }
  // Bug #3 (buggy): no signature verification and no de-duplication.
  const orderId = await orderIdFor(event);
  if (!orderId) return { http: 200, body: { ok: true, ignored: "no order" } };
  const o = await getOrder(mode, orderId);
  if (!o) return { http: 200, body: { ok: true, ignored: "not ours" } };
  switch (event.event_type) {
    case "PAYMENT.CAPTURE.COMPLETED":
      o.status = o.status === "refunded" ? o.status : "paid";
      await fulfil(o, mode);
      break;
    case "PAYMENT.CAPTURE.DENIED":
      o.status = "failed";
      break;
    case "PAYMENT.CAPTURE.REFUNDED":
      // Bug #5 (buggy): refunds are ignored.
      if (mode === "fixed") o.status = "refunded";
      break;
  }
  await save(o);
  return { http: 200, body: { ok: true } };
}
