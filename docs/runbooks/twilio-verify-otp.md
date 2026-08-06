# Twilio Verify OTP runbook

## Scope

Moeen customer sign-in uses **Twilio Verify**, not a Twilio Messaging Service. Verify creates and checks OTPs through the API; the application never creates, logs, or returns an OTP.

## One-time Twilio setup

1. In Twilio Console, create a Verify Service named `Moeen Customer OTP`.
2. Create a **Standard API Key** for the API.
3. Keep the API Key SID, API Secret, and Verify Service SID only in the API secret store or ignored `apps/api/.env` file.
4. Do not configure Messaging Service inbound webhooks, Conversations, queue settings, or delivery-status callbacks for this Verify flow.

## Required local variables

```dotenv
OTP_PROVIDER=twilio_verify
TWILIO_API_KEY=[REDACTED]
TWILIO_API_SECRET=[REDACTED]
TWILIO_VERIFY_SERVICE_SID=[REDACTED]
```

Do not commit these values, add them to `.env.example`, use `NEXT_PUBLIC_*`, or paste them into chat.

## Controlled Saudi delivery test

1. Restart the API after saving the variables.
2. Open the Android debug build on the real test device connected to the configured API origin.
3. Enter a real Saudi number in canonical format: `+9665XXXXXXXX`.
4. Request the code once. The API must return only an opaque `challengeId`, never an OTP.
5. Confirm the SMS arrives on the phone, then submit its code.
6. Confirm the application reaches the authenticated booking flow.
7. Check Twilio Verify logs for the same verification and final `approved` status. Do not copy SMS content, OTPs, or identifiers into tickets/chat.

## Safety controls implemented

- Saudi mobile-number validation.
- Arabic Verify locale and SMS channel.
- 60-second resend cooldown.
- Five requests per phone per hour.
- Ten-minute PostgreSQL-backed challenge lifetime.
- Five failed verification attempts per challenge, persisted atomically in PostgreSQL.
- PostgreSQL-backed cooldown and hourly request cap, serialized per phone to work across API restarts and instances.
- An approved challenge is consumed atomically, so it can issue only one customer session.
- Customer session issuance only after Verify reports `approved`.
- Provider and transport failures map to a safe unavailable response rather than leaking details.

## Launch constraints

The current cooldown, hourly request counter, and opaque challenge state are process-local. They are suitable only for the single local pilot API process. Before multi-instance deployment or public launch, move OTP challenge and rate-limit state to PostgreSQL or Redis with atomic rate-limit operations.

A Twilio Verify account is not accepted for Saudi launch until a real Saudi-device test successfully receives and approves an SMS. If deliverability or Sender ID is unsuitable, evaluate a Saudi-focused SMS provider before launch.
