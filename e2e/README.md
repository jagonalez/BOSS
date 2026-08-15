# Electron E2E tests

These tests launch the production Electron bundles and interact with the real
renderer through Playwright. `BOSS_E2E=1` replaces external services at the
preload boundary with `src/preload/e2e.ts`; React, localStorage, window
lifecycle, context isolation, and user interactions remain real.

```sh
npm run test:e2e          # hidden window, same mode as CI
npm run test:e2e:headed   # visible window for local debugging
```

Every test receives a unique temporary `userData` directory. The fixture
deletes only that directory after closing Electron. It never reads or writes
the installed app's BOSS profile and never invokes a real coding agent.

On failure, CI uploads Playwright traces and screenshots together with
renderer errors and Electron stderr. Open a trace with:

```sh
npx playwright show-trace test-results/**/trace.zip
```
