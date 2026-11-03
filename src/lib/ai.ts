// AI layer: (1) the planner chooses and orders scenarios for this integration,
// (2) the investigator uses the PayPal Agent Toolkit to look up the real orders,
// captures and refunds behind each failure, then writes the explanation and fix.
// Verdicts and the go-live decision stay deterministic (see scenarios.ts).

import { generateObject } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
import { z } from "zod";
import { DOCS } from "./knowledge";
import { SCENARIOS, scenarioById, type ScenarioResult } from "./scenarios";
import type { Creds } from "./paypal";

const MODELS = [process.env.GEMINI_MODEL ?? "gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.5-flash-lite"].filter(
  (m, i, a) => a.indexOf(m) === i,
);
export const aiEnabled = () => Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
const google = () => createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY });

/** Free-tier Gemini models are often busy; fall through to the next model instead of failing. */
async function withModels<T>(fn: (m: ReturnType<ReturnType<typeof google>>, name: string) => Promise<T>): Promise<{ value: T; model: string }> {
  let last: unknown;
  for (const name of MODELS) {
    try {
      const value = await Promise.race([
        fn(google()(name), name),
        new Promise<never>((_, no) => setTimeout(() => no(new Error("timed out after 20 s")), 20000)),
      ]);
      return { value, model: name };
    } catch (e) {
      last = e;
      console.warn(`gemini ${name} failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
  }
  throw last;
}

export type PlanStep = { id: string; include: boolean; reason: string };
export type Plan = { steps: PlanStep[]; summary: string; source: "ai" | "rules"; model?: string };

export type PlanContext = {
  targetName: string;
  readme?: string;
  webhookSubscriptions?: string[] | null; // null = webhook not registered
  contractReachable: boolean;
  demo: boolean;
};

export function rulesPlan(ctx: PlanContext): Plan {
  return {
    source: "rules",
    summary: `Running all ${SCENARIOS.length} scenarios against ${ctx.targetName}.`,
    steps: SCENARIOS.map((s) => ({ id: s.id, include: true, reason: s.risk })),
  };
}

export async function plan(ctx: PlanContext): Promise<Plan> {
  if (!aiEnabled()) return rulesPlan(ctx);
  try {
    const catalogue = SCENARIOS.map((s) => `- ${s.id} [${s.category}/${s.severity}]: ${s.what} Risk: ${s.risk}`).join("\n");
    const { value: { object }, model: used } = await withModels((m) => generateObject({
      model: m,
      maxRetries: 0,
      schema: z.object({
        summary: z.string().describe("One or two sentences: what you learned about this integration and how you'll test it."),
        steps: z.array(z.object({ id: z.string(), include: z.boolean(), reason: z.string().describe("Why this scenario matters for THIS integration, max 25 words.") })),
      }),
      system:
        "You are Unhappy Path, an agent that crash-tests PayPal sandbox integrations before go-live. Plan which scenarios to run and in what order. " +
        "Order: configuration first, then security (critical) first, then correctness. Always include webhook-config. Exclude a scenario only when it cannot apply (e.g. webhook-replay when no webhook is registered). " +
        "Ground every reason in the evidence given; do not invent facts about the merchant.",
      prompt:
        `Target: ${ctx.targetName}\nTest contract reachable: ${ctx.contractReachable}\n` +
        `Webhook subscriptions on the PayPal app for this URL: ${ctx.webhookSubscriptions === null ? "NONE REGISTERED" : (ctx.webhookSubscriptions ?? []).join(", ") || "unknown"}\n` +
        `README excerpt:\n${(ctx.readme ?? "(none provided)").slice(0, 6000)}\n\nScenario catalogue:\n${catalogue}`,
    }));
    const known = new Set(SCENARIOS.map((s) => s.id));
    const steps = object.steps.filter((s) => known.has(s.id));
    for (const s of SCENARIOS) if (!steps.find((x) => x.id === s.id)) steps.push({ id: s.id, include: true, reason: s.risk });
    // The configuration check is always useful: a missing webhook is itself the finding.
    const cfg = steps.find((x) => x.id === "webhook-config");
    if (cfg && !cfg.include) Object.assign(cfg, { include: true, reason: "No webhook is registered for this URL, which is itself a finding worth recording." });
    return { source: "ai", model: used, summary: object.summary, steps };
  } catch (e) {
    console.error("planner failed, using rules", e);
    return rulesPlan(ctx);
  }
}

export type Explanation = {
  id: string;
  headline: string;
  rootCause: string;
  impact: string;
  fix: { language: string; code: string };
  citations: { id: string; title: string; url: string }[];
  toolCalls: string[];
  source: "ai" | "rules";
};

const FIX_TEMPLATES: Record<string, { language: string; code: string }> = {
  "price-tampering": {
    language: "ts",
    code: `// Server: price comes from YOUR catalog, never from the request body\nconst item = CATALOG[body.sku];\nconst value = (Number(item.price) * qty).toFixed(2);\nawait paypal.orders.create({ intent: "CAPTURE",\n  purchase_units: [{ amount: { currency_code: "USD", value } }] });`,
  },
  "declined-capture": {
    language: "ts",
    code: `const r = await capture(orderId);\nconst cap = r.purchase_units?.[0]?.payments?.captures?.[0];\nif (!r.ok || cap?.status !== "COMPLETED") {\n  await db.orders.update(orderId, { status: "failed" });\n  return res.status(402).json({ retry: true }); // let buyer pick another funding source\n}\nawait fulfilOnce(orderId);`,
  },
  "forged-webhook": {
    language: "ts",
    code: `const v = await paypal.post("/v1/notifications/verify-webhook-signature", {\n  auth_algo: h["paypal-auth-algo"], cert_url: h["paypal-cert-url"],\n  transmission_id: h["paypal-transmission-id"], transmission_sig: h["paypal-transmission-sig"],\n  transmission_time: h["paypal-transmission-time"], webhook_id: process.env.PAYPAL_WEBHOOK_ID,\n  webhook_event: event });\nif (v.verification_status !== "SUCCESS") return res.status(400).end();`,
  },
  "webhook-replay": {
    language: "ts",
    code: `// Process each PayPal event once\nconst first = await redis.set(\`evt:\${event.id}\`, 1, { nx: true, ex: 60*60*24*7 });\nif (!first) return res.status(200).end(); // duplicate delivery\n// ...and make fulfilment itself idempotent per order\nawait fulfilOnce(orderId);`,
  },
  "refund-sync": {
    language: "ts",
    code: `case "PAYMENT.CAPTURE.REFUNDED": {\n  const capId = event.resource.links.find(l => l.rel === "up").href.split("/captures/")[1];\n  await db.orders.updateByCapture(capId, { status: "refunded" });\n  break;\n}`,
  },
  "webhook-config": {
    language: "bash",
    code: `curl -X POST https://api-m.sandbox.paypal.com/v1/notifications/webhooks \\\n  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\\n  -d '{"url":"https://your-shop/api/paypal/webhook","event_types":[\n    {"name":"PAYMENT.CAPTURE.COMPLETED"},{"name":"PAYMENT.CAPTURE.DENIED"},\n    {"name":"PAYMENT.CAPTURE.REFUNDED"},{"name":"CUSTOMER.DISPUTE.CREATED"}]}'`,
  },
  "happy-path": {
    language: "ts",
    code: `// After the buyer approves: capture on the server, then record the result\nconst r = await capture(orderId);\nif (r.purchase_units[0].payments.captures[0].status === "COMPLETED") await fulfilOnce(orderId);`,
  },
};

export function rulesExplain(r: ScenarioResult): Explanation {
  const s = scenarioById(r.id)!;
  return {
    id: r.id,
    headline: r.summary,
    rootCause: r.observations.join(" "),
    impact: s.risk,
    fix: FIX_TEMPLATES[r.id] ?? { language: "txt", code: "" },
    citations: s.kb.map((k) => DOCS.find((d) => d.id === k)!).filter(Boolean).map(({ id, title, url }) => ({ id, title, url })),
    toolCalls: [],
    source: "rules",
  };
}

export async function explain(r: ScenarioResult, creds: Creds, stack = "Next.js / TypeScript"): Promise<Explanation> {
  if (!aiEnabled()) return rulesExplain(r);
  const s = scenarioById(r.id)!;
  const toolCalls: string[] = [];
  try {
    // Step 1: investigate with the PayPal Agent Toolkit (read-only tools).
    const toolkit = new PayPalAgentToolkit({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      configuration: {
        actions: { orders: { get: true }, transactions: { list: true }, payments: { getRefunds: true }, disputes: { list: true, get: true } },
        context: { sandbox: true },
      },
    });
    // The model chooses which Agent Toolkit tools to call and with what arguments;
    // our code executes them. (Doing the selection as structured output avoids
    // multi-turn function-calling, which free-tier Gemini 3 models reject without
    // thought signatures.)
    const tools = toolkit.getTools() as Record<string, any>;
    const toolNames = Object.keys(tools) as [string, ...string[]];
    const { value: { object: pick } } = await withModels((m) => generateObject({
      model: m,
      maxRetries: 0,
      schema: z.object({
        calls: z.array(z.object({ tool: z.enum(toolNames), argsJson: z.string().describe("Arguments as a JSON object string, e.g. {\"id\":\"ORDER_ID\"}") })).min(1).max(3),
      }),
      system:
        "You are investigating a failed PayPal integration test. Choose 1-3 PayPal Agent Toolkit calls that confirm what PayPal's records show " +
        "for the orders in the evidence (e.g. get_order with the order id). Use only ids present in the evidence.\n\nTools:\n" +
        toolNames.map((n) => `- ${n}: ${String(tools[n].description ?? "").slice(0, 160)}`).join("\n"),
      prompt: `Scenario: ${s.title}\nWhat the agent did: ${s.what}\nResult: ${r.summary}\nObservations: ${r.observations.join(" ")}\nEvidence: ${JSON.stringify(r.evidence).slice(0, 3000)}`,
    }));
    const findings: string[] = [];
    for (const call of pick.calls) {
      let args: any = {};
      try {
        args = JSON.parse(call.argsJson);
      } catch {
        continue;
      }
      toolCalls.push(`${call.tool}(${JSON.stringify(args).slice(0, 80)})`);
      try {
        const out = await tools[call.tool].execute(args, { toolCallId: crypto.randomUUID(), messages: [] });
        findings.push(`${call.tool} → ${(typeof out === "string" ? out : JSON.stringify(out)).slice(0, 2500)}`);
      } catch (e: any) {
        findings.push(`${call.tool} → error: ${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
    const facts = { text: findings.join("\n\n") || "(no tool results)" };
    // Step 2: structured explanation with citations restricted to the curated docs.
    const { value: { object } } = await withModels((m) => generateObject({
      model: m,
      maxRetries: 0,
      schema: z.object({
        headline: z.string().describe("Max 14 words, plain English."),
        rootCause: z.string().describe("2-3 sentences: the specific mistake in the merchant's code, grounded in the facts."),
        impact: z.string().describe("1-2 sentences: what this costs a real shop."),
        fixLanguage: z.string(),
        fixCode: z.string().describe(`A minimal, correct fix for a ${stack} server. Max 18 lines. No placeholders like '...'.`),
        citations: z.array(z.enum(DOCS.map((d) => d.id) as [string, ...string[]])).min(1).max(3),
      }),
      system: "You write precise, honest fix notes for developers integrating PayPal. Never claim facts not present in the input. Cite only from the provided doc ids.",
      prompt:
        `Scenario: ${s.title} (${s.severity})\nRisk: ${s.risk}\nResult: ${r.summary}\nObservations: ${r.observations.join(" ")}\n` +
        `Investigation notes (from PayPal Agent Toolkit):\n${facts.text}\n\nDocs you may cite:\n${DOCS.map((d) => `- ${d.id}: ${d.title} — ${d.gist}`).join("\n")}`,
    }));
    return {
      id: r.id,
      headline: object.headline,
      rootCause: object.rootCause,
      impact: object.impact,
      fix: { language: object.fixLanguage, code: object.fixCode },
      citations: object.citations.map((id) => DOCS.find((d) => d.id === id)!).map(({ id, title, url }) => ({ id, title, url })),
      toolCalls,
      source: "ai",
    };
  } catch (e) {
    console.error("explainer failed, using rules", e);
    return { ...rulesExplain(r), toolCalls };
  }
}
