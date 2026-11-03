# Unhappy Path

**Break your PayPal checkout before your customers do.**

Unhappy Path is an AI agent that crash-tests a PayPal **sandbox** integration. It drives your real checkout code, makes PayPal do the things that go wrong in production — declined captures, forged webhooks, duplicate webhook deliveries, refunds issued from the PayPal dashboard, tampered prices — and checks what your system believes afterwards. It then issues a go-live verdict and, for every failure, investigates with the **PayPal Agent Toolkit** and writes a fix with citations to PayPal's docs.

Built solo for the [PayPal AI Hackathon 2026](https://paypalaihackathon.devpost.com/).

- **Live demo:** https://unhappy-path.vercel.app
- **Video:** _added at submission_

## Why

Most PayPal integrations are only ever tested on the happy path. The failures that cost money — shipping a declined order, accepting an unsigned webhook, fulfilling the same order twice when PayPal retries, missing a refund — only show up in production. PayPal's sandbox already has the tools to reproduce all of them (`PayPal-Mock-Response`, webhook event resend, test cards, refunds), but wiring them into a repeatable test takes a day most teams never spend. Unhappy Path does it in about two minutes.

## What it tests

| # | Scenario | Severity | What the agent does |
|---|---|---|---|
| 1 | Webhook subscriptions | medium | Reads your app's webhook subscriptions from PayPal; checks captures, denials, refunds and disputes are covered. |
| 2 | Happy path | high | Your shop creates an order, the agent pays as a sandbox buyer with a test card, your shop captures; PayPal and your DB must agree. |
| 3 | Price tampering | critical | Calls your checkout normally and with `price: "0.01"` injected; compares what PayPal was asked to charge. |
| 4 | Declined capture | high | Makes PayPal decline your capture (`INSTRUMENT_DECLINED` via `PayPal-Mock-Response`); your shop must not mark it paid. |
| 5 | Forged webhook | critical | Posts a fake `PAYMENT.CAPTURE.COMPLETED` with an invalid signature for an unpaid order. |
| 6 | Duplicate delivery | high | Waits for PayPal's real signed capture event, then asks PayPal to **resend** it (`/v1/notifications/webhooks-events/{id}/resend`); your shop must fulfil once. |
| 7 | Refund sync | medium | Refunds through PayPal (as if from the dashboard); your records must change to refunded. |

The **go-live verdict is computed by rules**: any failed critical or high scenario blocks go-live, and the AI cannot override it.

## Measured results

Five full runs against each demo shop on the live deployment (70 scenario runs): **all 25 planted failures caught, 0 missed, 0 false alarms, 0 skips**, verdicts identical across runs. Median run time 162 s (buggy) / 143 s (fixed), mostly waiting for PayPal's sandbox webhooks. Details: [`study/RESULTS.md`](study/RESULTS.md).

## How the AI is used

1. **Planner** (Gemini via Vercel AI SDK): reads your PayPal app's webhook configuration, whether your test contract responds, and your repo's README, then chooses and orders the scenarios with a reason for each.
2. **Investigator** (Gemini + **PayPal Agent Toolkit** `@paypal/agent-toolkit`): for each failure the model chooses Toolkit calls such as `get_order`, `list_transactions` and `get_refund` (as structured output), our code executes them, and the results ground the explanation in what PayPal's records show versus what your shop believes.
3. **Fix writer**: turns the evidence into a root cause, impact and a minimal code fix. Citations are restricted to a curated list of PayPal docs (`src/lib/knowledge.ts`), so links can't be invented.

Without a Gemini key the app still works: plans and fixes fall back to built-in rules.

## PayPal APIs used

Orders v2 (create, PATCH, confirm-payment-source, capture, get, **add tracking**, update tracker), Payments v2 (get capture, refund), Webhooks management (list webhooks), Webhook events (list, **resend**), Webhook signature verification (demo store), sandbox negative testing (`PayPal-Mock-Response`), Agent Toolkit (`get_order`, `list_transactions`, `get_refund`, `list_disputes`, `get_dispute`).

## The demo shop keeps its books in PayPal

Kedai Kopi has no database. Every shipment is a PayPal shipment tracker on the order (`POST /v2/checkout/orders/{id}/track`), a refund cancels the tracker, and notes made before capture live in the order's `custom_id`. The probe reads only these merchant-written records, never PayPal's own payment status, so the buggy build really does believe the wrong things. The fixed build makes fulfilment idempotent with a per-order `PayPal-Request-Id`.

## Try it

Open the live demo and choose **Kedai Kopi, buggy build** → **Plan the test** → **Run**. The buggy build is a small coffee shop with five classic mistakes; the fixed build is the same shop done right. Use **Show a recorded run** if you don't want to wait for PayPal's webhooks.

## Test your own integration

Your sandbox build exposes three endpoints (wrapping code you already have):

| Endpoint | Purpose |
|---|---|
| `POST {base}/checkout` `{sku, quantity, price?}` → `{order_id}` | Create a PayPal order the way your shop normally does. |
| `POST {base}/approve` `{order_id}` | Run your normal capture code. Forward header `X-Unhappy-Mock` as `PayPal-Mock-Response` (sandbox only). |
| `GET {base}/probe?order_id=` → `{status, fulfilled}` | Report what your database believes: `pending | paid | refunded | failed`, and how many times you shipped it. |

Then enter the contract base URL, your registered webhook URL and your sandbox client ID and secret in **Your sandbox app**. Keys are used for that run only and never stored. See `src/lib/demostore.ts` for a complete reference implementation (buggy and fixed).

## Run it locally

Requirements: Node 20+, a free PayPal developer account, optionally a free Gemini API key.

```bash
git clone <this repo> && cd unhappy-path
npm install
cp .env.example .env.local   # fill in sandbox client ID/secret (+ Gemini key)
npm run dev                  # http://localhost:3000
npm test                     # unit tests
```

Locally, scenarios 2–5 run fully. Scenarios 1, 6 and 7 need PayPal to reach your webhook, so they need a public https URL (deploy to Vercel or use a tunnel), then:

```bash
PUBLIC_BASE_URL=https://your-app.vercel.app node scripts/register-webhooks.mjs
```

and set the printed fixed-mode webhook ID as `PAYPAL_WEBHOOK_ID_FIXED`.

### Environment variables

| Name | Required | Notes |
|---|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | yes | Sandbox app (US business account recommended) for the demo store |
| `PAYPAL_WEBHOOK_ID_FIXED` | for the fixed demo | From `register-webhooks.mjs` |
| `GOOGLE_GENERATIVE_AI_API_KEY` | no | Enables the AI planner and investigator (free tier works) |
| `PUBLIC_BASE_URL` | no | Override the detected origin |

## Honest limitations

- Sandbox only, by design. Production keys are rejected.
- Your app must implement the three-endpoint test contract; without it, only the webhook-configuration check runs.
- PayPal's sandbox delivers webhooks slowly (often 1–2 minutes). The two webhook scenarios resume across requests and wait up to 7 minutes for PayPal's real event; if it never arrives they report **Skipped** rather than guessing.
- Free-tier Gemini quotas run out quickly. The app falls back across several Gemini models; for the demo shop it then shows the explanation Gemini wrote for the same failure on an earlier run (labelled), and for your own app it uses built-in rules.
- Disputes are not yet covered: creating a sandbox dispute requires the buyer UI, so it isn't automated.
- The `CCREJECT-*` cardholder-name decline trigger from PayPal's card-testing docs did not decline Orders v2 card payments in our tests; Unhappy Path uses `PayPal-Mock-Response` instead.

## Licence

MIT — see [LICENSE](LICENSE).
