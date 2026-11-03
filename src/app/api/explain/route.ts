import { explain, rulesExplain } from "@/lib/ai";
import type { ScenarioResult } from "@/lib/scenarios";
import { originOf, resolveTarget, type TargetInput } from "@/lib/targets";
import { kv } from "@/lib/store";
import recorded from "@/data/recorded.json";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { target: TargetInput; result: ScenarioResult; stack?: string };
  let resolved;
  try {
    resolved = resolveTarget(body.target, originOf(req));
  } catch (e: any) {
    return Response.json({ error: String(e?.message ?? e) }, { status: 400 });
  }
  const r = body.result;
  if (!r?.id) return Response.json({ error: "missing result" }, { status: 400 });
  // Demo targets: cache per scenario+verdict so judges' clicks don't burn free-tier quota.
  const cacheKey = resolved.demo ? `explain:v1:${body.target.kind}:${r.id}:${r.verdict}` : null;
  if (cacheKey) {
    const hit = await kv.get(cacheKey);
    if (hit) return Response.json(hit);
  }
  const ip = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  const n = await kv.incr(`rl:explain:${ip}:${new Date().toISOString().slice(0, 13)}`);
  let e: any = n > 30 ? rulesExplain(r) : await explain(r, resolved.creds, body.stack);
  // Free-tier Gemini quota runs out quickly; for the demo shop, fall back to the
  // AI explanation recorded on an earlier run of the same scenario (labelled as such).
  if (e.source === "rules" && resolved.demo) {
    const rec = (recorded as any)[body.target.kind === "demo-buggy" ? "buggy" : "fixed"];
    const hit = rec?.explanations?.find((x: any) => x.id === r.id && x.source === "ai");
    if (hit) e = { ...hit, source: "ai-recorded", recordedAt: rec.recordedAt };
  }
  if (cacheKey && e.source === "ai") await kv.set(cacheKey, e, 60 * 60 * 24 * 7);
  return Response.json(e);
}
