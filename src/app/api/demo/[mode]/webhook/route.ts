import { webhook } from "@/lib/demostore";
import { modeOf } from "../_mode";
export const dynamic = "force-dynamic";
export async function POST(req: Request, { params }: { params: Promise<{ mode: string }> }) {
  const mode = modeOf((await params).mode);
  if (!mode) return Response.json({ error: "unknown mode" }, { status: 404 });
  const event = await req.json().catch(() => null);
  if (!event) return Response.json({ error: "bad json" }, { status: 400 });
  const r = await webhook(mode, req.headers, event);
  return Response.json(r.body, { status: r.http });
}
