import { Contract } from "@/lib/contract";
import { PayPal, type CallLog } from "@/lib/paypal";
import { runScenario, scenarioById } from "@/lib/scenarios";
import { originOf, resolveTarget, type TargetInput } from "@/lib/targets";
import { kv } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Runs ONE scenario per request so each stays inside serverless time limits and
// the UI can stream the timeline scenario by scenario.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { target: TargetInput; scenarioId: string; state?: Record<string, any> };
  const s = scenarioById(body.scenarioId);
  if (!s) return Response.json({ error: "unknown scenario" }, { status: 400 });

  const ip = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  const n = await kv.incr(`rl:run:${ip}:${new Date().toISOString().slice(0, 13)}`);
  if (n > 900) return Response.json({ error: "Rate limit: try again next hour." }, { status: 429 });

  let resolved;
  try {
    resolved = resolveTarget(body.target, originOf(req));
  } catch (e: any) {
    return Response.json({ error: String(e?.message ?? e) }, { status: 400 });
  }
  const calls: CallLog[] = [];
  const log = (c: CallLog) => calls.push(c);
  const pp = new PayPal(resolved.creds, log);
  const contract = new Contract(resolved.target, log);
  const result = await runScenario(s, resolved.target, pp, contract, calls, body.state);
  return Response.json(result);
}
