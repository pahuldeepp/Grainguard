# Mobile (iOS) release readiness

Status as of 2026-09-26. Evidence: [STAGE_10E_RELEASE_BUILD.md](../evidence/STAGE_10E_RELEASE_BUILD.md). Native project: `apps/mobile/shell/ios`.

## Ready now

- **Privacy manifest** `GreenGuardMobile/PrivacyInfo.xcprivacy` in the target: no tracking, no collected data, required-reason APIs declared (file timestamp C617.1, system boot time 35F9.1, UserDefaults CA92.1). Pod manifests: React, folly, glog, boost, SocketRocket and async-storage ship their own; netinfo, keychain, safe-area-context and get-random-values ship none, and are covered by the app manifest. Re-check when any native dependency is bumped.
- **Launch screen**: brand green #0B5D36 (dark #062E1B, from the `LaunchBackground` colour set) with the GreenGuard wordmark; the default React Native splash is gone.
- **Info.plist**: iPhone only, portrait only (iPad was removed because the layout is a phone layout; enable it only after an iPad layout exists). Empty location permission string removed; no permission strings remain. `ITSAppUsesNonExemptEncryption=false` (HTTPS only). URL scheme `greenguard`, display name GreenGuard kept.
- **ATS**: exception only in `Info-Debug.plist`; Release uses `Info.plist` and the built Release .app has no ATS key.
- **Versioning**: `MARKETING_VERSION=1.0.0` (semantic); `CURRENT_PROJECT_VERSION` is the build number and must increase for each upload. Set it in CI, for example `xcodebuild ... CURRENT_PROJECT_VERSION=$GITHUB_RUN_NUMBER`.
- **Release build**: succeeds, Hermes bytecode bundle embedded, no demo modules in the bundle, no localhost strings, live endpoints empty in release.
- **Icon**: single 1024 universal icon builds with no asset-catalog warnings.

## Needs the owner

- Apple Developer Program team ID, signing certificates and provisioning profile; App ID `com.greenguard.mobile` registered; `DEVELOPMENT_TEAM` and signing style set; archive and TestFlight upload.
- Production Dex (OIDC) public PKCE client and production issuer URL, plus the production BFF URL. Today every live value is empty in release, so a Release build cannot sign in until a production config is injected (build-time configuration is a follow-up; it must not be committed with secrets).
- Redirect URI: `greenguard://auth/callback` must be registered with the production issuer; consider a Universal Link for production.
- Privacy policy URL, support URL, App Store metadata, screenshots, age rating, App Privacy answers (data not collected, matching the manifest), export compliance confirmation.
- Optional: dark and tinted icon variants (needs designed artwork), iPad layout, crash reporting choice.

## Findings to pass to the UI owner

- The Release build launched into an unchanging skeleton list when live mode is unconfigured (about 15 s observed). A release build with empty endpoints should show a clear "not configured" or sign-in state rather than an endless loading state.

## Optimisation candidates (bundle is about 1 MB minified, 78% react-native itself)

1. Drop `whatwg-fetch` (1%) if the Hermes runtime fetch suffices.
2. Confirm inline requires in `metro.config.js` (unverified) and keep the demo path behind `__DEV__` (already dead-stripped).
3. `regenerator-runtime` and `@babel/runtime` (about 1.7%): target modern syntax so fewer helpers are emitted.
4. Replace FlatList with a lighter list only if profiling shows a need; virtualized-lists is 6%.
5. Thin the shipped frameworks for device builds (simulator build is 49 MB with two architectures).
