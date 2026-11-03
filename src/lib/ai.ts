// AI layer: (1) the planner chooses and orders scenarios for this integration,
// (2) the investigator uses the PayPal Agent Toolkit to look up the real orders,
// captures and refunds behind each failure, then writes the explanation and fix.
// Verdicts and the go-live decision stay deterministic (see scenarios.ts).

import { generateObject, generateText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
import { z } from "zod";
import { DOCS } from "./knowledge";
import { SCENARIOS, scenarioById, type ScenarioResult } from "./scenarios";
import type { Creds } from "./paypal";

const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
export const aiEnabled = () => Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
const model = () => createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY })(MODEL);

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
    const { object } = await generateObject({
      model: model(),
      schema: z.object({
        summary: z.string().describe("One or two sentences: what you learned about this integration and how you'll test it."),
        steps: z.array(z.object({ id: z.string(), include: z.boolean(), reason: z.string().describe("Why this scenario matters for THIS integration, max 25 words.") })),
      }),
      system:
        "You are Unhappy Path, an agent that crash-tests PayPal sandbox integrations before go-live. Plan which scenarios to run and in what order. " +
        "Order: configuration first, then security (critical) first, then correctness. Exclude a scenario only when it cannot apply (e.g. webhook-replay when no webhook is registered). " +
        "Ground every reason in the evidence given; do not invent facts about the merchant.",
      prompt:
        `Target: ${ctx.targetName}\nTest contract reachable: ${ctx.contractReachable}\n` +
        `Webhook subscriptions on the PayPal app for this URL: ${ctx.webhookSubscriptions === null ? "NONE REGISTERED" : (ctx.webhookSubscriptions ?? []).join(", ") || "unknown"}\n` +
        `README excerpt:\n${(ctx.readme ?? "(none provided)").slice(0, 6000)}\n\nScenario catalogue:\n${catalogue}`,
    });
    const known = new Set(SCENARIOS.map((s) => s.id));
    const steps = object.steps.filter((s) => known.has(s.id));
    for (const s of SCENARIOS) if (!steps.find((x) => x.id === s.id)) steps.push({ id: s.id, include: true, reason: s.risk });
    return { source: "ai", model: MODEL, summary: object.summary, steps };
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
    const facts = await generateText({
      model: model(),
      tools: toolkit.getTools(),
      maxSteps: 4,
      system:
        "You are investigating a failed PayPal integration test. Use the PayPal tools to confirm the facts behind the failure " +
        "(look up the order ids in the evidence). Then state in 3-6 bullet points what PayPal's records show versus what the merchant's system believes.",
      prompt: `Scenario: ${s.title}\nWhat the agent did: ${s.what}\nResult: ${r.summary}\nObservations: ${r.observations.join(" ")}\nEvidence: ${JSON.stringify(r.evidence).slice(0, 3000)}`,
      onStepFinish: (st) => st.toolCalls?.forEach((t: any) => toolCalls.push(`${t.toolName}(${JSON.stringify(t.args).slice(0, 80)})`)),
    });
    // Step 2: structured explanation with citations restricted to the curated docs.
    const { object } = await generateObject({
      model: model(),
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
    });
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
