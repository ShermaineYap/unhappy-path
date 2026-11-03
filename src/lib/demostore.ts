// "Kedai Kopi" demo store: a tiny merchant that implements the Unhappy Path test
// contract twice. Mode "buggy" contains five classic PayPal integration
// mistakes; mode "fixed" is the same shop done right.
//
// The shop has no database: it keeps its own records inside PayPal.
//   - Each fulfilment ("we shipped it") is a PayPal shipment tracker on the order
//     (POST /v2/checkout/orders/{id}/track); a refund cancels the tracker.
//   - Before capture, the shop's notes live in the order's custom_id
//     ("kedai:<mode>|<status>|f<count>"), updated with PATCH /v2/checkout/orders/{id}.
// The probe reads only these merchant-written records, never PayPal's own
// payment status, so the buggy build really does "believe" the wrong things.

import { PayPal, captureOf, type Creds } from "./paypal";

export type Mode = "buggy" | "fixed";

export const CATALOG: Record<string, { name: string; price: string }> = {
  "tee-classic": { name: "Kopi-O tee", price: "25.00" },
  "beans-250g": { name: "House beans 250g", price: "18.00" },
};

export const demoCreds = (): Creds => ({
  clientId: process.env.PAYPAL_CLIENT_ID!,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
});
const paypal = () => new PayPal(demoCreds());

type Ledger = {
  orderId: string;
  mode: Mode | null;
  noteStatus: "pending" | "paid" | "failed";
  noteFulfilled: number;
  trackers: { id: string; status: string }[];
  captureId?: string;
  amount: string;
};

async function readLedger(orderId: string): Promise<Ledger | null> {
  if (!/^[A-Z0-9]{8,24}$/.test(orderId)) return null;
  const r = await paypal().call("GET", `/v2/checkout/orders/${orderId}`);
  if (r.status !== 200) return null;
  const pu = r.body.purchase_units?.[0] ?? {};
  const [tag, status, f] = String(pu.custom_id ?? "").split("|");
  const mode = tag === "kedai:buggy" ? "buggy" : tag === "kedai:fixed" ? "fixed" : null;
  return {
    orderId,
    mode,
    noteStatus: status === "paid" || status === "failed" ? status : "pending",
    noteFulfilled: Number((f ?? "f0").slice(1)) || 0,
    trackers: (pu.shipping?.trackers ?? []).map((t: any) => ({ id: t.id, status: t.status })),
    captureId: captureOf(r.body)?.status === "COMPLETED" ? captureOf(r.body).id : undefined,
    amount: pu.amount?.value,
  };
}

async function writeNote(l: Ledger, status: Ledger["noteStatus"], fulfilled: number) {
  // Only possible before capture; PayPal locks the order once it's completed.
  await paypal().call("PATCH", `/v2/checkout/orders/${l.orderId}`, [
    { op: "replace", path: "/purchase_units/@reference_id=='default'/custom_id", value: `kedai:${l.mode}|${status}|f${fulfilled}` },
  ]);
}

async function fulfil(l: Ledger) {
  if (l.mode === "fixed") {
    // Fixed: fulfil exactly once per order. The PayPal-Request-Id makes the
    // tracker call itself idempotent even if two deliveries race.
    if (l.trackers.length > 0 || !l.captureId) return;
    await paypal().call("POST", `/v2/checkout/orders/${l.orderId}/track`, trackerBody(l), { requestId: `kedai-fulfil-${l.orderId}` });
    return;
  }
  // Bug #4 (buggy): ships every time it's told, from any code path.
  if (l.captureId) await paypal().call("POST", `/v2/checkout/orders/${l.orderId}/track`, trackerBody(l));
  else await writeNote(l, "paid", l.noteFulfilled + 1);
}

const trackerBody = (l: Ledger) => ({
  capture_id: l.captureId,
  tracking_number: `KK${Date.now()}${Math.floor(Math.random() * 1000)}`,
  carrier: "OTHER",
  carrier_name_other: "Kedai Kopi rider",
  notify_payer: false,
});

export async function checkout(mode: Mode, body: { sku?: string; quantity?: number; price?: string }) {
  const item = CATALOG[body.sku ?? "tee-classic"] ?? CATALOG["tee-classic"];
  const qty = Math.max(1, Math.min(10, Number(body.quantity ?? 1)));
  // Bug #1 (buggy): trusts the price the browser sent.
  const unit = mode === "buggy" && body.price ? body.price : item.price;
  const value = (Number(unit) * qty).toFixed(2);
  const r = await paypal().call("POST", "/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [{ amount: { currency_code: "USD", value }, description: item.name, custom_id: `kedai:${mode}` }],
  });
  if (r.status >= 400) throw new Error("PayPal create order failed");
  return { order_id: r.body.id as string };
}

export async function approve(mode: Mode, orderId: string, mockHeader?: string | null) {
  const before = await readLedger(orderId);
  if (!before || before.mode !== mode) return { http: 404, body: { error: "unknown order" } };
  // Sandbox test hook: forward X-Unhappy-Mock as PayPal-Mock-Response.
  const headers: Record<string, string> = mockHeader ? { "PayPal-Mock-Response": mockHeader } : {};
  const r = await paypal().call("POST", `/v2/checkout/orders/${orderId}/capture`, {}, { headers });
  const cap = captureOf(r.body);
  const l: Ledger = { ...before, captureId: cap?.status === "COMPLETED" ? cap.id : undefined };
  if (mode === "buggy") {
    // Bug #2: marks the order paid as soon as the buyer comes back, whatever capture returned.
    await fulfil(l);
    return { http: 200, body: { ok: true, status: "paid" } };
  }
  if (r.status >= 400 || cap?.status !== "COMPLETED") {
    await writeNote(l, "failed", 0);
    return { http: 402, body: { ok: false, reason: r.body?.details?.[0]?.issue ?? cap?.status ?? "CAPTURE_FAILED" } };
  }
  await fulfil(l);
  return { http: 200, body: { ok: true, status: "paid" } };
}

export async function probe(mode: Mode, orderId: string) {
  const l = await readLedger(orderId);
  if (!l || l.mode !== mode) return null;
  const fulfilled = l.trackers.length + l.noteFulfilled;
  const status = l.trackers.some((t) => t.status === "CANCELLED") ? "refunded" : l.trackers.length ? "paid" : l.noteStatus;
  return { status, fulfilled, amount: l.amount };
}

async function verifySignature(headers: Headers, event: any, webhookId: string | undefined) {
  if (!webhookId) return false;
  const r = await paypal().call("POST", "/v1/notifications/verify-webhook-signature", {
    auth_algo: headers.get("paypal-auth-algo"),
    cert_url: headers.get("paypal-cert-url"),
    transmission_id: headers.get("paypal-transmission-id"),
    transmission_sig: headers.get("paypal-transmission-sig"),
    transmission_time: headers.get("paypal-transmission-time"),
    webhook_id: webhookId,
    webhook_event: event,
  });
  return r.body?.verification_status === "SUCCESS";
}

async function orderIdFor(event: any): Promise<string | undefined> {
  const res = event?.resource ?? {};
  const direct = res?.supplementary_data?.related_ids?.order_id;
  if (direct) return direct;
  // Refund resources link "up" to the capture; the capture knows its order.
  const up = (res.links ?? []).find((l: any) => l.rel === "up")?.href as string | undefined;
  const capId = up?.split("/captures/")[1]?.split(/[/?]/)[0];
  if (!capId) return undefined;
  const c = await paypal().call("GET", `/v2/payments/captures/${capId}`);
  return c.body?.supplementary_data?.related_ids?.order_id;
}

export async function webhook(mode: Mode, headers: Headers, event: any) {
  if (mode === "fixed") {
    const ok = await verifySignature(headers, event, process.env.PAYPAL_WEBHOOK_ID_FIXED);
    if (!ok) return { http: 400, body: { error: "signature verification failed" } };
  }
  // Bug #3 (buggy): no signature verification, so anyone can post here.
  const orderId = await orderIdFor(event);
  if (!orderId) return { http: 200, body: { ok: true, ignored: "no order" } };
  const l = await readLedger(orderId);
  if (!l || l.mode !== mode) return { http: 200, body: { ok: true, ignored: "not ours" } };
  switch (event.event_type) {
    case "PAYMENT.CAPTURE.COMPLETED":
      await fulfil(l); // fixed: no-op if already shipped (handles duplicate deliveries)
      break;
    case "PAYMENT.CAPTURE.REFUNDED": {
      // Bug #5 (buggy): refunds are ignored.
      if (mode === "fixed") {
        const t = l.trackers.find((x) => x.status !== "CANCELLED");
        if (t) await paypal().call("PATCH", `/v2/checkout/orders/${orderId}/trackers/${t.id}`, [{ op: "replace", path: "/status", value: "CANCELLED" }]);
      }
      break;
    }
  }
  return { http: 200, body: { ok: true } };
}
