# Staff audit trail runbook

## Events recorded

The API records an audit event only after a successful sensitive staff mutation:

- `request.provider_assigned`
- `request.status_updated`
- `support_ticket.status_updated`

Each event contains a staff actor ID/display name, action, subject type/ID, previous safe state, new safe state, and timestamp.

## Information deliberately excluded

Audit states must never include passwords, raw session tokens, OTPs, customer phone numbers, addresses, or customer support-comment text.

## Reviewing events

Only an `admin` may request:

```http
GET /admin/audit-events
```

The dashboard maps these events to Arabic labels and shows the latest operation, actor, object ID, timestamp, and before/after status when present.

## Investigation workflow

1. Identify the request ID or support-ticket ID involved.
2. Log in as an admin.
3. Review the relevant audit event and compare its timestamp and actor with the operational record.
4. Preserve the event identifiers and minimal relevant facts in the incident record.
5. Do not copy sensitive customer data into the audit event or the investigation summary.

A failed, unauthenticated, or forbidden mutation must not be treated as a successful audit event.