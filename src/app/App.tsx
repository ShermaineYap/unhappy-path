"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

type Meta = { id: string; title: string; category: string; severity: "critical" | "high" | "medium"; what: string; risk: string };
type CallLog = { at: string; actor: string; method: string; url: string; status: number; ms: number; note?: string; issue?: string };
type Result = { id: string; verdict: "pass" | "fail" | "skip" | "error"; summary: string; observations: string[]; evidence: any; calls: CallLog[]; durationMs: number };
type PlanStep = { id: string; include: boolean; reason: string };
type Plan = { steps: PlanStep[]; summary: string; source: "ai" | "rules"; model?: string; target: { name: string; contractBase: string; webhookUrl: string }; contractReachable: boolean; webhookSubscriptions: string[] | null };
type Explanation = { id: string; headline: string; rootCause: string; impact: string; fix: { language: string; code: string }; citations: { id: string; title: string; url: string }[]; toolCalls: string[]; source: "ai" | "rules" };
type Recording = { plan: Plan; results: Result[]; explanations: Explanation[]; recordedAt: string } | null;

type TargetKind = "demo-buggy" | "demo-fixed" | "custom";

const VERDICT_LABEL = { pass: "Passed", fail: "Failed", skip: "Skipped", error: "Error" } as const;

export default function App({ catalogue, aiOn, recorded }: { catalogue: Meta[]; aiOn: boolean; recorded: { buggy: Recording; fixed: Recording } }) {
  const meta = useMemo(() => Object.fromEntries(catalogue.map((m) => [m.id, m])), [catalogue]);
  const [kind, setKind] = useState<TargetKind>("demo-buggy");
  const [custom, setCustom] = useState({ name: "", contractBase: "", webhookUrl: "", clientId: "", clientSecret: "", repoUrl: "" });
  const [plan, setPlan] = useState<Plan | null>(null);
  const [include, setInclude] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, Result>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "planning" | "planned" | "running" | "done">("idle");
  const [explanations, setExplanations] = useState<Record<string, Explanation | "loading">>({});
  const [error, setError] = useState<string | null>(null);
  const [replayed, setReplayed] = useState<string | null>(null);

  const target = () =>
    kind === "custom"
      ? { kind, name: custom.name, contractBase: custom.contractBase, webhookUrl: custom.webhookUrl, clientId: custom.clientId, clientSecret: custom.clientSecret }
      : { kind };

  function reset() {
    setPlan(null);
    setResults({});
    setExplanations({});
    setError(null);
    setReplayed(null);
    setPhase("idle");
  }

  async function doPlan() {
    reset();
    setPhase("planning");
    try {
      const r = await fetch("/api/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: target(), repoUrl: custom.repoUrl || undefined }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `Planning failed (${r.status})`);
      setPlan(j);
      setInclude(Object.fromEntries(j.steps.map((s: PlanStep) => [s.id, s.include])));
      setPhase("planned");
    } catch (e: any) {
      setError(String(e.message ?? e));
      setPhase("idle");
    }
  }

  async function doRun() {
    if (!plan) return;
    setResults({});
    setExplanations({});
    setPhase("running");
    const ids = plan.steps.filter((s) => include[s.id]).map((s) => s.id);
    const got: Result[] = [];
    for (const id of ids) {
      setRunning(id);
      try {
        const r = await fetch("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: target(), scenarioId: id }) });
        const j = await r.json();
        const res: Result = r.ok ? j : { id, verdict: "error", summary: j.error ?? `HTTP ${r.status}`, observations: [], evidence: {}, calls: [], durationMs: 0 };
        got.push(res);
        setResults((prev) => ({ ...prev, [id]: res }));
      } catch (e: any) {
        setResults((prev) => ({ ...prev, [id]: { id, verdict: "error", summary: String(e.message ?? e), observations: [], evidence: {}, calls: [], durationMs: 0 } }));
      }
    }
    setRunning(null);
    setPhase("done");
    for (const res of got.filter((g) => g.verdict === "fail")) explainOne(res);
  }

  async function explainOne(res: Result) {
    setExplanations((p) => ({ ...p, [res.id]: "loading" }));
    try {
      const r = await fetch("/api/explain", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: target(), result: res }) });
      const j = await r.json();
      if (r.ok) setExplanations((p) => ({ ...p, [res.id]: j }));
    } catch {
      /* explanation is optional */
    }
  }

  function replay(which: "buggy" | "fixed") {
    const rec = recorded[which];
    if (!rec) return;
    reset();
    setKind(which === "buggy" ? "demo-buggy" : "demo-fixed");
    setPlan(rec.plan);
    setInclude(Object.fromEntries(rec.plan.steps.map((s) => [s.id, s.include])));
    setResults(Object.fromEntries(rec.results.map((r) => [r.id, r])));
    setExplanations(Object.fromEntries(rec.explanations.map((e) => [e.id, e])));
    setReplayed(rec.recordedAt);
    setPhase("done");
  }

  const order = plan?.steps.map((s) => s.id) ?? [];
  const done = order.filter((id) => results[id]).map((id) => results[id]);
  const verdict = useMemo(() => {
    const ran = done.filter((r) => r.verdict === "pass" || r.verdict === "fail");
    const failed = done.filter((r) => r.verdict === "fail");
    const blockers = failed.filter((r) => ["critical", "high"].includes(meta[r.id]?.severity));
    return { ran: ran.length, passed: ran.length - failed.length, failed, blockers, ready: ran.length > 0 && blockers.length === 0, score: ran.length ? Math.round(((ran.length - failed.length) / ran.length) * 100) : 0 };
  }, [done, meta]);

  function downloadReport() {
    const lines = [
      `# Unhappy Path report — ${plan?.target.name}`,
      ``,
      `Verdict: **${verdict.ready ? "Ready for go-live" : "Not ready for go-live"}** · ${verdict.passed}/${verdict.ran} scenarios passed`,
      ``,
      ...order.filter((id) => results[id]).flatMap((id) => {
        const r = results[id];
        const e = explanations[id];
        const out = [`## ${VERDICT_LABEL[r.verdict]}: ${meta[id].title} (${meta[id].severity})`, ``, r.summary, ``, ...r.observations.map((o) => `- ${o}`), ``];
        if (e && e !== "loading") out.push(`**Root cause.** ${e.rootCause}`, ``, `**Impact.** ${e.impact}`, ``, "```" + e.fix.language, e.fix.code, "```", ``, ...e.citations.map((c) => `- [${c.title}](${c.url})`), ``);
        return out;
      }),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "unhappy-path-report.md";
    a.click();
  }

  const customReady = custom.contractBase && custom.webhookUrl && custom.clientId && custom.clientSecret;

  return (
    <main className="wrap">
      <header className="top">
        <Link className="brand" href="/">
          <span className="target" aria-hidden /> Unhappy Path
        </Link>
        <nav>
          <a href="#contract">Test your own app</a>
          <a href="https://github.com/" id="gh-link">Source code</a>
        </nav>
      </header>

      <div className="hero">
        <h1>Break your PayPal checkout before your customers do.</h1>
        <p>
          Unhappy Path is an AI agent that runs your sandbox integration through the things that go wrong in real life — declined cards, forged and duplicate
          webhooks, refunds from the PayPal dashboard, tampered prices — then tells you whether it&apos;s safe to go live, and how to fix what isn&apos;t.
        </p>
      </div>

      <section className="step" aria-labelledby="s1">
        <div className="step-head">
          <span className="step-no">1</span>
          <h2 id="s1">Choose what to test</h2>
        </div>
        <div className="targets" role="group" aria-label="Integration to test">
          <button className="choice" aria-pressed={kind === "demo-buggy"} onClick={() => { setKind("demo-buggy"); reset(); }}>
            <b>Kedai Kopi, buggy build</b>
            <span>A demo coffee shop with five classic PayPal mistakes.</span>
          </button>
          <button className="choice" aria-pressed={kind === "demo-fixed"} onClick={() => { setKind("demo-fixed"); reset(); }}>
            <b>Kedai Kopi, fixed build</b>
            <span>The same shop after applying Unhappy Path&apos;s fixes.</span>
          </button>
          <button className="choice" aria-pressed={kind === "custom"} onClick={() => { setKind("custom"); reset(); }}>
            <b>Your sandbox app</b>
            <span>Point it at your own integration and sandbox keys.</span>
          </button>
        </div>

        {kind === "custom" && (
          <div className="form">
            <label>
              Shop name
              <input value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} placeholder="My shop" />
            </label>
            <label>
              GitHub repo (optional, helps the planner)
              <input value={custom.repoUrl} onChange={(e) => setCustom({ ...custom, repoUrl: e.target.value })} placeholder="https://github.com/you/shop" />
            </label>
            <label className="full">
              Test contract base URL
              <input value={custom.contractBase} onChange={(e) => setCustom({ ...custom, contractBase: e.target.value })} placeholder="https://your-shop.example/api/unhappy-path" />
            </label>
            <label className="full">
              Webhook URL registered on your PayPal app
              <input value={custom.webhookUrl} onChange={(e) => setCustom({ ...custom, webhookUrl: e.target.value })} placeholder="https://your-shop.example/api/paypal/webhook" />
            </label>
            <label>
              Sandbox client ID
              <input value={custom.clientId} onChange={(e) => setCustom({ ...custom, clientId: e.target.value })} autoComplete="off" />
            </label>
            <label>
              Sandbox secret
              <input type="password" value={custom.clientSecret} onChange={(e) => setCustom({ ...custom, clientSecret: e.target.value })} autoComplete="off" />
            </label>
            <p className="full small muted" style={{ margin: 0 }}>
              Sandbox keys only. They are used for this run and never stored. Your app needs the three-endpoint <a href="#contract">test contract</a>.
            </p>
          </div>
        )}

        <div className="actions">
          <button className="btn" onClick={doPlan} disabled={phase === "planning" || phase === "running" || (kind === "custom" && !customReady)}>
            {phase === "planning" ? "Planning…" : "Plan the test"}
          </button>
          {kind !== "custom" && (recorded.buggy || recorded.fixed) && (
            <button className="btn ghost" onClick={() => replay(kind === "demo-buggy" ? "buggy" : "fixed")} disabled={phase === "running"}>
              Show a recorded run instead
            </button>
          )}
          {!aiOn && <span className="small muted">AI is off on this deployment; plans and fixes use built-in rules.</span>}
        </div>
        {error && <p className="error" role="alert">{error}</p>}
      </section>

      {plan && (
        <section className="step" aria-labelledby="s2">
          <div className="step-head">
            <span className="step-no">2</span>
            <h2 id="s2">Test plan for {plan.target.name}</h2>
          </div>
          <div className="planline">
            <p style={{ margin: 0 }}>{plan.summary}</p>
            <p className="small muted" style={{ margin: "6px 0 0" }}>
              {plan.source === "ai" ? `Planned by ${plan.model} from your PayPal app's webhook setup and README.` : "Planned with built-in rules."}{" "}
              Webhook subscriptions: {plan.webhookSubscriptions === null ? "none registered for this URL" : plan.webhookSubscriptions.join(", ")}.
            </p>
          </div>
          {replayed && <p className="small muted">Recorded run from {new Date(replayed).toLocaleString()}. Press “Run” to repeat it live.</p>}

          <ol className="scen">
            {plan.steps.map((step, i) => {
              const m = meta[step.id];
              const r = results[step.id];
              const isRunning = running === step.id;
              const cls = r ? r.verdict : isRunning ? "running" : "";
              return (
                <li key={step.id} className={`row ${cls}`}>
                  <div className="row-main">
                    {isRunning ? <span className="target spin" aria-label="running" /> : <span className="dot" aria-hidden style={r ? { borderColor: "transparent", background: `var(--${r.verdict === "pass" ? "pass" : r.verdict === "fail" ? "fail" : "skip"})` } : {}} />}
                    <div>
                      <h3>
                        {i + 1}. {m.title} <span className={`badge sev-${m.severity}`}>{m.severity}</span>
                      </h3>
                      <p>{r ? r.summary : step.reason}</p>
                    </div>
                    {r ? (
                      <span className={`verdict ${r.verdict}`}>{VERDICT_LABEL[r.verdict]}</span>
                    ) : phase === "planned" ? (
                      <label className="toggle">
                        <input type="checkbox" checked={!!include[step.id]} onChange={(e) => setInclude({ ...include, [step.id]: e.target.checked })} /> Run
                      </label>
                    ) : (
                      <span className="small muted">{include[step.id] ? (isRunning ? "Running" : "Queued") : "Off"}</span>
                    )}
                  </div>
                  {r && (
                    <details className="calls">
                      <summary>What the agent did ({r.calls.length} calls, {(r.durationMs / 1000).toFixed(1)} s)</summary>
                      <p className="small muted">{m.what}</p>
                      {r.observations.map((o, k) => (
                        <p className="obs" key={k}>{o}</p>
                      ))}
                      <div className="logwrap">
                        <table className="log">
                          <tbody>
                            {r.calls.map((c, k) => (
                              <tr key={k}>
                                <td className={`who who-${c.actor}`}>{c.actor === "merchant" ? "→ shop" : "→ PayPal"}</td>
                                <td className="mono">{c.method} {c.url}</td>
                                <td className={`mono ${c.status >= 200 && c.status < 300 ? "http-ok" : "http-bad"}`}>{c.status || "—"}{c.issue ? ` ${c.issue}` : ""}</td>
                                <td className="mono">{c.ms} ms</td>
                                <td>{c.note}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  )}
                </li>
              );
            })}
          </ol>
          <div className="actions">
            <button className="btn" onClick={doRun} disabled={phase === "running" || phase === "planning"}>
              {phase === "running" ? "Running…" : phase === "done" ? "Run again" : `Run ${Object.values(include).filter(Boolean).length} scenarios`}
            </button>
            <span className="small muted">Uses real PayPal sandbox calls. A full run takes about 2 minutes because it waits for PayPal&apos;s webhooks.</span>
          </div>
        </section>
      )}

      {phase === "done" && verdict.ran > 0 && (
        <section className="step" aria-labelledby="s3">
          <div className="step-head">
            <span className="step-no">3</span>
            <h2 id="s3">Go-live verdict</h2>
          </div>
          <div className={`stamp ${verdict.ready ? "ok" : "no"}`} role="status">
            <span className="score">{verdict.score}%</span>
            <div>
              <strong>{verdict.ready ? "Ready for go-live" : "Not ready for go-live"}</strong>
              <small>
                {verdict.passed} of {verdict.ran} scenarios passed
                {verdict.blockers.length ? ` · ${verdict.blockers.length} blocking ${verdict.blockers.length === 1 ? "issue" : "issues"}` : ""}
              </small>
            </div>
          </div>
          <p className="small muted" style={{ maxWidth: "70ch" }}>
            The verdict is computed by rules, not by the AI: any failed critical or high-severity scenario blocks go-live, and the AI cannot override it.
          </p>

          {verdict.failed.map((r) => {
            const e = explanations[r.id];
            return (
              <article className="fix" key={r.id}>
                <h3>{e && e !== "loading" ? e.headline : meta[r.id].title}</h3>
                {e === "loading" && (
                  <p className="muted">
                    <span className="target spin" style={{ display: "inline-block", width: 14, height: 14, verticalAlign: -2 }} /> Investigating with the PayPal Agent Toolkit…
                  </p>
                )}
                {e && e !== "loading" && (
                  <>
                    {e.toolCalls.length > 0 && (
                      <div className="chips" aria-label="PayPal Agent Toolkit calls">
                        {e.toolCalls.map((t, k) => (
                          <span className="chip" key={k}>{t}</span>
                        ))}
                      </div>
                    )}
                    <p><b>Root cause.</b> {e.rootCause}</p>
                    <p><b>Impact.</b> {e.impact}</p>
                    {e.fix.code && <pre><code>{e.fix.code}</code></pre>}
                    <ul className="cites">
                      {e.citations.map((c) => (
                        <li key={c.id}><a href={c.url} target="_blank" rel="noreferrer">{c.title}</a></li>
                      ))}
                    </ul>
                    <p className="small muted">{e.source === "ai" ? "Explanation written by Gemini from the run's evidence and PayPal records." : "Explanation from built-in rules."}</p>
                  </>
                )}
                {!e && <p>{r.summary}</p>}
              </article>
            );
          })}
          <div className="actions">
            <button className="btn ghost" onClick={downloadReport}>Download report (Markdown)</button>
          </div>
        </section>
      )}

      <section className="step contract" id="contract" aria-labelledby="s4">
        <div className="step-head">
          <h2 id="s4">Test your own app: the test contract</h2>
        </div>
        <div className="cols">
          <div>
            <p>
              Unhappy Path drives your real checkout code, so your sandbox build exposes three small endpoints. They wrap code you already have; nothing here
              should ship to production.
            </p>
            <ul>
              <li><code>POST /checkout</code> creates a PayPal order the way your shop normally does and returns <code>{`{ order_id }`}</code>.</li>
              <li><code>POST /approve</code> runs your normal &ldquo;buyer came back&rdquo; capture code. Forward the <code>X-Unhappy-Mock</code> header as <code>PayPal-Mock-Response</code> so the agent can make PayPal decline.</li>
              <li><code>GET /probe?order_id=</code> reports what your database believes: <code>status</code> and how many times you <code>fulfilled</code> it.</li>
            </ul>
            <p>Then give the agent your webhook URL and sandbox keys. It pays as a test buyer with a sandbox card, refunds through PayPal, and asks PayPal to resend real signed webhooks.</p>
          </div>
          <pre><code>{`// app/api/unhappy-path/approve/route.ts (Next.js)
export async function POST(req: Request) {
  const { order_id } = await req.json();
  const mock = req.headers.get("x-unhappy-mock");
  // your existing capture code, plus the sandbox hook:
  const r = await captureOrder(order_id, mock
    ? { "PayPal-Mock-Response": mock } : {});
  return Response.json(r);
}

// app/api/unhappy-path/probe/route.ts
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("order_id");
  const o = await db.orders.findByPayPalId(id);
  return Response.json({
    status: o.status,       // pending | paid | refunded | failed
    fulfilled: o.shipments, // how many times you shipped it
  });
}`}</code></pre>
        </div>
      </section>

      <footer>
        Built for the PayPal AI Hackathon 2026. Sandbox only. PayPal APIs: Orders v2, Payments v2, Webhooks (management, events, resend, signature verification),
        Agent Toolkit. AI: Google Gemini.
      </footer>
    </main>
  );
}
