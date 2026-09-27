# Stage 10e simulator validation, 2026-09-26

Local evidence, iPhone 17 simulator, iOS 27.0, Xcode 27.0, React Native 0.87.1 (`apps/mobile/shell`). Demo (fixture) data only: no Dex client, no BFF, no real sign-in.

## Verified by the coordinating session

| Check | Result |
| --- | --- |
| `npm test` in the core (`apps/mobile`) | 50 of 50 pass; prettier, root lint and typecheck clean |
| `npm test` in the shell | 5 of 5 pass (list, offline ack queues, drain on reconnect, tenant switch, sign-out then sign-in) |
| Simulator-SDK Debug build (agent) | BUILD SUCCEEDED |
| Launch on iPhone 17 | Alert list renders: Prairie Grain Co-op, four alerts (critical, high, medium, low), "Demo data" badge |
| Offline flow, driven by hand through the simulator | Simulate-offline on -> banner "You are offline" -> Acknowledge on the critical alert -> queue "1 pending", "Acknowledgement queued" -> offline off -> queue "0 pending", state "Acknowledged ... by demo-operator" |

## Not verified / not done

- Real sign-in (no Dex client registered; config empty), crypto polyfills for Hermes, URL scheme.
- Physical device, TestFlight, release signing, Android, VoiceOver/dynamic-type/contrast audit.
- Bundle id is still the template default `org.reactjs.native.example.GreenGuardMobile`.
- Release build not built (demo mode is designed to refuse a release build; not exercised).
- The shell's own `npm run lint` does not start (template ESLint config error); not fixed.
- One unexplained app restart during the first manual interaction (no new crash report was written; earlier crash reports at 02:15 predate the iOS 27 scene-lifecycle fix). Did not recur in the second run.
- Remote CI: none.
