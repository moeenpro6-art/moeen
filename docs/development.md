# Local development

## Services

Moeen uses PostgreSQL 16 on `localhost:5433` with database `moeen`.

```bash
pg_isready -h localhost -p 5433 -d moeen
```

Do not connect project migrations or tests to the Odoo PostgreSQL service on port `5432`.

Start the API:

```bash
cd apps/api
npm run start:dev
```

Start the protected dashboard in a separate terminal:

```bash
cd apps/admin-web
npm run dev -- --port 3001
```

Open `http://localhost:3001`. An anonymous visitor should land at `/login`.

## Physical Android device

The Flutter app has no hard-coded development server. Pass a reachable API origin at run or build time. `localhost` and `10.0.2.2` do **not** reach the development computer from a physical phone.

1. Start the API and connect the phone and computer to the same private Wi-Fi network.
2. Use `ipconfig` to obtain the computer's active Wi-Fi IPv4 address.
3. Permit port `3002` on the Windows **Private** firewall profile if prompted.
4. Run or build with that address:

```bash
../../../tools/flutter/bin/flutter run \
  --dart-define=MOEEN_API_BASE_URL=http://YOUR-LAN-IP:3002

../../../tools/flutter/bin/flutter build apk --debug \
  --dart-define=MOEEN_API_BASE_URL=http://YOUR-LAN-IP:3002
```

For a production build, `MOEEN_API_BASE_URL` must be the deployed HTTPS API origin. The Android release manifest does not allow cleartext HTTP.

## Verification

```bash
cd apps/api
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm run lint
npm run build

cd ../admin-web
npx tsx --test src/app/*.test.ts src/app/auth/*.test.ts src/app/login/*.test.ts
npm run lint
npm run build

cd ../mobile
../../../tools/flutter/bin/flutter test
../../../tools/flutter/bin/flutter analyze
```
