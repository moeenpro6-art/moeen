# Moeen environment contract

Local secrets belong in ignored `.env` files only. Never commit them, paste them into tickets, or put them into `NEXT_PUBLIC_*` variables.

## API: `apps/api/.env`

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Moeen PostgreSQL connection. It must point to port `5433`, never the Odoo service on `5432`. |
| `TEST_DATABASE_URL` | Required whenever `NODE_ENV=test`. Prefer a separate `moeen_test` database. If the local role cannot create databases, use a dedicated non-public test schema via the PostgreSQL `options=-c search_path=moeen_test` connection option; never let tests use the public production schema. |
| `MOEEN_INITIAL_ADMIN_EMAIL` | Local bootstrap identifier for the first administrator. |
| `MOEEN_INITIAL_ADMIN_NAME` | Display name for the first administrator. |
| `MOEEN_INITIAL_ADMIN_PASSWORD` | Initial administrator password. Keep private. |
| `STAFF_SESSION_TTL_DAYS` | Staff-session lifetime; default is seven days. |
| `OTP_PROVIDER` | Must be `twilio_verify` for the production OTP path. |
| `TWILIO_API_KEY` | Standard Twilio API Key SID used only by the API process. |
| `TWILIO_API_SECRET` | Secret paired with `TWILIO_API_KEY`; never commit or expose it. |
| `TWILIO_VERIFY_SERVICE_SID` | Verify Service SID for `Moeen Customer OTP`. |

The initial-admin values are read during API startup. Bootstrap is idempotent and does not overwrite an existing account.

## Dashboard: `apps/admin-web/.env`

| Variable | Purpose |
|---|---|
| `MOEEN_API_URL` | Server-side API base URL; local default is `http://localhost:3002`. |
| `MOEEN_DASHBOARD_SESSION_COOKIE` | Optional non-public cookie-name override. |

The dashboard’s staff cookie is HttpOnly. Do not store a staff token in browser storage or expose one as a public environment variable.
