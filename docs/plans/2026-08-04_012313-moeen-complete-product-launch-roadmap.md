# Moeen Complete Product and Launch Roadmap

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Launch معين (Moeen) as a trusted, operations-led home-services marketplace in Buraidah, Al-Qassim, then expand deliberately to nearby cities only after supply quality, dispatch, payment, and support metrics prove repeatable.

**Architecture:** Keep one PostgreSQL-backed NestJS API as the business source of truth. Operate three distinct products over it: customer Flutter app, protected web operations dashboard, and later a separate Android-first Flutter provider app. Treat software as support for operations: provider vetting, dispatch, quality control, customer support, payment, refunds, and warranties come before geographic expansion.

**Tech Stack:** Flutter/Dart customer and provider apps; NestJS/TypeScript API; PostgreSQL 16 at `localhost:5433` for local development; Next.js/TypeScript operations dashboard; `pg` SQL repository layer; Saudi-capable SMS provider and payment gateway selected before production; FCM and object storage when job evidence/photos are introduced.

---

## 1. Product principle and launch boundary

### Customer promise

> **معين يرسل مقدم خدمة موثوقًا، بمتابعة واضحة، وتسعير مفهوم، ودعم يحل المشكلة عند حدوثها.**

### Initial market boundary

- **Country:** Saudi Arabia.
- **Launch city:** Buraidah only.
- **Expand later:** Unaizah, then Al-Rass, only after Buraidah operating metrics are stable.
- **Initial categories:** AC cleaning, upholstery/mattress cleaning, home cleaning, tank cleaning, plumbing/leak repair.
- **Model:** managed dispatch: customer submits a request; operations chooses and assigns the right provider.

### Do not build yet

- Nationwide launch.
- Public provider marketplace/search results.
- iOS release before Android/operations are proven.
- Automated pricing for diagnostic plumbing/leak jobs.
- Advanced AI automation that approves refunds, suspends providers, sets final prices, or handles serious complaints without an operator.

---

## 2. Current starting point (already built)

The existing local vertical slice includes:

```text
Saudi OTP development login
→ secure customer session
→ authenticated booking
→ PostgreSQL customer ownership
→ operations provider assignment
→ service lifecycle status
→ customer-only "طلباتي"
→ completion rating
→ support ticket creation and operations follow-up
```

Existing local products:

| Product | Current location | State |
|---|---|---|
| Customer Flutter app | `apps/mobile` | Windows build verified; Android toolchain is not configured yet |
| NestJS API | `apps/api` | local API and PostgreSQL persistence verified |
| Operations dashboard | `apps/admin-web` | live local dashboard; not yet protected with staff authentication |
| Provider app | — | not yet built |

**Critical local safety rule:** Moeen uses PostgreSQL on port `5433`. Never alter the unrelated Odoo PostgreSQL instance on port `5432`.

---

## 3. Correct order of work

Run the following tracks in parallel where practical, but do not promote to production until the launch gates in Phase 11 are met.

```text
Provider supply + manual operations pilot
                     ↘
Engineering hardening → Android customer beta → dispatch proof
                     ↘
Provider app → payments/evidence → controlled Buraidah launch
                     ↘
iOS distribution → city expansion
```

The correct first investment is **operations and Android validation**, not an iPhone app and not a large provider marketplace.

---

## Phase 0 — Prove the business manually before scaling software

**Objective:** Verify that Moeen can deliver reliable real-world service in Buraidah, not merely collect app requests.

### Task 0.1: Define operating policies

Write concise Arabic policies for:

- provider screening and required documents;
- arrival-time commitment;
- fixed-price versus inspection/quote categories;
- cancellation and no-show policy;
- workmanship warranty by category;
- refund/escalation authority;
- support response-time target;
- prohibited provider behavior and suspension rule.

**Deliverables:** `docs/operations/` policy documents and a one-page operator playbook.

### Task 0.2: Recruit supply before demand marketing

Recruit a small, vetted starting cohort in Buraidah:

- at least two viable providers per launch category where possible;
- backup coverage for urgent plumbing and AC work;
- verified identity/business details, service zones, equipment, pricing approach, availability, and bank/payment details;
- practical quality trial before activation.

**Exit criteria:** Operations can assign a credible provider for common requests without relying on one person.

### Task 0.3: Run a controlled pilot

Accept requests through the customer app plus a monitored phone/WhatsApp fallback. Log each request in the dashboard or a controlled operational sheet:

```text
category, zone, time received, assigned provider, time to acceptance,
arrival time, quoted price, final price, completion, rating,
support ticket, refund/warranty action, repeat customer
```

**Pilot success indicators:** providers respond reliably, arrival is predictable, complaints are resolvable, unit economics are measurable, and repeat intent is present.

---

## Phase 1 — Make the engineering baseline safe to continue

**Objective:** Convert the local prototype into a maintainable team-ready codebase without changing customer scope.

### Task 1.1: Establish source-control discipline

**Files:**
- Modify: `.gitignore`, `README.md`
- Create: `docs/development.md`, `docs/environment.md`

**Steps:**
1. Confirm `.env`, build outputs, secure credentials, tokens, and generated artifacts are ignored.
2. Document non-secret environment variable names in `.env.example` files only.
3. Create the first clean Git baseline after reviewing tracked files.
4. Require feature branches, small commits, and code review before production changes.

**Verification:** `git status`, API tests/build, dashboard lint/build, Flutter test/analyze/build.

### Task 1.2: Split environments

Create separate development, staging, and production configuration rules.

- Development: local PostgreSQL `5433`, development OTP only.
- Staging: separate database and SMS/payment sandbox.
- Production: isolated database, no local OTP, secrets in a secret manager, backups enabled.

**Never:** copy local production-like credentials into source control or chat.

### Task 1.3: Add observability and backups

Add structured error logging with redaction, uptime checks, database backup/restore procedure, and incident runbook.

**Exit criteria:** a developer can restore a staged backup and trace a failed request without seeing raw OTPs or session tokens.

---

## Phase 2 — Production hardening before public beta

**Objective:** Protect customer data and prevent public access to internal operational controls.

### Task 2.1: Protect the operations dashboard

**Likely files:**
- Create: `apps/api/src/admin-auth.*`, `apps/api/src/admin-user.repository.ts`
- Modify: `apps/api/src/app.controller.ts`, `apps/admin-web/src/app/page.tsx`
- Create: dashboard login route and middleware.

**Requirements:**

- Staff login; no anonymous dashboard access.
- Roles: `admin`, `dispatcher`, `support_agent`, and later `provider`.
- Server-side authorization for assignment, request status, support ticket status, refunds, and provider administration.
- Audit trail: actor, action, request/ticket ID, old state, new state, timestamp.

### Task 2.2: Validate every API payload

Replace ad-hoc body shapes with NestJS DTOs and `class-validator` / `class-transformer`.

Validate and constrain:

- OTP request and verification;
- service request creation;
- provider assignment;
- service transition;
- rating;
- support ticket;
- staff actions.

Add consistent Arabic-safe customer error messages and machine-readable error codes.

### Task 2.3: Replace development OTP

Select and integrate one Saudi-capable SMS provider after commercial review.

Required controls:

```text
OTP hash at rest
short expiration
attempt limits
phone/IP rate limits
resend cooldown
no OTP/token logging
fraud monitoring
```

**Exit criteria:** no production code path returns or logs a development OTP.

### Task 2.4: Session lifecycle

Add logout/revocation endpoint, server-side token invalidation, expiry UI, and forced sign-out for compromised sessions.

**Security release gate:** complete all Phase 2 tasks before accepting real public customer data.

---

## Phase 3 — Android customer beta

**Objective:** Run the actual Arabic customer experience on physical Android phones in Buraidah.

### Task 3.1: Configure Android locally

The current machine needs Android SDK command-line tools and an emulator or USB-debug-enabled Android device.

**Steps:**
1. Install/configure Android Studio and Android SDK.
2. Install command-line tools, platform tools, emulator, and a stable Android platform image.
3. Set SDK variables correctly; run `flutter doctor -v` until Android toolchain is green.
4. Test `flutter run` on an emulator and at least one physical Android phone.

### Task 3.2: Android release quality

- Android app icon, Arabic name, package ID, versioning, privacy links.
- Release signing kept out of source control.
- Crash reporting and analytics only after a privacy review.
- Test slow network, app restart, session expiry, large Arabic text, and permission denial.

**Verification:**

```bash
cd apps/mobile
flutter test
flutter analyze
flutter build apk --release
flutter build appbundle --release
```

**Exit criteria:** tested internal APK on several real Android devices and a signed AAB ready for Play Console internal testing.

---

## Phase 4 — Complete the service-request operating workflow

**Objective:** Make the job lifecycle real enough for dispatch and disputes.

### Task 4.1: Enforce status transitions

Current status updates must become a server-enforced graph:

```text
pending_dispatch
→ assigned
→ accepted_by_provider
→ on_the_way
→ arrived
→ in_progress
→ completed
```

Alternative outcomes:

```text
cancelled_by_customer
cancelled_by_operations
provider_declined
no_show
requires_quote
quote_approved
```

Every transition needs role checks, allowed predecessor state, timestamp, and audit event.

### Task 4.2: Quotes for variable-scope work

Use a request → inspection/quote → customer approval flow for plumbing/leak repairs and any uncertain job.

A quote includes scope, price, material inclusion, validity, warranty, and customer approval timestamp. Never auto-charge or start unapproved quotes.

### Task 4.3: Job evidence and quality control

Add optional before/after photos, operational notes, and completion evidence.

**Architecture:** object storage with signed uploads; store object references in PostgreSQL, not image bytes.

### Task 4.4: Customer notifications

Use FCM/push notifications for assignment, provider en route, quote pending, completion, support updates, and cancellation. Provide SMS fallback for critical events if push is unavailable.

---

## Phase 5 — Build the provider app (Android first)

**Objective:** Give vetted technicians only their own work, without exposing customer data or operations controls.

### Product choice

Build a **separate Flutter provider app** rather than mixing customer and technician modes into the customer app.

**Provider MVP screens:**

```text
provider login
→ availability toggle / working zones
→ assigned jobs list
→ job details
→ accept or decline within time limit
→ navigation launch
→ on-the-way / arrived / start / complete buttons
→ photo/evidence upload
→ quote submission where applicable
→ earnings/history summary
```

### API requirements

- Provider identity linked to a provider record.
- Provider may read only their own assigned jobs.
- Provider may perform only allowed transitions.
- Provider cannot access customer session data, dashboard-wide data, payments/refunds, or another provider’s jobs.
- Dispatch lock/acceptance timeout prevents two providers from taking one job.

### Files likely to be created

```text
apps/provider-mobile/
apps/api/src/provider-auth.*
apps/api/src/provider-job.*
apps/api/src/provider.repository.ts
apps/api/src/job-event.repository.ts
```

### Exit criteria

A dispatcher assigns a job; only the selected provider sees it; provider acceptance and live status update appear to both the customer and operations.

---

## Phase 6 — Payments, receipts, refunds, and unit economics

**Objective:** Collect money safely and know whether each category is profitable.

### Task 6.1: Decide payment policy by service type

- Fixed cleaning: online pre-authorization/deposit or payment on completion, according to pilot behavior and gateway capability.
- Variable repair: quote approval first; charge only after approval.
- Cash-on-service only if it remains operationally necessary and is reconciled.

### Task 6.2: Integrate payment provider

Use the selected Saudi-capable payment gateway (Paymob remains the preferred candidate subject to merchant onboarding and current Saudi support verification).

Requirements:

- payment intent/order records;
- signed webhook verification;
- idempotency keys;
- no card data stored by Moeen;
- failure/cancellation/refund handling;
- reconciliation view for operations;
- Arabic receipt/invoice fields as required.

### Task 6.3: Measure per-job economics

Track request source, paid amount, provider payout, promotion cost, payment fee, refund cost, support cost, gross margin, and repeat booking.

**Exit criteria:** Moeen can decide which categories/zones to scale based on data, not intuition.

---

## Phase 7 — Trust, compliance, and customer protection

**Objective:** Make the service credible enough for work inside homes.

Before paid public launch, complete:

- Saudi business/legal and invoicing review with a qualified local professional;
- privacy policy, terms, and service warranty policy in Arabic;
- provider eligibility and identity verification policy;
- data retention and deletion procedure;
- customer emergency/support escalation process;
- refund and complaint SLA;
- staff access controls and audit logs;
- regular database backups and restore test;
- security review of OTP, staff auth, payment webhooks, media uploads, and authorization boundaries.

---

## Phase 8 — Buraidah controlled launch

**Objective:** Grow slowly enough to preserve quality.

### Launch sequence

1. Invite-only internal beta: friends, known households, and tested providers.
2. Controlled Buraidah zone beta: limited hours/categories and manual quality checks.
3. Expand zones only when current zones meet service-level targets.
4. Start paid acquisition only after provider response capacity is confirmed.

### Weekly operating scorecard

Track at minimum:

```text
request volume
assignment time
provider acceptance rate
arrival within promised window
completion rate
cancellation/no-show rate
average rating
low-rating rate
support-ticket rate
support resolution time
refund rate
repeat booking rate
gross margin per completed job
```

Set specific targets after the first pilot data rather than inventing unrealistic numbers before real work begins.

---

## Phase 9 — iOS only after Android proof

**Objective:** reach iPhone customers without slowing the first operational launch.

### Requirements

- Mac with Xcode.
- Apple Developer account and signing configuration.
- Physical iPhone and/or iOS simulator testing.
- TestFlight internal beta before App Store review.
- Same API, analytics, privacy, support, notification, and payment behavior as Android.

**Do not fork feature behavior by platform.** Keep shared Flutter customer code, while testing native payment/notification differences deliberately.

---

## Phase 10 — City expansion and automation

Only expand from Buraidah to Unaizah and Al-Rass once supply density, completion quality, support load, and unit economics are stable.

Potential later improvements:

- availability-aware dispatch suggestions;
- zone and travel-time estimation;
- provider quality score based on transparent, reviewable operational criteria;
- Arabic support-assist summaries for human agents;
- recurring maintenance reminders;
- B2B building/office workflows.

AI may assist routing suggestions, support summaries, categorization, and content—but final refund, suspension, safety, pricing, and severe-complaint decisions remain human-controlled.

---

## 4. Testing and quality gates

### Required on every API feature

1. Write a failing unit/E2E test first.
2. Implement minimal behavior.
3. Add authorization/ownership and failure-path tests.
4. Run:

```bash
cd apps/api
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm run lint
npm run build
```

### Required on every dashboard feature

```bash
cd apps/admin-web
npx tsx --test src/app/*.test.ts
npm run lint
npm run build
```

### Required on every Flutter feature

```bash
cd apps/mobile
flutter test
flutter analyze
flutter build apk --release
```

Provider app should use the same Flutter gates once created.

### Required before staging and production

- manual customer ownership test using two accounts;
- role/permission tests for staff and providers;
- API payload validation tests;
- webhook signature/idempotency tests when payments begin;
- device testing on low/mid-range Android phones;
- restore a database backup into a safe environment;
- review no tokens, OTPs, credentials, or personal data are logged or committed.

---

## 5. Launch blockers — do not skip

Moeen must not publicly launch with any of these unresolved:

1. Dashboard without staff authentication and authorization.
2. Development-only OTP instead of a secured real SMS workflow.
3. No provider vetting, support owner, or complaint/refund procedure.
4. No real-device Android test.
5. No payment/refund decision for the chosen launch categories.
6. No privacy/terms/warranty policy appropriate to the actual business.
7. No database backup/restore process.
8. No tested provider acceptance and dispatch process.

---

## 6. Immediate next six actions

1. Configure Android SDK and run the customer app on a real Android device.
2. Protect the dashboard with staff login, roles, and audit logging.
3. Replace development OTP with a Saudi SMS provider and production controls.
4. Run a small Buraidah provider-recruitment and manual dispatch pilot.
5. Add enforced job transitions, quote approval, and operational event history.
6. Start the separate Android provider app only after the provider workflow above is proven.

---

## 7. Definition of a successful first launch

The first Moeen launch is successful when it can repeatedly do this in Buraidah:

```text
Customer requests a service
→ a vetted provider accepts quickly
→ provider arrives within the promised window
→ customer understands and approves price where needed
→ service completes with evidence
→ payment/reconciliation succeeds
→ rating/support outcome is visible to operations
→ complaints are resolved within the stated policy
→ the completed job has positive repeatable unit economics
```
