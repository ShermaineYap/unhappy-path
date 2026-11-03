import type { Mode } from "@/lib/demostore";
export function modeOf(m: string): Mode | null {
  return m === "buggy" || m === "fixed" ? m : null;
}
