// Minimal PayPal REST client for the SANDBOX. Every call is recorded so the UI
// can show a timeline of exactly what Unhappy Path did against PayPal.

export const PAYPAL_BASE = "https://api-m.sandbox.paypal.com";

export type Creds = { clientId: string; clientSecret: string };

export type CallLog = {
  at: string;
  actor: "unhappy-path" | "merchant" | "paypal";
  method: string;
  url: string;
  status: number;
  ms: number;
  note?: string;
  issue?: string;
};

const tokenCache = new Map<string, { token: string; exp: number }>();

export async function getToken(creds: Creds): Promise<string> {
  const key = creds.clientId;
  const hit = tokenCache.get(key);
  if (hit && Date.now() < hit.exp) return hit.token;
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization:
        "Basic " + Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status}). Check the sandbox client ID and secret.`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache.set(key, { token: j.access_token, exp: Date.now() + (j.expires_in - 120) * 1000 });
  return j.access_token;
}

export type PPResponse<T = any> = { status: number; body: T; ms: number };

export class PayPal {
  constructor(
    private creds: Creds,
    private log?: (c: CallLog) => void,
  ) {}

  async call<T = any>(
    method: string,
    path: string,
    body?: unknown,
    opts: { headers?: Record<string, string>; requestId?: string | false; note?: string } = {},
  ): Promise<PPResponse<T>> {
    const token = await getToken(this.creds);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(opts.headers ?? {}),
    };
    if (opts.requestId !== false && (method === "POST" || method === "PATCH")) {
      headers["PayPal-Request-Id"] = opts.requestId ?? crypto.randomUUID();
    }
    const t0 = Date.now();
    const res = await fetch(PAYPAL_BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    const ms = Date.now() - t0;
    const text = await res.text();
    let parsed: any = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text.slice(0, 300) };
    }
    this.log?.({
      at: new Date().toISOString(),
      actor: "unhappy-path",
      method,
      url: path.split("?")[0],
      status: res.status,
      ms,
      note: opts.note,
      issue: parsed?.details?.[0]?.issue ?? (res.ok ? undefined : parsed?.name),
    });
    return { status: res.status, body: parsed as T, ms };
  }
}

export const TEST_CARD = {
  number: "4012888888881881",
  expiry: "2030-12",
  security_code: "123",
  name: "Unhappy Path Test Buyer",
};

export function captureOf(order: any): any | undefined {
  return order?.purchase_units?.[0]?.payments?.captures?.[0];
}
