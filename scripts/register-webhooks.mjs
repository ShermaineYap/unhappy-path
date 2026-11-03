// Registers the demo store's two webhooks on the sandbox app.
// Usage: PUBLIC_BASE_URL=https://your-app.vercel.app node scripts/register-webhooks.mjs
import fs from "node:fs";
const env = { ...process.env };
if (fs.existsSync(".env.local"))
  for (const l of fs.readFileSync(".env.local", "utf8").split("\n"))
    if (l.includes("=") && !l.startsWith("#")) env[l.slice(0, l.indexOf("="))] ??= l.slice(l.indexOf("=") + 1);
const base = env.PUBLIC_BASE_URL?.replace(/\/$/, "");
if (!base) throw new Error("Set PUBLIC_BASE_URL");
const B = "https://api-m.sandbox.paypal.com";
const auth = await fetch(B + "/v1/oauth2/token", { method: "POST", headers: { Authorization: "Basic " + Buffer.from(env.PAYPAL_CLIENT_ID + ":" + env.PAYPAL_CLIENT_SECRET).toString("base64") }, body: "grant_type=client_credentials" });
const { access_token } = await auth.json();
const h = { Authorization: "Bearer " + access_token, "Content-Type": "application/json" };
const events = ["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.REFUNDED", "CUSTOMER.DISPUTE.CREATED", "CUSTOMER.DISPUTE.UPDATED", "CUSTOMER.DISPUTE.RESOLVED"];
const existing = (await (await fetch(B + "/v1/notifications/webhooks", { headers: h })).json()).webhooks ?? [];
for (const mode of ["buggy", "fixed"]) {
  const url = `${base}/api/demo/${mode}/webhook`;
  let hook = existing.find((w) => w.url === url);
  if (!hook) {
    const r = await fetch(B + "/v1/notifications/webhooks", { method: "POST", headers: h, body: JSON.stringify({ url, event_types: events.map((name) => ({ name })) }) });
    hook = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(hook));
  }
  console.log(`${mode}: ${hook.id}  ${url}`);
}
