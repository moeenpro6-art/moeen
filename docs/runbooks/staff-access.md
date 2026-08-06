# Staff access runbook

## Purpose

This runbook covers the controlled local setup and safe operation of the Moeen operations dashboard.

## Bootstrap the first local administrator

1. Ensure `apps/api/.env` contains the names documented in `docs/environment.md`.
2. Start or restart the API. It creates the administrator only when that bootstrap email has no existing staff account.
3. Visit `http://localhost:3001` in a clean browser session.
4. Confirm the dashboard redirects to `/login`.
5. Sign in using the local administrator credentials.

Do not send credentials through chat, commit them, add them to test fixtures, or copy them into `.env.example`.

## Role boundaries

- `admin`: requests, dispatch, support, audit trail.
- `dispatcher`: requests, provider assignment, and job status changes.
- `support_agent`: support ticket viewing and status changes.

The NestJS API enforces these rules independently of the dashboard UI.

## Session handling

- Staff sessions expire after the configured lifetime.
- Logout revokes the API session and clears the dashboard HttpOnly cookie.
- An invalid API session redirects through the dashboard invalid-session endpoint, which clears the stale cookie before returning to login.
- A temporary API outage leads to a generic service error; it should not be interpreted as a credential failure.

## Compromised account response

Staff-account deactivation and password reset UI are intentionally deferred. Until a controlled staff-management feature exists:

1. Treat a suspected compromise as an operations incident.
2. Stop using the account and restrict dashboard access.
3. Review audit events for affected request or support-ticket IDs.
4. Rotate the affected local bootstrap credential only if the intended account does not already exist; do not expect this to overwrite an existing password.
5. Arrange a controlled database-side deactivation/reset procedure with an authorized maintainer; never perform unreviewed manual SQL in production.
