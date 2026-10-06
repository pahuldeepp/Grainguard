# Stage 10e: iOS Release build evidence (2026-09-26)

Scope: native configuration in `apps/mobile/shell/ios`. Simulator only; no signing, archive, or device run.

## Commands and outcomes

1. Release build (separate derived data, git-ignored via `apps/mobile/shell/.gitignore`):
   `cd apps/mobile/shell/ios && xcodebuild -workspace GreenGuardMobile.xcworkspace -scheme GreenGuardMobile -sdk iphonesimulator -configuration Release -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO -derivedDataPath build-release build`
   Outcome: `** BUILD SUCCEEDED **`. No warnings from the app target and none from actool (asset catalog). The 357 warnings in the log come from the prebuilt React framework headers and the "script phase has no outputs" notice.
2. `plutil -lint` on Info.plist, Info-Debug.plist, PrivacyInfo.xcprivacy: all OK.
3. Built `.app` inspection (`plutil -p Info.plist`): `CFBundleIdentifier=com.greenguard.mobile`, `CFBundleDisplayName=GreenGuard`, `CFBundleShortVersionString=1.0.0`, `CFBundleVersion=1`, `UIDeviceFamily=[1]` (iPhone), portrait only, `UIRequiredDeviceCapabilities=[arm64]`, URL scheme `greenguard`, `ITSAppUsesNonExemptEncryption=false`. **No `NSAppTransportSecurity` key** (grep count 0, `NSAllowsLocalNetworking` count 0). Debug plist alone carries the 127.0.0.1/localhost exception.
4. Hermes: `main.jsbundle` is 1,429,714 bytes and starts with bytes `c6 1f bc 03` (Hermes bytecode magic), so the bundle is precompiled and embedded; Metro is not needed. `strings` finds no `127.0.0.1` in it.
5. Privacy: `PrivacyInfo.xcprivacy` copied into the .app; `React-cxxreact_privacy.bundle`, `React-timing_privacy.bundle`, `AsyncStorage_resources.bundle` (async-storage ships its own manifest) present. Prebuilt React.framework and ReactNativeDependencies (folly, glog, boost, SocketRocket) each ship manifests. netinfo, keychain, safe-area-context, get-random-values ship none and no flagged API use was found in their ios sources by grep.
6. Launch screen: compiled storyboard contains `LaunchBackground` and "GreenGuard", no "Powered by React Native"; `Assets.car` contains the `LaunchBackground` colour set (light #0B5D36, dark #062E1B) and AppIcon.
7. Simulator run: temporary simulator `gg-release-check` (iPhone 17, iOS 27.0) created, Release .app installed, launched, screenshotted, then deleted (`simctl list` count 0 afterwards). The app launched and stayed running (process listed by launchctl). Home-screen icon shows the GreenGuard name and icon. It rendered the skeleton loading list and did not change after ~15 s (see findings). Dark appearance launched too (near-black skeleton).
8. Demo gating: `src/services/index.ts` sets `DEMO_AVAILABLE = __DEV__`, `DEFAULT_MODE = __DEV__ ? 'demo' : 'live'`; `src/services/config.ts` empties every live endpoint when `!__DEV__`. Bundle proof: `react-native bundle --dev false --minify true` produced 579 modules with 0 modules under `src/demo/`, and the Release app started in live mode (no demo banner).
9. Bundle breakdown: `npx react-native bundle --platform ios --dev false --minify true --entry-file index.js --sourcemap-output ...` (JS 978,856 bytes minified), attributed per module through the sectioned source map with an ad-hoc node script:

| Share | Package |
|---|---|
| 77.6% (741 KB) | react-native |
| 6.0% (57 KB) | @react-native/virtualized-lists (FlatList) |
| 1.9% / 1.9% / 1.2% | app UI / tested core / screens |
| 1.0% | whatwg-fetch |
| 1.0% | @react-native-community/netinfo |
| 0.9% each | react, @babel/runtime |
| 0.7% | async-storage, regenerator-runtime, js-polyfills, normalize-colors |
| 0.5% | keychain |

App size on disk: `GreenGuardMobile.app` 49 MB (simulator, x86_64+arm64 frameworks, unstripped); bytecode 1.4 MB. Not representative of an App Store thinned size.

## Not run
- No archive, code signing, device build, TestFlight, or App Store validation (no Apple team available).
- Did not confirm Metro `inlineRequires` in `@react-native/metro-config` (grep of its sources returned nothing); relied on RN defaults, unverified.
- Did not capture a still of the launch storyboard itself (frames were too fast); verified by compiled contents instead.
- Dark/tinted icon variants not added (needs designed artwork; see readiness doc).
- Jest/typecheck not run (UI code is owned by another agent).
