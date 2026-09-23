# dashboard (React 19, Vite, Vitest)

- Test: `npm test -w apps/dashboard` · Coverage: `npm run coverage -w apps/dashboard`.
- `src/main.tsx` only mounts; UI lives in `src/App.tsx`. Component tests use `// @vitest-environment jsdom`, React `act`, and fake timers for polling.
- Readiness polling uses `checkHealth` with abort + 3 s timeout, every 5 s. Unmount must abort and stop polling (tested).
- Later screens (Stage 08) read through the BFF only and must show observed vs projected time; see `docs/FIRST_VERTICAL_SLICE.md` section 5D.
