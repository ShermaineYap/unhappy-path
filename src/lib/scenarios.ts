// The scenario catalogue. Each scenario drives the merchant's real code through
// the test contract, makes PayPal do something unhappy, then checks what the
// merchant believes happened. Verdicts are computed in code, never by the LLM.

import { Contract, Target } from "./contract";
import { PayPal, TEST_CARD, captureOf, type CallLog } from "./paypal";

export type Severity = "critical" | "high" | "medium";
export type Verdict = "pass" | "fail" | "skip" | "error" | "pending";

export type ScenarioResult = {
  id: string;
  verdict: Verdict;
  summary: string;
  observations: string[];
  evidence: Record<string, unknown>;
  calls: CallLog[];
  durationMs: number;
  /** Present while verdict is "pending": pass it back to resume the scenario. */
  state?: Record<string, any>;
  /** Suggested wait before resuming, ms. */
  retryAfterMs?: number;
};

export type Ctx = {
  pp: PayPal;
  contract: Contract;
  target: Target;
  observe: (s: string) => void;
  evidence: Record<string, unknown>;
  state?: Record<string, any>;
};

type Outcome = { verdict: Verdict; summary: string; state?: Record<string, any>; retryAfterMs?: number };

/** Long-running scenarios wait for PayPal's sandbox webhooks (often 1-4 minutes),
 * so they return "pending" with state and the client calls again. */
const MAX_WAIT_MS = 7 * 60 * 1000;

export type Scenario = {
  id: string;
  title: string;
  category: "security" | "correctness" | "configuration";
  severity: Severity;
  kb: string[];
  what: string; // one line: what the agent does
  risk: string; // one line: what goes wrong in production if this fails
  run: (c: Ctx) => Promise<Outcome>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Merchant creates an order, Unhappy Path pays it as a sandbox buyer with a test card. */
async function buyerPays(c: Ctx, opts: { mock?: string; price?: string } = {}) {
  const orderId = await c.contract.checkout({ price: opts.price });
  const conf = await c.pp.call("POST", `/v2/checkout/orders/${orderId}/confirm-payment-source`, {
    payment_source: { card: TEST_CARD },
  }, { note: "buyer pays with sandbox test card" });
  if (conf.status >= 400) throw new Error(`confirm-payment-source failed: ${conf.body?.details?.[0]?.issue ?? conf.status}`);
  const appr = await c.contract.approve(orderId, opts.mock);
  return { orderId, approveStatus: appr.status, approveBody: appr.json };
}

async function merchantWebhook(c: Ctx) {
  const r = await c.pp.call("GET", "/v1/notifications/webhooks", undefined, { note: "list webhook subscriptions" });
  const hooks: any[] = r.body?.webhooks ?? [];
  const norm = (u: string) => u.replace(/\/$/, "");
  return hooks.find((h) => norm(h.url) === norm(c.target.webhookUrl));
}

export const SCENARIOS: Scenario[] = [
  {
    id: "webhook-config",
    title: "Webhook subscriptions cover the money events",
    category: "configuration",
    severity: "medium",
    kb: ["webhook-events", "webhooks-api"],
    what: "Reads the app's webhook subscriptions from PayPal and checks the merchant URL is subscribed to captures, denials, refunds and disputes.",
    risk: "PayPal never tells your server about refunds or disputes made outside your checkout.",
    async run(c) {
      const hook = await merchantWebhook(c);
      if (!hook) {
        c.observe(`No webhook on this PayPal app points at ${c.target.webhookUrl}.`);
        return { verdict: "fail", summary: "Your webhook URL is not registered on the PayPal app." };
      }
      const names: string[] = (hook.event_types ?? []).map((e: any) => e.name);
      c.evidence.subscribed = names;
      if (names.includes("*")) {
        c.observe("Subscribed to all events (*).");
        return { verdict: "pass", summary: "Webhook subscribed to every event." };
      }
      const need = ["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.REFUNDED", "CUSTOMER.DISPUTE.CREATED"];
      const missing = need.filter((n) => !names.includes(n));
      c.evidence.missing = missing;
      c.observe(`Subscribed: ${names.join(", ") || "none"}.`);
      return missing.length
        ? { verdict: "fail", summary: `Missing subscriptions: ${missing.join(", ")}.` }
        : { verdict: "pass", summary: "All money events are subscribed." };
    },
  },
  {
    id: "happy-path",
    title: "Happy path: paid order is recorded once",
    category: "correctness",
    severity: "high",
    kb: ["orders-capture"],
    what: "Merchant creates an order, the agent pays it as a sandbox buyer, the merchant captures, then the agent checks PayPal and the merchant agree.",
    risk: "Basic checkout is broken; nothing else matters until this passes.",
    async run(c) {
      const { orderId, approveStatus } = await buyerPays(c);
      c.evidence.orderId = orderId;
      const pp = await c.pp.call("GET", `/v2/checkout/orders/${orderId}`, undefined, { note: "read order from PayPal" });
      const cap = captureOf(pp.body);
      const probe = await c.contract.probe(orderId);
      c.evidence.paypal = { status: pp.body.status, capture: cap?.status };
      c.evidence.merchant = probe;
      c.observe(`PayPal says ${pp.body.status}/${cap?.status ?? "no capture"}; merchant says ${probe.status}, fulfilled ×${probe.fulfilled} (approve returned ${approveStatus}).`);
      if (cap?.status === "COMPLETED" && probe.status === "paid" && probe.fulfilled === 1)
        return { verdict: "pass", summary: "Paid once, fulfilled once." };
      return { verdict: "fail", summary: `PayPal and the merchant disagree: PayPal ${cap?.status ?? pp.body.status}, merchant ${probe.status} ×${probe.fulfilled}.` };
    },
  },
  {
    id: "price-tampering",
    title: "Server ignores a price sent by the browser",
    category: "security",
    severity: "critical",
    kb: ["orders-create"],
    what: "Calls the merchant's checkout twice — once normally, once with price 0.01 injected — and compares the amounts PayPal was asked to charge.",
    risk: "Anyone can edit the request in their browser and buy your products for 1 cent.",
    async run(c) {
      const normal = await c.contract.checkout();
      const tampered = await c.contract.checkout({ price: "0.01" });
      const a = await c.pp.call("GET", `/v2/checkout/orders/${normal}`, undefined, { note: "amount of normal order" });
      const b = await c.pp.call("GET", `/v2/checkout/orders/${tampered}`, undefined, { note: "amount of tampered order" });
      const av = a.body?.purchase_units?.[0]?.amount?.value;
      const bv = b.body?.purchase_units?.[0]?.amount?.value;
      c.evidence = Object.assign(c.evidence, { normal: { orderId: normal, amount: av }, tampered: { orderId: tampered, amount: bv } });
      c.observe(`Normal checkout → PayPal order for ${av}. Tampered checkout → PayPal order for ${bv}.`);
      return av && bv && av === bv
        ? { verdict: "pass", summary: `Both orders are ${av}; the client price was ignored.` }
        : { verdict: "fail", summary: `The merchant created a PayPal order for ${bv} instead of ${av}.` };
    },
  },
  {
    id: "declined-capture",
    title: "Declined card is not marked as paid",
    category: "correctness",
    severity: "high",
    kb: ["orders-capture", "decline-handling", "negative-testing"],
    what: "Pays an order, then makes PayPal decline the merchant's capture (INSTRUMENT_DECLINED) and checks the merchant does not ship it.",
    risk: "You ship goods for payments that never arrived.",
    async run(c) {
      const { orderId, approveStatus, approveBody } = await buyerPays(c, { mock: "INSTRUMENT_DECLINED" });
      const pp = await c.pp.call("GET", `/v2/checkout/orders/${orderId}`, undefined, { note: "read order from PayPal" });
      const probe = await c.contract.probe(orderId);
      c.evidence = Object.assign(c.evidence, { orderId, paypalStatus: pp.body.status, approveStatus, approveBody, merchant: probe });
      c.observe(`PayPal order is ${pp.body.status} (never captured). Merchant /approve answered ${approveStatus}; merchant now says ${probe.status}, fulfilled ×${probe.fulfilled}.`);
      if (probe.status === "paid" || probe.fulfilled > 0)
        return { verdict: "fail", summary: "The merchant marked a declined payment as paid and fulfilled it." };
      return { verdict: "pass", summary: "Decline handled: order stays unpaid." };
    },
  },
  {
    id: "forged-webhook",
    title: "Forged webhook is rejected",
    category: "security",
    severity: "critical",
    kb: ["webhook-verify", "webhook-integrate"],
    what: "Creates an order nobody pays, then posts a fake PAYMENT.CAPTURE.COMPLETED webhook for it with an invalid signature.",
    risk: "Anyone who finds your webhook URL can mark any order as paid and get goods for free.",
    async run(c) {
      const orderId = await c.contract.checkout();
      const fakeCapture = "FORGED" + Math.random().toString(36).slice(2, 10).toUpperCase();
      const event = {
        id: "WH-FORGED-" + crypto.randomUUID(),
        event_version: "1.0",
        create_time: new Date().toISOString(),
        resource_type: "capture",
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        summary: "Payment completed for $ 25.0 USD",
        resource: {
          id: fakeCapture,
          status: "COMPLETED",
          amount: { currency_code: "USD", value: "25.00" },
          final_capture: true,
          supplementary_data: { related_ids: { order_id: orderId } },
        },
      };
      const status = await c.contract.postWebhook(event, {
        "paypal-transmission-id": crypto.randomUUID(),
        "paypal-transmission-time": new Date().toISOString(),
        "paypal-transmission-sig": "Zm9yZ2VkLXNpZ25hdHVyZQ==",
        "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-forged",
        "paypal-auth-algo": "SHA256withRSA",
      }, "forged PAYMENT.CAPTURE.COMPLETED (bad signature)");
      await sleep(1500);
      const probe = await c.contract.probe(orderId);
      c.evidence = Object.assign(c.evidence, { orderId, webhookHttp: status, merchant: probe });
      c.observe(`Webhook endpoint answered HTTP ${status}. Unpaid order now shows ${probe.status}, fulfilled ×${probe.fulfilled}.`);
      if (probe.status === "paid" || probe.fulfilled > 0)
        return { verdict: "fail", summary: "A forged, unsigned webhook marked an unpaid order as paid." };
      return { verdict: "pass", summary: `Forged webhook ignored (HTTP ${status}).` };
    },
  },
  {
    id: "webhook-replay",
    title: "Duplicate webhook delivery doesn't ship twice",
    category: "correctness",
    severity: "high",
    kb: ["webhook-integrate", "webhooks-api"],
    what: "Pays an order, waits for PayPal's real signed PAYMENT.CAPTURE.COMPLETED webhook, then asks PayPal to resend the same event.",
    risk: "PayPal retries deliveries; without de-duplication you ship the same order twice.",
    async run(c) {
      const st = c.state ?? {};
      if (!st.phase) {
        const hook = await merchantWebhook(c);
        if (!hook) return { verdict: "skip", summary: "No registered webhook to replay to (see webhook-config)." };
        const { orderId } = await buyerPays(c);
        const pp = await c.pp.call("GET", `/v2/checkout/orders/${orderId}`, undefined, { note: "read capture id" });
        const capId = captureOf(pp.body)?.id;
        if (!capId) return { verdict: "skip", summary: "Order was not captured, so PayPal sends no capture event." };
        c.observe(`Paid order ${orderId}; waiting for PayPal to deliver its real capture event.`);
        return { verdict: "pending", summary: "Waiting for PayPal's capture webhook…", retryAfterMs: 15000,
          state: { phase: "await-event", orderId, capId, hookId: hook.id, t0: Date.now() } };
      }
      c.evidence.orderId = st.orderId;
      if (st.phase === "await-event") {
        const since = new Date(st.t0 - 5 * 60 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
        const r = await c.pp.call("GET", `/v1/notifications/webhooks-events?page_size=25&event_type=PAYMENT.CAPTURE.COMPLETED&start_time=${since}`, undefined, { note: "has PayPal emitted the event yet?" });
        const ev = (r.body?.events ?? []).find((e: any) => e.resource?.id === st.capId);
        if (!ev) {
          if (Date.now() - st.t0 > MAX_WAIT_MS) return { verdict: "skip", summary: "PayPal's sandbox didn't emit the capture event within 7 minutes; nothing to replay." };
          return { verdict: "pending", summary: `Waiting for PayPal's capture webhook (${Math.round((Date.now() - st.t0) / 1000)} s)…`, retryAfterMs: 15000, state: st };
        }
        // Give the first delivery time to be processed, then replay it.
        await sleep(8000);
        const before = await c.contract.probe(st.orderId, "state after PayPal's first delivery");
        await c.pp.call("POST", `/v1/notifications/webhooks-events/${ev.id}/resend`, { webhook_ids: [st.hookId] }, { note: "PayPal resends the same signed event" });
        c.observe(`PayPal emitted ${ev.id}. After the first delivery the merchant had fulfilled ×${before.fulfilled}; asked PayPal to resend it.`);
        return { verdict: "pending", summary: "Asked PayPal to resend the event; checking for double fulfilment…", retryAfterMs: 15000,
          state: { ...st, phase: "resent", eventId: ev.id, before, tResent: Date.now() } };
      }
      // phase "resent"
      const after = await c.contract.probe(st.orderId, "state after the duplicate delivery");
      Object.assign(c.evidence, { eventId: st.eventId, before: st.before, after });
      if (after.fulfilled > 1) {
        c.observe(`Event ${st.eventId}: fulfilled ×${st.before.fulfilled} after the first delivery, ×${after.fulfilled} after PayPal's resend.`);
        return { verdict: "fail", summary: `One payment, ${after.fulfilled} shipments: duplicate deliveries aren't de-duplicated.` };
      }
      if (Date.now() - st.tResent < 45000) return { verdict: "pending", summary: "Watching for a second shipment…", retryAfterMs: 15000, state: st };
      c.observe(`Event ${st.eventId} delivered twice; the merchant still shows a single fulfilment.`);
      return { verdict: "pass", summary: "Duplicate delivery de-duplicated: shipped once." };
    },
  },
  {
    id: "refund-sync",
    title: "Refund made outside checkout reaches the merchant",
    category: "correctness",
    severity: "medium",
    kb: ["refunds", "webhook-events"],
    what: "Pays an order, refunds it directly through PayPal (as if from the PayPal dashboard), waits for PayPal's refund webhook, then checks the merchant's records.",
    risk: "Your books and stock say 'paid' for money you already gave back.",
    async run(c) {
      const st = c.state ?? {};
      if (!st.phase) {
        const { orderId } = await buyerPays(c);
        const pp = await c.pp.call("GET", `/v2/checkout/orders/${orderId}`, undefined, { note: "read capture id" });
        const capId = captureOf(pp.body)?.id;
        if (!capId) return { verdict: "skip", summary: "Order was not captured, so there is nothing to refund." };
        const rf = await c.pp.call("POST", `/v2/payments/captures/${capId}/refund`, {}, { note: "full refund via PayPal (dashboard-style)" });
        c.observe(`Paid order ${orderId}, then refunded it through PayPal (refund ${rf.body?.id ?? "?"}).`);
        return { verdict: "pending", summary: "Refunded through PayPal; waiting for PayPal's refund webhook…", retryAfterMs: 15000,
          state: { phase: "await", orderId, capId, refundId: rf.body?.id, t0: Date.now() } };
      }
      Object.assign(c.evidence, { orderId: st.orderId, captureId: st.capId, refundId: st.refundId });
      const p = await c.contract.probe(st.orderId, "has the refund reached the merchant?");
      if (p.status === "refunded") {
        c.observe("The merchant marked the order refunded.");
        return { verdict: "pass", summary: "Refund synced via webhook." };
      }
      if (!st.deliveredAt) {
        const since = new Date(st.t0 - 5 * 60 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
        const r = await c.pp.call("GET", `/v1/notifications/webhooks-events?page_size=25&event_type=PAYMENT.CAPTURE.REFUNDED&start_time=${since}`, undefined, { note: "has PayPal emitted the refund event?" });
        const ev = (r.body?.events ?? []).find((e: any) => e.resource?.id === st.refundId);
        if (ev) return { verdict: "pending", summary: "PayPal sent the refund webhook; giving the merchant time to process it…", retryAfterMs: 15000, state: { ...st, deliveredAt: Date.now(), eventId: ev.id } };
        if (Date.now() - st.t0 > MAX_WAIT_MS) return { verdict: "skip", summary: "PayPal's sandbox didn't emit the refund event within 7 minutes." };
        return { verdict: "pending", summary: `Waiting for PayPal's refund webhook (${Math.round((Date.now() - st.t0) / 1000)} s)…`, retryAfterMs: 15000, state: st };
      }
      if (Date.now() - st.deliveredAt < 60000) return { verdict: "pending", summary: "PayPal sent the refund webhook; giving the merchant time to process it…", retryAfterMs: 15000, state: st };
      c.evidence.eventId = st.eventId;
      c.observe(`PayPal emitted refund event ${st.eventId}; a minute later the merchant still says ${p.status}.`);
      return { verdict: "fail", summary: "PayPal sent the refund webhook, but the merchant still says the order is paid." };
    },
  },
];

export const scenarioById = (id: string) => SCENARIOS.find((s) => s.id === id);

export async function runScenario(s: Scenario, target: Target, pp: PayPal, contract: Contract, calls: CallLog[], state?: Record<string, any>): Promise<ScenarioResult> {
  const t0 = Date.now();
  const observations: string[] = [];
  const ctx: Ctx = { pp, contract, target, observe: (o) => observations.push(o), evidence: {}, state };
  try {
    const r = await s.run(ctx);
    return { id: s.id, ...r, observations, evidence: ctx.evidence, calls, durationMs: Date.now() - t0 };
  } catch (e: any) {
    return { id: s.id, verdict: "error", summary: String(e?.message ?? e), observations, evidence: ctx.evidence, calls, durationMs: Date.now() - t0 };
  }
}

/** Deterministic go-live verdict. The AI can explain it but never override it. */
export function readiness(results: Pick<ScenarioResult, "id" | "verdict">[]) {
  const failed = results.filter((r) => r.verdict === "fail").map((r) => scenarioById(r.id)!);
  const blockers = failed.filter((s) => s.severity === "critical" || s.severity === "high");
  const ran = results.filter((r) => r.verdict === "pass" || r.verdict === "fail").length;
  const passed = results.filter((r) => r.verdict === "pass").length;
  return {
    ready: blockers.length === 0 && ran > 0,
    score: ran ? Math.round((passed / ran) * 100) : 0,
    blockers: blockers.map((s) => s.id),
    failed: failed.map((s) => s.id),
  };
}
