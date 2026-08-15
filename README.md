# معين | Moeen

Arabic-first home-services marketplace MVP for Buraidah, Al-Qassim.

## Apps

- `apps/api` — NestJS API with customer sessions, staff sessions, RBAC, and audit events.
- `apps/admin-web` — Next.js Arabic RTL operations dashboard, protected by an HttpOnly staff-session cookie.
- `apps/mobile` — Flutter Arabic RTL customer app.

## Local prerequisites

Moeen uses its isolated PostgreSQL 16 database only:

```text
Host: localhost
Port: 5433
Database: moeen
```

**Do not use or change the Odoo PostgreSQL instance on port `5432`.** Verify the Moeen database first:

```bash
pg_isready -h localhost -p 5433 -d moeen
```

The expected result is `localhost:5433 - accepting connections`.

## Launch locally

### API

Create `apps/api/.env` from `.env.example` if it does not already exist, set the local database connection, and configure the first staff administrator locally (never commit this file):

```dotenv
MOEEN_INITIAL_ADMIN_EMAIL=admin@example.com
MOEEN_INITIAL_ADMIN_NAME=مدير معين
MOEEN_INITIAL_ADMIN_PASSWORD=use-a-strong-local-password
STAFF_SESSION_TTL_DAYS=7
```

Then migrate the database and start the API:

```bash
cd apps/api
npm run migrate:dev
npm run start:dev
```

The API repeats the same fail-closed migration check before it starts listening. A release artifact uses `npm run migrate` after `npm run build`. API runs at `http://localhost:3002`; categories are available at `http://localhost:3002/services`.

### Admin dashboard

Optional dashboard environment values are documented in `apps/admin-web/.env.example`. Do not put a staff token in any `NEXT_PUBLIC_*` variable.

```bash
cd apps/admin-web
npm run dev -- --port 3001
```

Open `http://localhost:3001`.

- Anonymous visitors are redirected to `/login`.
- The login action sends credentials server-to-server to the API.
- The opaque staff session is stored in an `HttpOnly`, `SameSite=Strict` cookie; browser JavaScript does not receive it.
- Dashboard areas follow the authenticated server role: `admin`, `dispatcher`, or `support_agent`.

### Mobile app

Flutter SDK is currently installed at `C:\Users\alaih\tools\flutter`.

```bash
cd apps/mobile
../../../tools/flutter/bin/flutter run
```

## Verification

```bash
cd apps/api && npm test -- --runInBand && npm run test:e2e -- --runInBand && npm run lint && npm run build
cd apps/admin-web && npm run lint && npm run build
cd apps/mobile && ../../../tools/flutter/bin/flutter analyze && ../../../tools/flutter/bin/flutter test
```

## Next feature

Implement one real vertical slice: customer OTP signup → address → service request with photos → dashboard dispatch → provider acceptance → completion and rating.
