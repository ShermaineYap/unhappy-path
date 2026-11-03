## Inspiration

Every PayPal integration I have seen, including my own first ones, is tested on the happy path: create an order, approve it, capture it, done. The failures that actually cost a shop money live elsewhere — a card that is declined at capture but the order still ships, a webhook endpoint that accepts any POST, PayPal retrying a delivery and the order shipping twice, a refund issued from the PayPal dashboard that the shop's books never hear about. PayPal's sandbox already has the tools to reproduce every one of these (`PayPal-Mock-Response`, webhook event resend, test cards, refunds), but wiring them into a repeatable test takes a day most teams never spend. I wanted an agent that spends that day for you in three minutes.

## What it does

**Unhappy Path is an AI agent that crash-tests a PayPal sandbox integration before go-live.** You point it at your sandbox build and it:

1. **Plans** the test: Gemini reads your PayPal app's webhook subscriptions (fetched from PayPal), checks your test endpoints respond, reads your README, and chooses and orders seven scenarios with a reason for each.
2. **Runs** the scenarios against your real checkout code, as real PayPal sandbox calls:
   - **Webhook subscriptions** cover captures, denials, refunds and disputes
   - **Happy path**: pays as a sandbox buyer with a test card; PayPal and your database must agree
   - **Price tampering** (critical): injects `price: "0.01"` into your checkout call
   - **Declined capture** (high): makes PayPal decline your capture with `PayPal-Mock-Response: INSTRUMENT_DECLINED`
   - **Forged webhook** (critical): posts a fake `PAYMENT.CAPTURE.COMPLETED` with an invalid signature
   - **Duplicate delivery** (high): waits for PayPal's *real signed* capture webhook, then asks PayPal to **resend** it
   - **Refund sync**: refunds through PayPal as if from the dashboard and waits for PayPal's refund webhook
3. **Decides** go-live with rules, not vibes: any failed critical or high scenario blocks go-live, and the AI cannot override it.
4. **Investigates and explains** each failure: the model chooses **PayPal Agent Toolkit** calls (`get_order`, `get_refund`, `list_transactions`) to see what PayPal's records show, then writes the likely root cause, the impact, and a minimal fix — citing only from a curated list of PayPal docs, so links can't be invented.

Every PayPal call the agent makes is shown in a timeline with status and timing, and the report downloads as Markdown.

To try it without your own app, the live demo includes **Kedai Kopi**, a small Malaysian coffee shop in two builds: one with five classic PayPal mistakes, one with them fixed.

## How we built it

- **Next.js 15 / TypeScript on Vercel** (free Hobby plan). Each scenario runs in its own serverless request; the two webhook scenarios are **resumable state machines** that follow PayPal's real (slow) sandbox deliveries across requests for up to 7 minutes.
- **PayPal APIs:** Orders v2 (create, PATCH, confirm-payment-source, capture, get, **add tracking**, update tracker), Payments v2 (get capture, refund), Webhooks management (list), **Webhook events (list, resend)**, **webhook signature verification**, sandbox negative testing (`PayPal-Mock-Response`), and the **PayPal Agent Toolkit** (`@paypal/agent-toolkit`).
- **AI:** Google Gemini via the Vercel AI SDK, with a fallback chain across free-tier models. The planner and fix-writer use structured output (zod schemas); citations are an enum of curated doc IDs.
- **A test contract** of three tiny sandbox-only endpoints (`/checkout`, `/approve`, `/probe`) lets the agent drive *your* code and read back what *your* database believes.
- **The demo shop has no database — it keeps its books in PayPal.** Each shipment is a PayPal shipment tracker on the order, a refund cancels the tracker, and pre-capture notes live in the order's `custom_id`. The probe reads only these merchant-written records, never PayPal's own payment status, so the buggy build genuinely believes the wrong things. The fixed build makes fulfilment idempotent with a per-order `PayPal-Request-Id`.

## Measured results

Five full runs against each demo shop on the live deployment (70 scenario runs):

| Shop | Runs | Planted failures caught | Missed | False alarms | Median run time |
|---|---|---|---|---|---|
| Buggy (5 planted bugs) | 5 | **25 / 25** | 0 | 0 | 162 s |
| Fixed | 5 | — | — | **0** | 143 s |

Verdicts were identical across all runs. Most of the run time is waiting for PayPal's sandbox webhooks.

## Challenges we ran into

- **PayPal's sandbox delivers webhooks in 1–2 minutes**, longer than a serverless request. I rebuilt the two webhook scenarios as resumable state machines, and they only fail once PayPal has *actually emitted* the event and the merchant had time to process it — otherwise they report "skipped" instead of guessing.
- **No free database.** Instead of paying for Redis I moved the demo shop's records into PayPal itself (shipment trackers + order notes), which turned out to be a better demo of the platform.
- **Free-tier Gemini quotas and multi-turn tool calling.** Gemini 3 rejects multi-turn function calls without thought signatures in the SDK version the Agent Toolkit supports, so the model now selects Toolkit calls as structured output and our code executes them.
- **A documented decline trigger that didn't fire:** putting `CCREJECT-REFUSED` in the cardholder name did not decline Orders v2 card payments in my tests, so Unhappy Path uses `PayPal-Mock-Response` instead.

## Accomplishments that we're proud of

- It finds real bugs using real PayPal behaviour — including PayPal's own signed webhook redeliveries — not simulations.
- 25/25 planted failures, 0 false alarms, repeatable.
- The go-live verdict can't be talked into "ready" by the model.

## What we learned

The unhappy paths are where a payment integration's correctness actually lives, and PayPal's sandbox is far more capable of reproducing them than most developers realise — webhook resend and `PayPal-Mock-Response` in particular.

## What's next

- Disputes: open a sandbox dispute and check the merchant provides tracking evidence (sandbox `require-evidence` / `adjudicate`)
- Subscriptions: failed-renewal and suspension handling
- A GitHub Action that runs the suite on every pull request against a preview deployment

## Honest limitations

- Sandbox only, by design; production keys are rejected.
- Your app needs the three-endpoint test contract; without it only the webhook-configuration check runs.
- On free-tier Gemini quotas, the demo may show an explanation Gemini wrote for the same failure on an earlier run (clearly labelled); your own app falls back to built-in rules.
- The measured study uses our own demo shop as ground truth, so it measures repeatability and false alarms, not coverage of every real-world bug.

## Testing instructions

Open https://unhappy-path.vercel.app → **Kedai Kopi, buggy build** → **Plan the test** → **Run 7 scenarios** (about 3 minutes). Or click **Show a recorded run instead** to see a complete run instantly. No login or keys needed. To test your own sandbox app, see the README's "Test contract" section.
