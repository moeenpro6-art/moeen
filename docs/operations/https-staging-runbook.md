# Moeen HTTPS staging launch runbook

> Scope: a limited Buraidah staging/pilot deployment. Do not use this as a production cutover checklist until the legal, operational, and payment gates are signed off.

## 1. Inputs required before deployment

Record these outside Git and do not send secrets in chat:

- API hostname, for example `api.staging.moeen.sa`.
- Operations-dashboard hostname, for example `ops.staging.moeen.sa`.
- The hosting target and its Linux/service account owner.
- DNS access for both hostnames.
- TLS certificate automation (for example, a managed certificate or ACME).
- Production/staging PostgreSQL connection string for the isolated Moeen database only.
- Twilio Verify production or staging configuration.
- Initial administrator details supplied through the secure deployment secret store.

## 2. Network and proxy topology

Use one TLS-terminating reverse proxy in front of the API and dashboard. The API must not be exposed directly to the internet on port `3002`.

```text
Internet
  -> HTTPS reverse proxy / WAF
    -> Dashboard service
    -> API service on a private network
    -> dedicated Moeen PostgreSQL instance
```

Set this only after verifying there is exactly one trusted proxy hop between clients and the API:

```text
MOEEN_TRUST_PROXY_HOPS=1
```

Do not set it merely to make `X-Forwarded-For` work. A wrong value lets callers spoof client IPs or makes all clients appear as the proxy, defeating the public OTP limiter.

## 3. Required production environment policy

- `NODE_ENV=production`
- `MOEEN_API_URL=https://<actual-api-hostname>` for the dashboard.
- Use a dedicated Moeen PostgreSQL database and credentials; never use the Odoo database.
- Store `DATABASE_URL`, Twilio values, bootstrap-admin password, and payment secrets only in the deployment secret store.
- Do not set cleartext HTTP API URLs in Flutter release builds.
- Do not enable Paymob live charges in this staging gate.

## 4. OTP abuse controls now present in the API

The API applies two durable, IP-based public-auth limits before calling Twilio:

| Endpoint | Limit | Window |
|---|---:|---:|
| `POST /auth/request-otp` | 10 sends per client IP | 10 minutes |
| `POST /auth/verify-otp` | 20 attempts per client IP | 10 minutes |

The existing per-phone cooldown and per-phone hourly limit remain active. Only SHA-256 hashes of scoped client identities are stored in the rate-limit table; raw IP addresses are not persisted.

A WAF/edge limit should still be configured as a second layer before public launch.

## 5. Staging acceptance checks

1. Confirm both public hostnames redirect HTTP to HTTPS and use valid certificates.
2. Confirm the dashboard rejects a missing or HTTP `MOEEN_API_URL` in production.
3. Confirm the API reports its security headers and does not expose `X-Powered-By`.
4. From an external device, complete one Twilio OTP login and create one test booking.
5. From the dashboard, assign the booking, record a quote, approve it as the customer, and progress it through completion.
6. Confirm the provider Android release build uses the HTTPS API origin and can view only assigned jobs.
7. Confirm an eleventh OTP request from one test client address within ten minutes receives `429` without sending another SMS.
8. Confirm logs and monitoring do not contain OTPs, access codes, tokens, passwords, payment data, or database URLs.
9. Record the test in the pilot acceptance log, then remove test-only operational data according to the retention procedure.

## 6. Explicit non-launch conditions

Do not open registration to the public if any condition remains true:

- no real HTTPS API/dashboard hostnames;
- no verified trusted-proxy hop configuration;
- no WAF/edge throttling policy;
- no Arabic privacy, terms, cancellation/refund, and complaints workflow;
- no Saudi legal review of marketplace/provider/licensing obligations;
- no limited-provider operational on-call plan;
- Paymob live payment is enabled without its separate webhook/idempotency/reconciliation acceptance gate.
