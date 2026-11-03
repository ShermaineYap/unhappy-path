import { SCENARIOS } from "@/lib/scenarios";
import { aiEnabled } from "@/lib/ai";
import recorded from "@/data/recorded.json";
import App from "./App";

export const dynamic = "force-dynamic";

export default function Page() {
  const catalogue = SCENARIOS.map(({ id, title, category, severity, what, risk }) => ({ id, title, category, severity, what, risk }));
  return <App catalogue={catalogue} aiOn={aiEnabled()} recorded={recorded as any} />;
}
