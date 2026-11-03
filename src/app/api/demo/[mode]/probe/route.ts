import { probe } from "@/lib/demostore";
import { modeOf } from "../_mode";
export const dynamic = "force-dynamic";
export async function GET(req: Request, { params }: { params: Promise<{ mode: string }> }) {
  const mode = modeOf((await params).mode);
  if (!mode) return Response.json({ error: "unknown mode" }, { status: 404 });
  const id = new URL(req.url).searchParams.get("order_id") ?? "";
  const p = await probe(mode, id);
  return p ? Response.json(p) : Response.json({ error: "unknown order" }, { status: 404 });
}
