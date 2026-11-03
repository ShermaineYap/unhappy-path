// Curated PayPal documentation the AI explainer may cite. The model chooses
// IDs from this list only; the UI renders the URL, so citations can't be invented.

export type Doc = { id: string; title: string; url: string; gist: string };

export const DOCS: Doc[] = [
  {
    id: "webhook-verify",
    title: "Verify webhook signature",
    url: "https://developer.paypal.com/docs/api/webhooks/v1/#verify-webhook-signature_post",
    gist: "POST /v1/notifications/verify-webhook-signature with the transmission headers, your webhook_id and the raw event; act only when verification_status is SUCCESS.",
  },
  {
    id: "webhook-events",
    title: "Webhooks event names",
    url: "https://developer.paypal.com/api/rest/webhooks/event-names/",
    gist: "Subscribe to PAYMENT.CAPTURE.COMPLETED, PAYMENT.CAPTURE.DENIED, PAYMENT.CAPTURE.REFUNDED and CUSTOMER.DISPUTE.* to keep order state in sync.",
  },
  {
    id: "webhook-integrate",
    title: "Webhooks integration guide",
    url: "https://developer.paypal.com/api/rest/webhooks/rest/",
    gist: "PayPal retries undelivered events up to 25 times over 3 days and events can arrive more than once; respond 2xx quickly and process idempotently using the event id.",
  },
  {
    id: "webhooks-api",
    title: "Webhooks Management API (list, resend events)",
    url: "https://developer.paypal.com/docs/api/webhooks/v1/",
    gist: "GET /v1/notifications/webhooks lists your subscriptions; /webhooks-events/{id}/resend redelivers a real signed event.",
  },
  {
    id: "orders-capture",
    title: "Orders v2: capture payment for order",
    url: "https://developer.paypal.com/docs/api/orders/v2/#orders_capture",
    gist: "Check purchase_units[].payments.captures[].status === COMPLETED before fulfilling; a 422 INSTRUMENT_DECLINED means the buyer must choose another funding source.",
  },
  {
    id: "orders-create",
    title: "Orders v2: create order",
    url: "https://developer.paypal.com/docs/api/orders/v2/#orders_create",
    gist: "Build purchase_units[].amount on the server from your own catalog; never trust a price sent by the browser.",
  },
  {
    id: "decline-handling",
    title: "Handle funding failures (INSTRUMENT_DECLINED)",
    url: "https://developer.paypal.com/docs/checkout/standard/customize/handle-funding-failures/",
    gist: "When capture returns INSTRUMENT_DECLINED, restart the payment flow so the buyer can pick another funding source; do not mark the order paid.",
  },
  {
    id: "idempotency",
    title: "Idempotency (PayPal-Request-Id)",
    url: "https://developer.paypal.com/api/rest/reference/idempotency/",
    gist: "Send PayPal-Request-Id on POST calls so retries do not create duplicate orders or captures.",
  },
  {
    id: "refunds",
    title: "Payments v2: refund captured payment",
    url: "https://developer.paypal.com/docs/api/payments/v2/#captures_refund",
    gist: "Refunds can be issued from the PayPal dashboard as well as your code; listen for PAYMENT.CAPTURE.REFUNDED to keep your records right.",
  },
  {
    id: "negative-testing",
    title: "Sandbox negative testing (PayPal-Mock-Response)",
    url: "https://developer.paypal.com/tools/sandbox/negative-testing/request-headers/",
    gist: "In sandbox, the PayPal-Mock-Response header forces error responses such as INSTRUMENT_DECLINED so you can test unhappy paths.",
  },
];

export const docById = (id: string) => DOCS.find((d) => d.id === id);
