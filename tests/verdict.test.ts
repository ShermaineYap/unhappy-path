import { describe, expect, it } from "vitest";
import { readiness, SCENARIOS } from "../src/lib/scenarios";
import { resolveTarget } from "../src/lib/targets";
import { DOCS } from "../src/lib/knowledge";

describe("readiness", () => {
  it("blocks go-live when a critical scenario fails", () => {
    const r = readiness([{ id: "happy-path", verdict: "pass" }, { id: "forged-webhook", verdict: "fail" }]);
    expect(r.ready).toBe(false);
    expect(r.blockers).toEqual(["forged-webhook"]);
    expect(r.score).toBe(50);
  });
  it("allows go-live when only a medium scenario fails", () => {
    const r = readiness([{ id: "happy-path", verdict: "pass" }, { id: "refund-sync", verdict: "fail" }]);
    expect(r.ready).toBe(true);
  });
  it("is never ready when nothing ran", () => {
    expect(readiness([{ id: "webhook-replay", verdict: "skip" }]).ready).toBe(false);
  });
});

describe("catalogue", () => {
  it("every scenario cites docs that exist", () => {
    for (const s of SCENARIOS) for (const k of s.kb) expect(DOCS.find((d) => d.id === k), `${s.id} -> ${k}`).toBeTruthy();
  });
  it("ids are unique", () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
  });
});

describe("resolveTarget", () => {
  const base = { kind: "custom" as const, clientId: "abc", clientSecret: "def", contractBase: "https://shop.example.com/api/uhp", webhookUrl: "https://shop.example.com/hook" };
  it("accepts public https targets", () => {
    expect(resolveTarget(base, "https://x").target.contractBase).toBe("https://shop.example.com/api/uhp");
  });
  it("rejects http and private addresses", () => {
    expect(() => resolveTarget({ ...base, contractBase: "http://shop.example.com" }, "https://x")).toThrow(/https/);
    expect(() => resolveTarget({ ...base, webhookUrl: "https://192.168.1.10/hook" }, "https://x")).toThrow(/Private/);
    expect(() => resolveTarget({ ...base, contractBase: "https://localhost/x" }, "https://x")).toThrow(/Private/);
  });
  it("demo targets point at this deployment", () => {
    const t = resolveTarget({ kind: "demo-fixed" }, "https://uhp.vercel.app").target;
    expect(t.webhookUrl).toBe("https://uhp.vercel.app/api/demo/fixed/webhook");
  });
});
