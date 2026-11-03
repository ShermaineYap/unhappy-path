// Runs the full scenario suite against a deployment from the command line,
// following "pending" scenarios until they finish. Used for the measured study
// and to record the demo replays.
//
//   node scripts/run-suite.mjs https://unhappy-path.vercel.app demo-buggy [out.json]

import fs from "node:fs";

const [base, kind, out, flag] = process.argv.slice(2);
if (!base || !kind) throw new Error("usage: run-suite.mjs BASE demo-buggy|demo-fixed [out.json]");
const target = { kind };
const post = async (path, body) => {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: r.ok, status: r.status, json: await r.json().catch(() => ({})) };
};

const t0 = Date.now();
const plan = (await post("/api/plan", { target })).json;
const ids = plan.steps.filter((s) => s.include).map((s) => s.id);
const SLOW = new Set(["webhook-replay", "refund-sync"]);

async function runOne(id) {
  let state, total = 0;
  const calls = [], observations = [];
  const started = Date.now();
  for (;;) {
    const r = await post("/api/run", { target, scenarioId: id, state });
    if (!r.ok) return { id, verdict: "error", summary: r.json.error ?? `HTTP ${r.status}`, observations, evidence: {}, calls, durationMs: Date.now() - started };
    calls.push(...r.json.calls);
    observations.push(...r.json.observations);
    total += r.json.durationMs;
    if (r.json.verdict !== "pending") {
      const res = { ...r.json, calls, observations, durationMs: Date.now() - started, activeMs: total };
      console.log(`${res.verdict.padEnd(5)} ${id.padEnd(16)} ${(res.durationMs / 1000).toFixed(1)}s  ${res.summary}`);
      return res;
    }
    state = r.json.state;
    await new Promise((ok) => setTimeout(ok, r.json.retryAfterMs ?? 15000));
  }
}

const slow = ids.filter((id) => SLOW.has(id)).map(runOne);
const fast = [];
for (const id of ids.filter((id) => !SLOW.has(id))) fast.push(await runOne(id));
const results = [...fast, ...(await Promise.all(slow))].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));

const explanations = [];
for (const r of flag === "--no-explain" ? [] : results.filter((x) => x.verdict === "fail")) {
  const e = await post("/api/explain", { target, result: r });
  if (e.ok) explanations.push(e.json);
}
const record = { plan, results, explanations, recordedAt: new Date().toISOString(), wallMs: Date.now() - t0 };
console.log(`total ${(record.wallMs / 1000).toFixed(0)}s, ${explanations.length} explanations (${explanations.map((e) => e.source).join(",")})`);
if (out) fs.writeFileSync(out, JSON.stringify(record, null, 2));
