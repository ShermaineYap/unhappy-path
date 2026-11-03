import { plan } from "@/lib/ai";
import { PayPal } from "@/lib/paypal";
import { kv } from "@/lib/store";
import recorded from "@/data/recorded.json";
import { originOf, resolveTarget, type TargetInput } from "@/lib/targets";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function fetchReadme(repoUrl?: string) {
  if (!repoUrl) return undefined;
  const m = repoUrl.match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (!m) return undefined;
  for (const branch of ["main", "master"]) {
    const r = await fetch(`https://raw.githubusercontent.com/${m[1]}/${m[2].replace(/\.git$/, "")}/${branch}/README.md`, { cache: "no-store" }).catch(() => null);
    if (r?.ok) return (await r.text()).slice(0, 8000);
  }
  return undefined;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { target: TargetInput; repoUrl?: string };
  let resolved;
  try {
    resolved = resolveTarget(body.target, originOf(req));
  } catch (e: any) {
    return Response.json({ error: String(e?.message ?? e) }, { status: 400 });
  }
  const { target, creds, demo } = resolved;
  const pp = new PayPal(creds);
  let subs: string[] | null = null;
  try {
    const r = await pp.call("GET", "/v1/notifications/webhooks");
    const hook = (r.body?.webhooks ?? []).find((h: any) => h.url.replace(/\/$/, "") === target.webhookUrl);
    subs = hook ? hook.event_types.map((e: any) => e.name) : null;
  } catch (e: any) {
    return Response.json({ error: String(e?.message ?? e) }, { status: 400 });
  }
  const health = await fetch(`${target.contractBase}/probe?order_id=health-check`, { cache: "no-store", signal: AbortSignal.timeout(10000) }).catch(() => null);
  const contractReachable = !!health && health.status < 500;
  const readme = demo
    ? "Kedai Kopi is a demo Malaysian coffee shop on Next.js. Checkout uses PayPal Orders v2 (intent CAPTURE). A webhook handler processes PAYMENT.CAPTURE.* events."
    : await fetchReadme(body.repoUrl);
  const ctx = { targetName: target.name, readme, webhookSubscriptions: subs, contractReachable, demo };
  const cacheKey = demo ? `plan:v1:${body.target.kind}:${JSON.stringify(subs)}:${contractReachable}` : null;
  let p: any = cacheKey ? await kv.get(cacheKey) : null;
  if (!p) {
    p = await plan(ctx);
    if (p.source === "ai" && cacheKey) await kv.set(cacheKey, p, 60 * 60 * 6);
  }
  // Free-tier Gemini quota runs out quickly; for the demo shop, reuse the plan Gemini
  // wrote on an earlier run with the same webhook setup (labelled as recorded).
  if (p.source === "rules" && demo) {
    const rec = (recorded as any)[body.target.kind === "demo-buggy" ? "buggy" : "fixed"]?.plan;
    if (rec?.source === "ai") p = { ...rec, source: "ai-recorded" };
  }
  return Response.json({ ...p, target: { name: target.name, contractBase: target.contractBase, webhookUrl: target.webhookUrl }, contractReachable, webhookSubscriptions: subs });
}
