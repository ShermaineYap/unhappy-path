// The Unhappy Path test contract: three tiny sandbox-only endpoints a merchant
// adds so the agent can drive their real checkout code and read back their
// internal state. See README "Test contract".
//
//   POST {base}/checkout   {sku, quantity, price?}          -> {order_id}
//   POST {base}/approve    {order_id}  (+ X-Unhappy-Mock)   -> merchant runs its capture code
//   GET  {base}/probe?order_id=...                          -> {status, fulfilled, amount}
//
// plus the merchant's normal PayPal webhook URL.

import type { CallLog } from "./paypal";

export type Target = {
  name: string;
  contractBase: string; // e.g. https://shop.example.com/api/unhappy-path
  webhookUrl: string; // the URL registered as a webhook on the PayPal app
  sku?: string;
};

export type Probe = {
  status: "pending" | "paid" | "refunded" | "failed" | "unknown";
  fulfilled: number;
  amount?: string;
};

export class Contract {
  constructor(
    private t: Target,
    private log?: (c: CallLog) => void,
  ) {}

  private async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, note?: string) {
    const url = this.t.contractBase.replace(/\/$/, "") + path;
    const t0 = Date.now();
    let status = 0;
    let json: any = {};
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(25000),
      });
      status = res.status;
      const text = await res.text();
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text.slice(0, 200) };
      }
    } catch (e: any) {
      json = { error: String(e?.message ?? e) };
    }
    this.log?.({
      at: new Date().toISOString(),
      actor: "merchant",
      method,
      url: new URL(url).pathname,
      status,
      ms: Date.now() - t0,
      note,
    });
    return { status, json };
  }

  async checkout(opts: { quantity?: number; price?: string } = {}) {
    const r = await this.req(
      "POST",
      "/checkout",
      { sku: this.t.sku ?? "tee-classic", quantity: opts.quantity ?? 1, ...(opts.price ? { price: opts.price } : {}) },
      {},
      opts.price ? `checkout with tampered client price ${opts.price}` : "checkout",
    );
    if (r.status >= 400 || !r.json.order_id) throw new Error(`Merchant /checkout failed (${r.status})`);
    return r.json.order_id as string;
  }

  async approve(orderId: string, mock?: string) {
    return this.req(
      "POST",
      "/approve",
      { order_id: orderId },
      mock ? { "X-Unhappy-Mock": JSON.stringify({ mock_application_codes: mock }) } : {},
      mock ? `approve (PayPal will answer ${mock})` : "approve → merchant captures",
    );
  }

  async probe(orderId: string, note = "probe merchant state"): Promise<Probe> {
    const r = await this.req("GET", `/probe?order_id=${encodeURIComponent(orderId)}`, undefined, {}, note);
    if (r.status >= 400) return { status: "unknown", fulfilled: 0 };
    return { status: r.json.status ?? "unknown", fulfilled: Number(r.json.fulfilled ?? 0), amount: r.json.amount };
  }

  async postWebhook(event: unknown, headers: Record<string, string>, note: string) {
    const t0 = Date.now();
    let status = 0;
    try {
      const res = await fetch(this.t.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(event),
        cache: "no-store",
        signal: AbortSignal.timeout(20000),
      });
      status = res.status;
    } catch {
      status = 0;
    }
    this.log?.({
      at: new Date().toISOString(),
      actor: "merchant",
      method: "POST",
      url: new URL(this.t.webhookUrl).pathname,
      status,
      ms: Date.now() - t0,
      note,
    });
    return status;
  }
}
