# Working on BOSS

## Tests are part of behavior changes

Update the automated tests in the same change as the behavior they protect.
Do not leave test coverage for a later agent or PR.

- Changes to visible renderer behavior, window lifecycle, preload/IPC wiring,
  thread creation, backend/model defaults, delegation, permissions, or modal
  coverage must add or update a scenario in `e2e/`.
- Changes to pure logic still need a nearby `*.test.ts` unit test. Use both a
  unit test and an E2E scenario when a regression crosses process or UI
  boundaries.
- Run `npm run typecheck` and `npm test` before handing off a change.
- Do not run `npm run test:e2e` locally unless the user explicitly requests a
  local E2E run in the current thread. CI owns Electron E2E execution; still
  add or update the required E2E scenarios in the same change.
- Keep E2E tests deterministic. Extend `src/preload/e2e.ts` instead of using
  real agent credentials, network services, or the user's BOSS data.
- Never launch a development or test instance against the default BOSS
  profile. The Playwright fixture supplies a unique temporary profile and the
  app keeps its E2E window hidden unless `npm run test:e2e:headed` is used.
- Prefer role, label, placeholder, and stable structural selectors. Avoid
  pixel coordinates and sleeps. Failed runs must remain diagnosable from the
  Playwright trace, screenshot, renderer errors, and Electron stderr uploaded
  by CI.

When a behavior intentionally changes, update the existing assertion to state
the new contract. Do not weaken or delete a failing scenario merely to make CI
green.
