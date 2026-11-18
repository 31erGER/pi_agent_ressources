
### 2026-11-16 21:16 · PLAN
- Did: Created .pi/PROJECT_MAP.md, .pi/PLAN.md (8 steps, TDD order) for language-checker extension; no previous plan/log existed.
- Baseline: .pi/baseline/2026-11-16_2114/ (empty — all plan files are NEW, nothing pre-existed to snapshot)
- Feasibility confirmed via recon: setEditorComponent/getEditorComponent + CustomEditor render-override (modal-editor.ts example) + Editor.getText/onChange + registerCommand + CURSOR_MARKER handling.
- Key risk found: session-name-border.ts also calls setEditorComponent on session_start (runs after us alphabetically) → install only on /spelling toggle, wrapping captured previous factory.
