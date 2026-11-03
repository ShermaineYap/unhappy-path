import { approve } from "@/lib/demostore";
import { modeOf } from "../_mode";
export const dynamic = "force-dynamic";
export async function POST(req: Request, { params }: { params: Promise<{ mode: string }> }) {
  const mode = modeOf((await params).mode);
  if (!mode) return Response.json({ error: "unknown mode" }, { status: 404 });
  const { order_id } = await req.json().catch(() => ({}));
  const r = await approve(mode, String(order_id ?? ""), req.headers.get("x-unhappy-mock"));
  return Response.json(r.body, { status: r.http });
}
