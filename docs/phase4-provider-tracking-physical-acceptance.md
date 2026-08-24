# Phase 4 — Provider Android Tracking Client

## Final Physical Android Acceptance Report

Date: 2026-08-24
Worktree: `t_location_p4`
Branch: `moeen/location-p4`

## Verdict

**FINAL PASS**

Phase 4 Provider Android Tracking Client has completed automated verification, independent review, and real-device Physical Android Acceptance.

## Automated Verification

| Verification | Result |
|---|---:|
| Full provider-mobile suite | 131 tests PASS |
| `flutter analyze` | PASS |
| Dart format check | PASS |
| `git diff --check` | PASS |
| `provider_tracking.dart` coverage | Previously verified above the required threshold |
| Independent review findings | No blocking findings |

## Physical Acceptance

### Foreground tracking

**PASS.** Tracking starts only after trusted server authority is available.

### Home / background

**PASS.** The Android location foreground service remains active after leaving the app.

### Screen-off

**PASS.** Tracking continues while the screen is off.

### Network loss / recovery

**PASS.** Tracking fails closed while current trusted server authority cannot be obtained and resumes after connectivity recovery without catch-up bursts.

### Force Stop / manual recovery

**PASS.** Android Force Stop terminates tracking. Tracking does not self-resurrect and resumes only after manual application launch and fresh server-authority reconciliation.

### Location permission revoke / restore

**PASS.** Revoking location permission stops tracking. Re-granting permission and manually opening the application restores tracking only through the trusted authority path.

### Multiple active requests

**PASS.** More than one active tracking authority fails closed. The client does not arbitrarily select a request.

### Server authority removal

**PASS.** Removing tracking authority from the server stops the foreground tracking runtime and prevents continued location submission.

### Foreground Service

**PASS.** Observed Android service:

- `flutter_foreground_task` `ForegroundService`
- `startForegroundCount=1`
- `isForeground=true`
- `foregroundServiceType=location (0x00000008)`

### Privacy

**PASS.**

- No persistent coordinate queue.
- No coordinate values observed in application logcat.
- No FCM authority.
- No `ACCESS_BACKGROUND_LOCATION` introduced.

## Cadence Physical Finding and Remediation

Initial physical testing reproduced recurring approximately 30-second gaps while the server-controlled `on_the_way` cadence was 15 seconds.

### Root cause

The Android Geolocator source requested a 15-second interval while `ProviderTrackingCadenceGate` independently enforced an exact 15,000 ms boundary. Normal Android scheduler jitter could deliver an event slightly early, for example at 14,950 ms, causing the gate to reject it and wait for the next source event around 30 seconds.

### Remediation

A bounded one-second source-scheduler jitter allowance was added for unchanged request/cadence authority. Strict handling remains in place across authority, cadence, and status changes, and no catch-up behavior was introduced. Automated regression coverage was added for this boundary condition.

## Final Physical Cadence Re-test

The clean real-device re-test recorded the following accepted-sample timing results:

| Measure | Result |
|---|---:|
| Start sample ID | 211 |
| Server cadence | 15,000 ms |
| Average accepted sample gap | 15.999 s |
| P95 gap | 21.141 s |
| Maximum observed gap | 28.031 s |
| Recurring 29–31 second pattern | Eliminated |
| Catch-up bursts | Not observed |
| Tracking during test | Remained operational |

The remaining occasional longer GPS interval is consistent with Android/GPS best-effort scheduling and does not form the previous systematic 30-second skip pattern.

## Final Decision

**Phase 4 Physical Android Acceptance: PASS**

Phase 4 is approved for commit, push, pull request, final independent review, and merge only if that review returns `VERDICT: APPROVED` with no blocking findings.

No deployment is authorized by this report.
