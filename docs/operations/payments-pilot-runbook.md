# Buraidah pilot — payments, refunds, and reconciliation

## Scope and safety boundary

This runbook applies to the controlled Buraidah pilot only. The active payment policy is **cash at service completion**; it is not an in-app charge, a card capture, or a Paymob transaction.

Moeen must never store card numbers, CVVs, wallet credentials, raw payment-provider secrets, OTPs, or identity documents in the application database, Git, dashboard, order tracker, or this runbook.

The API is the payment system of record. A button in an app or dashboard does not substitute for server-side authorization, workflow validation, or audit evidence.

## Active cash-payment lifecycle

```text
customer approves quote
→ API creates one cash_due payment for the approved amount
→ service request reaches completed
→ dispatcher or admin records cash_collected after physically receiving the full amount
→ admin may record refunded only after physically returning the full amount to the customer
```

### State definitions

| Payment state | Meaning | Who can cause it |
|---|---|---|
| `cash_due` | Full approved amount is due from the customer at completion. | API, when the customer approves the quote |
| `cash_collected` | Full cash amount was physically received and confirmed. | Dispatcher or Admin |
| `refunded` | Full cash amount was physically returned to the customer and confirmed. | Admin only |

Pilot rules:

1. A payment is created only after the customer approves a quote; an approved quote is not itself proof that money was received.
2. The API rejects cash collection unless the service request is `completed`.
3. The collection action records the **full** approved amount only. Do not use the action for deposits, tips, partial collection, or an adjusted price.
4. The refund action records a **full cash refund** only. It must be used only after the cash has been handed back to the customer; it does not send or promise money automatically.
5. A dispatcher may record receipt. Only an Admin may record a refund. The API writes an audit event for each action.
6. Do not retry a collection or refund after an ambiguous response. Refresh the request and reconcile its payment state first; duplicate state changes are rejected by the API.

## Dashboard procedure

### Record cash collection

1. Confirm that the request is `مكتمل` and the customer has paid the exact approved amount in cash.
2. Open the request in the operations dashboard and verify that its payment card says `مبلغ نقدي مستحق عند إتمام الخدمة`.
3. A Dispatcher or Admin selects **تأكيد استلام النقد** once.
4. Refresh the request. The payment card must say `تم استلام المبلغ`.
5. If cash is short, disputed, unknown, or was not physically handed over, do **not** press the button. Open or update a support ticket and escalate to the operations owner.

### Record a full cash refund

1. Resolve the customer complaint/rework decision in the support process first.
2. An Admin confirms that the full collected amount has actually been returned to the customer in cash.
3. The Admin opens the completed request and selects **تأكيد إعادة النقد** once.
4. Refresh the request. The payment card must say `تمت إعادة كامل المبلغ نقدًا`.
5. If a partial refund, credit, or future-discount agreement is needed, do not use this action. Keep the payment as collected, document the resolution in the support ticket and private operations tracker, and obtain an Admin decision before a later system enhancement supports that case.

## Daily reconciliation

At the end of every pilot shift, the Admin or delegated finance owner must reconcile every request that has an approved quote.

1. Export or review the dashboard list alongside `templates/pilot-orders.csv`; use the request ID as the join key.
2. For each payment, compare the approved amount, request status, dashboard payment state, physical cash record, and support-ticket outcome.
3. Treat every mismatch as an open discrepancy. Do not edit history, overwrite the quote, or silently mark the order resolved.
4. Record the discrepancy owner and next action in the private operations tracker. Do not add customer phone numbers, card data, OTPs, or identity data to the repository template.
5. The shift cannot close with an unexplained `cash_due` payment on a completed request, a cash amount mismatch, or a refund with no corresponding customer-support resolution.
6. Review audit events `payment.cash_collected` and `payment.cash_refunded` as evidence of who recorded each state change.

Suggested private tracker fields:

```text
request_id, quote_amount_halalas, payment_state, physical_cash_status,
support_ticket_id, discrepancy_owner, next_action, reconciled_at
```

## Disputes, rework, cancellation, and refund policy

- **Before service completion:** do not collect cash. If the job is cancelled, leave no fictitious collection record.
- **Quality or scope dispute:** open a support ticket, pause the operational decision when safe, and retain the approved quote/history. A quote must not be overwritten to simulate a refund.
- **Rework accepted:** document the rework plan and owner in support; do not mark a cash refund unless cash was actually returned.
- **Full refund approved:** return the full cash amount first, then have an Admin record `refunded`.
- **Partial refund, credit, or goodwill discount:** manual, Admin-approved exception during this pilot. It is out of scope for the current payment state machine and must be tracked privately until a safe partial-refund ledger is implemented.

## Paymob preparation — not enabled in this pilot

Paymob documentation provides Intention APIs, hosted checkout experiences, webhook/HMAC material, and a refund capability.[1][2][3] Those features are **not configured or called** by Moeen during the cash pilot.

Do not add real values to Git. Once a Paymob sandbox account, correct KSA configuration, and a public HTTPS callback origin are available, keep these values only in local secret storage:

```dotenv
# Placeholders only — no values in Git
PAYMOB_API_KEY=[REDACTED]
PAYMOB_PUBLIC_KEY=[REDACTED]
PAYMOB_HMAC_SECRET=[REDACTED]
PAYMOB_INTEGRATION_ID=[REDACTED]
PAYMOB_CALLBACK_URL=https://payments.example.com/paymob/webhook
```

Before enabling any electronic method, all of the following are mandatory:

1. The backend creates the provider payment intention server-side and stores only Moeen/payment-provider references permitted for reconciliation.
2. The customer uses a provider-hosted checkout or approved SDK path; Moeen does not collect card data itself.[1]
3. The callback endpoint is public HTTPS, validates the provider HMAC/signature before trusting any state, and rejects malformed or unauthenticated payloads.[2]
4. Every provider callback is stored with an idempotency key/event ledger inside a transaction before changing payment state.
5. Electronic refunds are Admin-controlled, auditable, idempotent, and only attempted after the internal ledger identifies a settled eligible transaction.[3]
6. Sandbox tests cover payment success, payment failure, duplicate callback delivery, invalid HMAC, delayed callback, and refund failure before a live method can be shown to customers.
7. A daily settlement reconciliation compares internal paid/refunded states against the provider settlement/export; unknown or unmatched transactions block launch review.

## Payment launch gate

Do not activate a Paymob button, hosted checkout, card method, or provider webhook until the following are all evidenced:

- Cash pilot reconciliation has been performed across real completed jobs with no unresolved discrepancy.
- A named Admin owns disputes, cash custody, refunds, and daily close-out.
- The sandbox credentials and integration method are confirmed locally without being committed.
- A public HTTPS origin and callback monitoring are deployed.
- HMAC verification, webhook idempotency, payment ledger, and reconciliation report have passed automated and sandbox tests.
- The customer-facing policy explains the payment timing, cancellation, refund path, and support route in Arabic.
- An explicit go/no-go decision is recorded by the operations owner.

## Sources

[1] https://developers.paymob.com/paymob-docs/developers/checkout-experiences/overview — Paymob Checkout Experiences
[2] https://developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac/hmac — Paymob HMAC
[3] https://developers.paymob.com/paymob-docs/payments-and-features/managing-payments/refund — Paymob Refund
