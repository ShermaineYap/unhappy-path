import { checkout } from "@/lib/demostore";
import { modeOf } from "../_mode";
export const dynamic = "force-dynamic";
export async function POST(req: Request, { params }: { params: Promise<{ mode: string }> }) {
  const mode = modeOf((await params).mode);
  if (!mode) return Response.json({ error: "unknown mode" }, { status: 404 });
  try {
    return Response.json(await checkout(mode, await req.json().catch(() => ({}))));
  } catch (e: any) {
    return Response.json({ error: String(e?.message ?? e) }, { status: 502 });
  }
}
