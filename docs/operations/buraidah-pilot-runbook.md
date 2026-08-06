# Buraidah controlled operations pilot

## Purpose and scope

This is a **concierge pilot**, not a public Saudi launch. Moeen staff manually dispatch every request, remain reachable during stated operating hours, and use the existing customer app, API, and staff dashboard as the system of record for request status.

Launch area, operating hours, and active categories must be written in the private pilot tracker before accepting a customer request. Do not expand to another Buraidah zone or activate a category until its provider coverage passes the gate below.

## Non-negotiable pilot rules

- The API blocks assignment to every unverified provider, including legacy development records. Register and vet real providers through the admin workflow before assigning customer work.
- Never store provider/customer identity documents, national IDs, bank details, OTPs, or card data in this repository or the pilot CSV templates.
- Do not promise fixed prices for diagnostic or repair work. Confirm inspection/quote approval with the customer before work starts.
- Do not offer an electronic app payment method until the Paymob launch gate in `payments-pilot-runbook.md` is complete. The controlled pilot cash-at-completion flow is permitted only under that runbook’s collection, refund, and reconciliation rules.
- Keep a human operations owner available for customer support and safety escalation during every pilot shift.
- Pause a provider immediately after a safety concern, no-show, serious quality complaint, or identity/eligibility doubt; investigate before returning them to service.

## Provider readiness gate

A category is eligible for the pilot only after there are at least two independently vetted providers able to cover the selected launch zone, except that a controlled one-provider test may be run only with the operations owner’s explicit approval and no paid acquisition.

For every provider, complete the private vetting record and confirm:

1. Legal/identity and business eligibility have been checked outside the repository according to the applicable local requirements.
2. The provider has confirmed their services, Buraidah coverage zone, operating hours, and a reliable contact channel.
3. The provider has supplied work references or samples appropriate for the category.
4. The provider understands the dispatch flow, arrival communication, quote approval, cancellation, complaint handling, and suspension rules.
5. The provider has completed one supervised or test job before broad customer exposure.
6. A named operations owner has approved activation for that category and zone.

### Dashboard activation workflow

1. An **Admin** adds only the operating name, service zone, and supported categories in the Buraidah provider section of the dashboard.
2. The API creates the provider as `pending` and unavailable; dispatchers cannot assign it.
3. The Admin completes the private vetting checklist outside the application and retains any sensitive evidence outside Git and the dashboard.
4. The Admin selects **اعتماد مقدم الخدمة** only after the checks are complete. The API changes the provider to `verified` and available, and writes an immutable audit event.
5. A dispatcher may then select that verified provider for a compatible pilot request. Provider contact details remain in the approved private operations channel, not the app database.
6. For a safety concern, no-show, or serious quality issue, an **Admin** selects **إيقاف التعيين مؤقتًا**. The provider becomes `suspended`, is unavailable for dispatch, and the change is recorded in the audit trail. After the documented review is complete, an Admin may select **إعادة التفعيل بعد المراجعة** to return the provider to `verified`.

## Manual dispatch workflow

1. Customer submits a request in the Moeen app or approved concierge channel.
2. Dispatcher reviews the category, requested time, and service location; confirms it is inside the pilot zone. The dashboard and API restrict assignment to a verified, available provider whose recorded specialties include the requested category.
3. Dispatcher contacts an eligible provider and records response time in the order tracker.
4. For variable-scope work, after assignment and before work begins, the dispatcher enters the inspected scope and amount as a **عرض السعر** in the dashboard. The customer sees the exact scope and Saudi Riyal amount in the app and must approve or reject it.
5. The dashboard hides **بدء الخدمة** while a quote is pending or rejected, and the API rejects the transition with `409 Quote approval required` even if a client bypasses the dashboard. Do not begin chargeable work without the approval event.
6. If the customer rejects a quote, clarify the scope or price and send a new quote; never edit or overwrite the rejected record. The request history retains both decisions.
7. Dispatcher moves the request through: `assigned` → `on_the_way` → `in_progress` → `completed` only after the approved quote where one was required.
8. Customer receives the agreed arrival/update communication through the approved operations channel.
9. On completion, record the final amount, issue/rework status, customer rating, and payment outcome under `payments-pilot-runbook.md`. Never record sensitive payment data.
10. If a support ticket or complaint is opened, record the operational outcome before marking it resolved.

### Quote decision and escalation

- A quote is a scope-and-price approval record, not a payment authorization. The controlled cash-at-completion payment remains subject to `payments-pilot-runbook.md`; electronic payment remains disabled until its launch gate is complete.
- `proposed`, `approved`, and `rejected` quote decisions are appended to the request event history. Staff should verify that history before resolving any price dispute.
- If the customer disputes a scope after approval, pause work when safe, open a support ticket, and document the operational outcome; do not silently replace the approved quote.
- For a changed scope that requires more work after approval, pause and escalate through support. The current pilot workflow deliberately does not allow a replacement quote after approval; do not start the changed scope until a documented operational resolution exists.

## Pilot operating targets

These are internal pilot targets, not public customer promises:

| Measure | Initial target |
|---|---:|
| Request acknowledgement by operations | within 10 minutes during pilot hours |
| Provider response after dispatch contact | within 5 minutes |
| Customer update after provider accepts | within 15 minutes |
| Unassigned requests | reviewed by the operations owner before shift close |
| Safety, no-show, or serious-quality reports | immediate escalation and provider pause pending review |

## Daily close-out

At the end of every pilot shift:

1. Reconcile each request in the dashboard with the pilot order tracker.
2. Mark incomplete jobs, cancellations, rework, complaints, and unpaid/unknown outcomes explicitly; never infer completion from silence.
3. Review provider response and arrival times.
4. Contact any dissatisfied customer through the approved support channel.
5. Record one action for every provider or process failure.

## Go / no-go gate for expansion

Do not open a wider Buraidah area, start paid acquisition, or move to another city until the operations owner has evidence of all of the following:

- At least 10 completed pilot jobs across the active categories.
- Every completed job has a recorded provider, quote/final-price outcome where applicable, and customer outcome.
- No unresolved safety incident or serious complaint.
- Reliable coverage from at least two vetted providers for each active category.
- A documented decision on cancellations, rework/refunds, customer support hours, and the payment method used in the next phase.
- A weekly review of response time, cancellation/no-show rate, ratings, complaints, and direct contribution margin.

## Files used during the pilot

- `templates/provider-vetting.csv` — private operational evidence index; keep identity documents outside Git.
- `templates/pilot-orders.csv` — one row per request/order; no phone numbers, OTPs, card data, or identity-document numbers.
