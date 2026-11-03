// Best-effort in-memory storage for rate limits and cached AI explanations.
// (The demo store keeps its real records inside PayPal; see demostore.ts.)
type KV = {
  get<T>(k: string): Promise<T | null>;
  set(k: string, v: unknown, ttlSec?: number): Promise<void>;
  incr(k: string): Promise<number>;
};
const g = globalThis as any;
g.__uhpMem ??= new Map<string, { v: unknown; exp: number }>();
const m: Map<string, { v: unknown; exp: number }> = g.__uhpMem;
export const kv: KV = {
  async get<T>(k: string) {
    const e = m.get(k);
    if (!e || e.exp < Date.now()) return null;
    return e.v as T;
  },
  async set(k, v, ttl = 3600) {
    m.set(k, { v, exp: Date.now() + ttl * 1000 });
  },
  async incr(k) {
    const n = Number((await this.get<number>(k)) ?? 0) + 1;
    m.set(k, { v: n, exp: Date.now() + 3600 * 1000 });
    return n;
  },
};
