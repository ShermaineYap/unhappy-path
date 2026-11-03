// Key-value storage: Upstash Redis when configured (Vercel), in-memory otherwise.
import { Redis } from "@upstash/redis";

type KV = {
  get<T>(k: string): Promise<T | null>;
  set(k: string, v: unknown, ttlSec?: number): Promise<void>;
  setnx(k: string, v: unknown, ttlSec?: number): Promise<boolean>;
  incr(k: string): Promise<number>;
};

const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

function memory(): KV {
  const g = globalThis as any;
  g.__uhpMem ??= new Map<string, unknown>();
  const m: Map<string, unknown> = g.__uhpMem;
  return {
    async get<T>(k: string) {
      return (m.has(k) ? (m.get(k) as T) : null);
    },
    async set(k, v) {
      m.set(k, v);
    },
    async setnx(k, v) {
      if (m.has(k)) return false;
      m.set(k, v);
      return true;
    },
    async incr(k) {
      const n = Number(m.get(k) ?? 0) + 1;
      m.set(k, n);
      return n;
    },
  };
}

function redis(): KV {
  const r = new Redis({ url: url!, token: token! });
  const TTL = 60 * 60 * 24 * 30;
  return {
    async get<T>(k: string) {
      return (await r.get<T>(k)) ?? null;
    },
    async set(k, v, ttl = TTL) {
      await r.set(k, v, { ex: ttl });
    },
    async setnx(k, v, ttl = TTL) {
      return (await r.set(k, v, { nx: true, ex: ttl })) === "OK";
    },
    async incr(k) {
      return r.incr(k);
    },
  };
}

export const kv: KV = url && token ? redis() : memory();
export const kvKind = url && token ? "redis" : "memory";
