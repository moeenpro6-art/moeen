# Staff Authentication, Authorization, and Audit Trail Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Prevent anonymous access to Moeen's operations dashboard and APIs, enforce the minimum staff-role permissions, and record every sensitive operational action in an immutable audit trail.

**Architecture:** Keep PostgreSQL 16 on `localhost:5433` as the source of truth. The NestJS API owns staff accounts, password verification, opaque server-side sessions, role checks, and audit-event persistence. The Next.js dashboard never exposes a session token to browser JavaScript: it stores the API-issued opaque token in an `HttpOnly`, same-site dashboard cookie and forwards it only from server components/actions to the API. The dashboard is protected at the route level and presents an Arabic login screen plus a read-only audit view for authorized admins.

**Tech Stack:** NestJS 11 / TypeScript, Node `crypto.scrypt` (no new password library needed), PostgreSQL via `pg`, Next.js 16 Server Components/Server Actions, React 19, Jest, and existing ESLint/TypeScript tooling.

---

## Current context and non-negotiable constraints

- `apps/admin-web/src/app/page.tsx` currently fetches `GET /service-requests`, `GET /providers`, and `GET /support-tickets` anonymously, and its three server actions make anonymous mutation requests.
- `apps/api/src/app.controller.ts` leaves all operations endpoints anonymous.
- `apps/api/src/service-request.repository.ts` already initializes schema incrementally with `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
- Customer authentication and customer session tokens remain separate from staff authentication. Do not reuse customer tables or customer tokens.
- Never add a staff password, initial admin password, session token, or production credential to source control, test snapshots, plans, logs, or chat.
- Do not touch the unrelated Odoo PostgreSQL service on port `5432`.
- No public dashboard view or mutation may remain accessible without a valid staff session after this phase.
- Roles for this phase are exactly `admin`, `dispatcher`, and `support_agent`.

## Permission matrix

| Action | admin | dispatcher | support_agent |
|---|:---:|:---:|:---:|
| Read operations requests / providers | ✓ | ✓ | — |
| Assign a provider | ✓ | ✓ | — |
| Update service-request status | ✓ | ✓ | — |
| Read support tickets | ✓ | — | ✓ |
| Update support-ticket status | ✓ | — | ✓ |
| Read audit trail | ✓ | — | — |
| Create/deactivate staff accounts | deferred | — | — |

The first local administrator is bootstrapped only from ignored environment variables. A later staff-management feature can create further accounts; it is not required to protect the existing dashboard.

## Data model

Create three tables using idempotent migrations:

```text
staff_users
  id BIGSERIAL PK
  email TEXT UNIQUE NOT NULL
  display_name TEXT NOT NULL
  role TEXT NOT NULL CHECK (admin|dispatcher|support_agent)
  password_hash TEXT NOT NULL
  is_active BOOLEAN NOT NULL DEFAULT TRUE
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()

staff_sessions
  token_hash TEXT PK
  staff_user_id BIGINT NOT NULL REFERENCES staff_users(id)
  expires_at TIMESTAMPTZ NOT NULL
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()

staff_audit_events
  id BIGSERIAL PK
  staff_user_id BIGINT NOT NULL REFERENCES staff_users(id)
  action TEXT NOT NULL
  subject_type TEXT NOT NULL
  subject_id TEXT NOT NULL
  old_state JSONB
  new_state JSONB
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

- Store only SHA-256 hashes of random session tokens, as with customer sessions.
- Store password hashes using Node `crypto.scrypt` with a unique random salt and a versioned serialized format such as `scrypt$<salt>$<derived-key>`.
- Audit events contain IDs and state/role transition fields only; never contain passwords, session tokens, OTPs, phone numbers, addresses, or free-text customer comments.
- Add indexes for `staff_sessions(expires_at)`, `staff_audit_events(staff_user_id, created_at DESC)`, and `staff_audit_events(subject_type, subject_id, created_at DESC)`.

## Environment contract

Document names only in `apps/api/.env.example` and `docs/environment.md`:

```text
MOEEN_INITIAL_ADMIN_EMAIL=
MOEEN_INITIAL_ADMIN_NAME=
MOEEN_INITIAL_ADMIN_PASSWORD=
STAFF_SESSION_TTL_DAYS=7
MOEEN_DASHBOARD_SESSION_COOKIE=moeen_staff_session
```

Local `.env` values stay ignored. Startup behavior must fail closed for dashboard access when no staff account exists; an explicit local bootstrap command or first-start bootstrap based on the three initial-admin environment variables may create the initial account. It must never emit the supplied password or a session token.

---

### Task 1: Add failing unit tests for password hashing and staff session behavior

**Objective:** Define the security primitives before adding authentication code.

**Files:**
- Create: `apps/api/src/staff-auth.service.spec.ts`
- Create: `apps/api/src/staff-auth.service.ts`

**Step 1: Write failing tests**

Test real service behavior with a minimal fake `StaffAuthStore`:

- `hashPassword` produces a value that verifies the matching password and rejects a different one.
- logging in an active staff member with correct credentials creates a session and returns the role-safe staff profile plus an opaque token;
- unknown/inactive staff members and incorrect passwords yield the same `Unauthorized` outcome;
- resolving an expired or unknown staff session yields `Unauthorized`;
- logout revokes the current staff session.

Do not put a real secret in the test; use a harmless fixed test-only string that is never a production credential.

**Step 2: Run the focused test to verify RED**

```bash
cd apps/api
npm test -- staff-auth.service.spec.ts --runInBand
```

Expected: fail because `StaffAuthService` is missing.

**Step 3: Write minimal implementation**

Create `StaffAuthService` with:

- `login(email, password)`;
- `getCurrentStaff(token)`;
- `logout(token)`;
- private Node-crypto `scrypt`/timing-safe password helpers;
- role-safe return types that never include `passwordHash` or token hashes;
- a small `StaffAuthStore` interface used by the repository.

**Step 4: Run the focused test to verify GREEN**

```bash
npm test -- staff-auth.service.spec.ts --runInBand
```

Expected: pass.

**Step 5: Commit**

```bash
git add apps/api/src/staff-auth.service.ts apps/api/src/staff-auth.service.spec.ts
git commit -m "feat(api): add staff authentication service"
```

---

### Task 2: Add staff, session, and audit persistence with a safe local bootstrap path

**Objective:** Persist staff credentials, sessions, and auditable events without coupling them to customer identities.

**Files:**
- Create: `apps/api/src/staff-auth.repository.ts`
- Create: `apps/api/src/staff-auth.repository.spec.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/.env.example`
- Modify: `docs/environment.md`

**Step 1: Write failing repository tests**

Cover:

- persisting and finding a normalized email address;
- storing only an opaque session token hash and resolving it only before expiry;
- deleting/revoking a session;
- creating audit events without password/session/phone fields;
- bootstrap is idempotent and only runs when the required environment values are present.

Use a dedicated test database configuration or transaction cleanup. Never point tests at Odoo port `5432`.

**Step 2: Run the focused test to verify RED**

```bash
cd apps/api
npm test -- staff-auth.repository.spec.ts --runInBand
```

Expected: fail because the repository/schema behavior does not exist.

**Step 3: Implement the schema and repository minimally**

- Give `StaffAuthRepository` its own `Pool` lifecycle, or extract a shared database provider so API repositories do not create redundant lifecycle races.
- Add the three idempotent table migrations and indexes.
- Use parameterized SQL exclusively.
- Implement `findByEmail`, `createSession`, `findStaffBySession`, `revokeSession`, `appendAuditEvent`, and initial-admin bootstrap.
- Normalize staff email to lowercase/trimmed form before lookup and storage.
- Store no raw password or raw token in database columns or log output.

**Step 4: Run focused tests to verify GREEN**

```bash
npm test -- staff-auth.repository.spec.ts --runInBand
```

**Step 5: Commit**

```bash
git add apps/api/src/staff-auth.repository.ts apps/api/src/staff-auth.repository.spec.ts apps/api/src/app.module.ts apps/api/.env.example docs/environment.md
git commit -m "feat(api): persist staff sessions and audit events"
```

---

### Task 3: Define and test API authentication and role enforcement

**Objective:** Make API authorization server-side and impossible to bypass from the dashboard browser.

**Files:**
- Create: `apps/api/src/staff-auth.guard.ts`
- Create: `apps/api/src/staff-roles.decorator.ts`
- Create: `apps/api/src/staff-auth.e2e-spec.ts` or extend `apps/api/test/app.e2e-spec.ts`
- Modify: `apps/api/src/app.controller.ts`
- Modify: `apps/api/src/app.module.ts`

**Step 1: Write failing integration tests**

Cover each protected endpoint:

- no `Authorization: Bearer …` header receives `401`;
- an invalid/expired token receives `401`;
- a `dispatcher` can read requests/providers, assign a provider, and update a job status;
- a `dispatcher` receives `403` for support-ticket endpoints;
- a `support_agent` can read/update tickets and receives `403` for operational dispatch endpoints;
- an `admin` can perform both sets of actions;
- authenticated `GET /admin/auth/me` returns only id, display name, email, and role;
- `POST /admin/auth/logout` invalidates the current staff session.

Also assert customer endpoints continue accepting customer sessions and reject staff session tokens where customer authentication is required.

**Step 2: Run the focused tests to verify RED**

```bash
cd apps/api
npm run test:e2e -- --runInBand
```

Expected: authorization cases fail because operations routes are still public.

**Step 3: Implement minimal API endpoints and guard**

Add:

```text
POST /admin/auth/login
POST /admin/auth/logout
GET  /admin/auth/me
GET  /admin/audit-events
```

Use a custom staff guard that extracts a Bearer token, resolves staff identity using `StaffAuthService`, attaches only a role-safe principal, and evaluates `@StaffRoles(...)` metadata. Apply it to:

```text
GET   /providers                         admin, dispatcher
GET   /service-requests                  admin, dispatcher
PATCH /service-requests/:id/assignment   admin, dispatcher
PATCH /service-requests/:id/status       admin, dispatcher
GET   /support-tickets                   admin, support_agent
PATCH /support-tickets/:id/status        admin, support_agent
GET   /admin/audit-events                admin
```

Do not protect public launch-service discovery or customer `/auth/*` endpoints with this guard.

**Step 4: Verify GREEN**

```bash
npm run test:e2e -- --runInBand
npm test -- --runInBand
```

**Step 5: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): authorize staff operations endpoints"
```

---

### Task 4: Audit every sensitive staff mutation

**Objective:** Ensure operational actions are attributable and queryable after the fact.

**Files:**
- Create: `apps/api/src/audit.service.ts`
- Create: `apps/api/src/audit.service.spec.ts`
- Modify: `apps/api/src/app.service.ts`
- Modify: `apps/api/src/app.controller.ts`
- Modify: `apps/api/src/staff-auth.repository.ts`

**Step 1: Write failing service tests**

Test that an authenticated actor causes exactly one audit event for each successful mutation:

- provider assignment records `request.provider_assigned`, request ID, previous `pending_dispatch`, and new provider/status data;
- service status update records `request.status_updated`, request ID, old/new status;
- support ticket update records `support_ticket.status_updated`, ticket ID, old/new status;
- failed/unauthorized operations produce no state change and no success audit event.

**Step 2: Run RED**

```bash
cd apps/api
npm test -- audit.service.spec.ts --runInBand
```

**Step 3: Implement the minimal audit path**

- Have the guard/controller pass the authenticated staff principal into each protected service call.
- Read required old state before mutation, perform the mutation, then append the audit event only after a successful mutation.
- Use JSON-safe state objects containing IDs/statuses/role-safe provider identifiers only.
- Provide an admin-only API list in descending time order with a bounded default and hard maximum page size.

**Step 4: Verify GREEN**

```bash
npm test -- audit.service.spec.ts --runInBand
npm run test:e2e -- --runInBand
```

**Step 5: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): audit staff operations changes"
```

---

### Task 5: Add a secure Arabic dashboard login and server-side API client

**Objective:** Remove anonymous dashboard access while keeping API tokens out of browser JavaScript.

**Files:**
- Create: `apps/admin-web/src/app/login/page.tsx`
- Create: `apps/admin-web/src/app/login/actions.ts`
- Create: `apps/admin-web/src/app/auth/session.ts`
- Create: `apps/admin-web/src/app/auth/api-client.ts`
- Create: `apps/admin-web/src/app/logout/action.ts`
- Create: `apps/admin-web/src/middleware.ts`
- Create: `apps/admin-web/src/app/login/login.module.css`
- Modify: `apps/admin-web/src/app/page.tsx`
- Modify: `apps/admin-web/src/app/page.module.css`

**Step 1: Write failing dashboard tests**

Use the existing `tsx` test convention or add an explicit Node test script only if needed. Cover:

- unauthenticated request to `/` redirects to `/login`;
- valid cookie causes the server API client to forward a Bearer token without rendering it;
- invalid API session redirects back to login and clears the dashboard cookie;
- login failure gives a generic Arabic message without reporting whether email/account/password was wrong;
- logout removes the dashboard cookie and API session.

**Step 2: Run RED**

```bash
cd apps/admin-web
npx tsx --test src/app/auth/*.test.ts src/app/login/*.test.ts
```

**Step 3: Implement minimally**

- Login Server Action posts credentials to `POST /admin/auth/login`.
- On success, set only the opaque staff session token as an `HttpOnly`, `SameSite=Strict`, path-scoped cookie; use `secure: process.env.NODE_ENV === 'production'`.
- Dashboard server components and actions call a centralized `api-client.ts`, which reads the server-side cookie and forwards it as `Authorization: Bearer …` to the API. No raw fetch to protected API endpoints may remain in `page.tsx`.
- `middleware.ts` redirects absent-cookie visitors to `/login` and authenticated visitors away from `/login`; server-side `requireStaff()` still validates the API session for revocation/expiry correctness.
- Render staff display name/role and a logout form in the dashboard header.
- On API `401` or `403`, server actions must fail safely, revalidate/redirect as appropriate, and never silently act as anonymous requests.

**Step 4: Verify GREEN**

```bash
npx tsx --test src/app/auth/*.test.ts src/app/login/*.test.ts
npm run lint
npm run build
```

**Step 5: Commit**

```bash
git add apps/admin-web/src
git commit -m "feat(dashboard): require staff login"
```

---

### Task 6: Render an admin-only audit-trail section and role-appropriate dashboard

**Objective:** Make authorized staff actions inspectable and hide unavailable controls at the UI layer without relying on UI-only security.

**Files:**
- Create: `apps/admin-web/src/app/audit.ts`
- Create: `apps/admin-web/src/app/audit.test.ts`
- Modify: `apps/admin-web/src/app/page.tsx`
- Modify: `apps/admin-web/src/app/page.module.css`
- Modify: `apps/admin-web/src/app/requests.ts`
- Modify: `apps/admin-web/src/app/support.ts`

**Step 1: Write failing tests**

Test mapping of safe audit-event API objects to Arabic labels and test role predicates:

- dispatcher sees the request operations section but not support controls/audit;
- support agent sees support section but not dispatch controls/audit;
- admin sees both sections plus latest audit events;
- malformed or unexpected API events fail closed (not rendered as a valid action).

**Step 2: Run RED**

```bash
cd apps/admin-web
npx tsx --test src/app/audit.test.ts src/app/requests.test.ts src/app/support.test.ts
```

**Step 3: Implement minimally**

- Fetch `/admin/auth/me` first and render role-appropriate sections only after staff validation.
- Fetch `/admin/audit-events` only for admins.
- Add a short Arabic audit section showing timestamp, actor display name, action label, object ID, and before/after status where present.
- Do not render raw token, password, address, phone number, or free-text ticket comment in audit events.
- Keep server-side API role enforcement as the authoritative security boundary.

**Step 4: Verify GREEN**

```bash
npx tsx --test src/app/audit.test.ts src/app/requests.test.ts src/app/support.test.ts
npm run lint
npm run build
```

**Step 5: Commit**

```bash
git add apps/admin-web/src
git commit -m "feat(dashboard): show role-safe audit trail"
```

---

### Task 7: End-to-end security verification and documentation

**Objective:** Demonstrate the dashboard is protected in the running local system and provide a reproducible handoff.

**Files:**
- Create: `docs/runbooks/staff-access.md`
- Create: `docs/runbooks/audit-trail.md`
- Modify: `README.md`
- Modify: `docs/development.md`

**Step 1: Write/extend E2E assertions before any documentation claim**

Add exact HTTP assertions for unauthorized/forbidden/success paths and audit-event retrieval after an authorized operation. Verify a raw dashboard/API call cannot bypass login.

**Step 2: Execute the complete verification suite**

```bash
cd apps/api
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm run lint
npm run build

cd ../admin-web
npx tsx --test src/app/**/*.test.ts
npm run lint
npm run build

cd ../mobile
../../../tools/flutter/bin/flutter test
../../../tools/flutter/bin/flutter analyze
```

**Step 3: Manual local verification**

1. Start API with local ignored staff bootstrap variables configured; do not print their values.
2. Visit `http://localhost:3001` in a clean browser session; expect redirect to `/login`.
3. Attempt an incorrect sign-in; expect generic Arabic failure.
4. Log in as each test role and confirm only permitted controls render.
5. Attempt protected API endpoints with no/invalid staff bearer token; expect `401`.
6. Attempt a forbidden role action; expect `403`.
7. As an admin/dispatcher, perform a test provider assignment and status update; confirm the corresponding audit event exists.
8. As an admin/support agent, update a test support ticket; confirm its audit event exists.
9. Sign out, revisit `/`, and confirm redirect to `/login`.

**Step 4: Document secure setup and incident behavior**

Write instructions for local bootstrap, session expiry/logout, deactivating a compromised staff user, and reviewing audit events. Document variable names only; redact all values.

**Step 5: Commit**

```bash
git add README.md docs apps
git commit -m "docs: document staff access controls"
```

---

## Acceptance criteria

- [ ] Dashboard root and all operations API endpoints reject anonymous access.
- [ ] Staff roles are enforced in the NestJS API, not merely hidden in Next.js.
- [ ] The dashboard stores its opaque API token in an `HttpOnly`, same-site cookie and never renders or reads it in client JavaScript.
- [ ] Incorrect email/password/inactive-user cases present the same generic authentication error.
- [ ] Passwords, OTPs, raw staff session tokens, and raw token hashes are absent from API responses, dashboard HTML, audit events, logs, documentation examples, and source control.
- [ ] Every successful assignment, request-status update, and support-ticket status update creates a role-safe audit event with actor, action, subject, old/new state, and timestamp.
- [ ] Admin sees audit events; dispatcher and support agent cannot request them.
- [ ] Customer login and customer-owned request/rating/support behavior remain unchanged and covered by tests.
- [ ] API unit/E2E/lint/build, dashboard tests/lint/build, and Flutter regression tests/analyze pass.
- [ ] A clean browser session cannot view `http://localhost:3001` without staff login, and logout/revocation removes access.

## Risks and decisions

1. **No password dependency is currently installed.** Use Node `crypto.scrypt` and `timingSafeEqual`, not an improvised plaintext or unsalted SHA-256 password scheme.
2. **Next.js and API use different local origins.** Let Next own the `HttpOnly` dashboard cookie and relay it server-to-server as an API Bearer header. Do not set a JavaScript-readable localStorage token or depend on a cross-port cookie.
3. **Bootstrap credential safety matters.** Initial staff credentials must originate only in ignored runtime configuration. Do not hard-code seed passwords or return them from an endpoint.
4. **Audit safety matters.** Store structured status/ID data, not customer PII or ticket comments.
5. **The current API service/repository signatures do not carry an actor.** Update the internal service boundary deliberately so mutations accept an authenticated staff principal; do not create a client-spoofable `actorId` request-body field.
6. **Staff administration is deliberately deferred.** This phase seeds/protects a small controlled staff cohort; self-service invites, password reset, MFA, and fine-grained provider administration require a subsequent security phase.

## Out of scope for this phase

- Production SMS OTP replacement and rate limits.
- Public deployment, HTTPS/TLS provisioning, WAF, SSO, or MFA.
- Staff invitation/password-reset UI.
- Provider identity/app authentication.
- Payments, quotes, new service statuses, photos, notifications, or iOS.
