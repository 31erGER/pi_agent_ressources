# language-checker

Live English spelling checker for the pi TUI input editor.

While typing, words that are not in the bundled dictionary are underlined in
red. No corrections, no suggestions — visual feedback only.

## Usage

The checker is **ON by default**: on every session start it wraps the
currently installed editor (whatever that is — default or another
extension's custom editor).

Type `/spelling` in the pi input to toggle it for the current session:

- `/spelling` while ON — turns it **off** and restores the previous editor
  factory exactly as captured.
- `/spelling` while OFF — turns it **on** again (wraps the current editor).

State is in-memory only: an explicit `/spelling` choice persists across
session switches (resume/fork) within the process; after a process restart
the default (ON) applies again.

Default enable is silent (no notification) — the red underlines are the
visible feedback.

## Files

| File | Purpose |
| --- | --- |
| `index.ts` | Extension entry: installs the wrapper on `session_start` (default ON; deferred by one macrotask so it wraps the LAST installed editor — extension handlers run in alphabetical order, so a synchronous install would be clobbered by `session-name-border`), registers `/spelling`, captures/restores the editor factory. |
| `editor.ts` | `SpellingEditor` — a `CustomEditor` wrapper that delegates all interaction to an inner editor and re-styles its rendered lines. |
| `highlight.ts` | `styleLine()` — SGR-aware line restyler; wraps misspelled words in `\x1b[31;4m…<fg-restore>\x1b[24m` and preserves every other byte of the line (visible text is never changed). |
| `spell.ts` | `checkWord()` / `loadDictionary()` / `IGNORE_WORDS` — the dictionary + heuristics (digits, apostrophes, ALL-CAPS, inner caps, trailing-s plural). |
| `en-words.txt` | Bundled word list (copy of `/usr/share/dict/american-english`, ~104k words). Loaded once into a `Set` at runtime; no network, no npm deps. |

## Why a wrapper, not a reimplementation

pi wires `onSubmit`/`onChange` by property assignment *after* the editor
factory returns, copies app shortcuts through the `actionHandlers` Map, and
duck-types `onEscape`/`onCtrlD`/`onPasteImage`/`onExtensionShortcut` on the
custom editor. `SpellingEditor` mirrors all of that onto a real inner
`CustomEditor`, so typing, paste, history, autocomplete, escape, Ctrl-D and
other extensions' editor customizations (e.g. `session-name-border`) keep
working unchanged. The wrapper only intercepts `render(width)`.

## Tests & typecheck

```sh
# unit + runtime smoke tests (Node ≥22 native type-stripping, no runner config)
node --test /home/julian/.pi/agent/projects/language-checker/test/

# all user extensions still load under pi's jiti alias map
node /home/julian/.pi/agent/bin/pi-ext-loadtest.mjs

# typecheck (typescript 5.9.2 pinned; newer tsc rejects the config's paths style)
npx -y -p typescript@5.9.2 tsc -p /home/julian/.pi/agent/projects/language-checker/test/tsconfig.json
```

Test suite: `test/spell.test.ts` (dictionary contract), `test/highlight.test.ts`
(`styleLine` SGR/cursor contract), `test/smoke.test.ts` (full pi wiring
sequence against the real `CustomEditor` class), `test/index.test.ts`
(default-ON install order vs a later extension, `/spelling` toggle
round-trip, opt-out persistence across simulated session switches, fresh
module = restart default).

## Cursor handling (implementation detail)

The editor renders the cursor cell as
`[CURSOR_MARKER] FAKE_CURSOR_START grapheme FAKE_CURSOR_END` (pi-tui,
release 1.5.2). When the grapheme under the cursor is a letter the word is
split across that span, so fragments touching the span are skipped; on a
word boundary the adjacent words are intact and get styled normally.

