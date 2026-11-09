# confirmation-dialog project

Tests + docs for the `confirmation-dialog` pi extension and its new bell
integration with `notify-on-settle`.

The actual extensions live in `~/.pi/agent/extensions/`:

- `confirmation-dialog.ts` — gates mutating git / recursive `rm` commands
  behind a confirm dialog. **New:** rings the notification bell the moment
  the dialog pops up (via `chime()` imported from `notify-on-settle.ts`).
- `notify-on-settle.ts` — rings the bell when the agent settles. **New:**
  exports `chime()` (shared bell, one chime at a time), moved stats
  tracking into it (one run per chime), added a spawn `error` handler so a
  missing ffplay can never crash pi.

Dependency note: `confirmation-dialog.ts` statically imports
`notify-on-settle.ts`. If that file is deleted or broken, the confirmation
gate will not load (pi logs the extension error and continues) — so keep
`notify-on-settle.ts` in place.

## Run the tests

```sh
npm test
```

(= `node --test test/`, needs Node >= 23.6 for native TS type-stripping;
the suite is silent — a spy bell replaces the real chime, no ffplay/sound.)
