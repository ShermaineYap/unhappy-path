# Measured study

Date: 3 Nov 2026. Deployment: https://unhappy-path.vercel.app (Vercel Hobby). PayPal sandbox, US business account.
Method: `node scripts/run-suite.mjs https://unhappy-path.vercel.app <demo-buggy|demo-fixed>` five times per shop
(run 1 with AI explanations, runs 2–5 with `--no-explain`), buggy and fixed runs in parallel pairs.
Ground truth: the buggy build contains five planted bugs (price tampering, declined capture marked paid,
forged webhook accepted, duplicate delivery shipped twice, refund ignored); the fixed build contains none.

| Shop | Runs | Scenario runs | Planted bugs caught | Missed | False alarms | Skipped / errors | Median wall time | Max |
|---|---|---|---|---|---|---|---|---|
| Buggy | 5 | 35 | 25 / 25 | 0 | 0 | 0 / 0 | 162 s | 194 s |
| Fixed | 5 | 35 | — | — | 0 | 0 / 0 | 143 s | 146 s |

Per-scenario verdicts were identical across all five runs of each shop. Most of the wall time is waiting for
PayPal's sandbox to emit and deliver webhooks (refund event typically 25 s–2 min; capture event ~1–1.5 min).

Caveats: the ground truth is our own demo shop, so this measures repeatability and the absence of false alarms
on a known-good integration, not coverage of every real-world bug. Raw results: `buggy-*.json`, `fixed-*.json`.
