import type { Target } from "./contract";
import type { Creds } from "./paypal";
import { demoCreds } from "./demostore";

export type TargetInput =
  | { kind: "demo-buggy" | "demo-fixed" }
  | { kind: "custom"; name?: string; contractBase: string; webhookUrl: string; clientId: string; clientSecret: string; sku?: string };

function publicHttps(u: string) {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    throw new Error(`Not a valid URL: ${u}`);
  }
  if (url.protocol !== "https:") throw new Error("URLs must be https (PayPal only delivers webhooks to https).");
  const h = url.hostname;
  if (h === "localhost" || h.endsWith(".local") || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/.test(h) || h === "[::1]")
    throw new Error("Private or local addresses can't be tested from the hosted app; use a public tunnel URL.");
  return url.toString().replace(/\/$/, "");
}

export function resolveTarget(input: TargetInput, origin: string): { target: Target; creds: Creds; demo: boolean } {
  if (input.kind === "demo-buggy" || input.kind === "demo-fixed") {
    const mode = input.kind === "demo-buggy" ? "buggy" : "fixed";
    return {
      demo: true,
      creds: demoCreds(),
      target: {
        name: mode === "buggy" ? "Kedai Kopi (buggy build)" : "Kedai Kopi (fixed build)",
        contractBase: `${origin}/api/demo/${mode}`,
        webhookUrl: `${origin}/api/demo/${mode}/webhook`,
      },
    };
  }
  if (input.kind !== "custom") throw new Error("Unknown target kind.");
  if (!input.clientId || !input.clientSecret) throw new Error("Sandbox client ID and secret are required.");
  if (/live|production/i.test(input.clientId)) throw new Error("Use sandbox credentials only.");
  return {
    demo: false,
    creds: { clientId: input.clientId.trim(), clientSecret: input.clientSecret.trim() },
    target: {
      name: input.name?.trim() || new URL(input.contractBase).hostname,
      contractBase: publicHttps(input.contractBase),
      webhookUrl: publicHttps(input.webhookUrl),
      sku: input.sku,
    },
  };
}

export function originOf(req: Request) {
  const env = process.env.PUBLIC_BASE_URL;
  if (env) return env.replace(/\/$/, "");
  const h = req.headers;
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}
