# napi — Roadmap (remaining work)

Read `NAPI_DEV_NOTES.md` first for current state and code changes. This file is the
plan for everything still to build.

Scope right now = **Phase 1 (online, web apps only)**. Phase 2 (offline/desktop) is
listed at the end and is NOT in scope yet.

---

## Status snapshot

| Stage | What | Status |
|---|---|---|
| 0 | Setup + understand the codebase | DONE |
| 1 | Guide mode: intercept action, show step, spotlight element, auto/guide toggle | DONE — `guideMode` setting in General Settings; verified ON guides / OFF auto-runs |
| 2 | Pause & wait, detect the user's action | DONE — URL-change + trusted-click + typing/value-match detection + no-target "task complete" handling, all committed + verified. Optional refinements left: generic DOM-change detection; guiding manual `go_to_url` instead of auto-navigating |
| 3 | The Checker (verification) | Tier 2 DONE (commit `38e4a27`); Tiers 1 + 3, per-step `expected` spec, and calibration still to do |
| 4 | Skill Map | NOT STARTED |
| 5 | Recovery | NOT STARTED |
| 6 | Missions for one flagship tool | NOT STARTED |
| UI | Side panel redesign | NOT STARTED |
| 7 | Polish + first users | NOT STARTED |

---

## Stage 2 — reliable step-completion detection  **[DONE]**

**Goal:** know the user completed the step for ALL step types, not just navigations.

**DONE + committed + verified:**
- URL-change detection (`waitForUserStep()` polling).
- Trusted-click detection on the spotlighted element, no URL change needed. Mechanism:
  `guideStepId` (`crypto.randomUUID()`) -> `data-napi-guide-target` marker added by `buildDomTree`
  -> `guide_watch_target` broadcast to all frames -> content script one-shot capturing listener,
  `event.isTrusted` only -> `guide_target_clicked` -> `notifyGuideStepClick` resolves the pending
  waiter -> `waitForUserStep()` races click vs URL. File `chrome-extension/src/background/guide-step.ts`.
  Verified: W3Schools dropdown, "Open the dropdown menu." advances on the in-page click.
- **Typing / value-match detection** (fix B, commit `e66a93e`). For an `input_text` step,
  `watchGuideStepTarget(tabId, stepId, { mode: 'value', expectedText })`; the content script attaches
  an `input` listener and sends `guide_target_matched` when `el.value` (trimmed, lower-cased) equals
  the expected text; background resolves the same waiter. Verified: google.com, "Type \"hello world\"
  in the search box." advances when the text matches.
- **No-target "task complete" handling** (fix A, commit `31ca4a8`). The guide branch now checks
  `isUserStep` (does the action have a target element index). If not (`done`, `wait`, agent
  navigation) it runs the action via `doMultiAction` instead of guide-waiting — so `done` finishes
  the task instead of hanging 2 minutes. Verified.

**Optional refinements (not blocking; do later if a real mission needs them):**
- **Generic local DOM-change** detection for controls where a click alone isn't the completion signal
  (e.g. an expander whose `aria-expanded` flips on a different node). Add a `mode: 'dom'` with a
  MutationObserver near the target.
- **`go_to_url`** currently runs via fix A (the extension navigates for the user). For a true
  guide-only experience, detect `go_to_url` and instead show "navigate to X yourself" + wait for the
  URL change.
- Cosmetic: `waitForUserStep` logs "user clicked the spotlighted element" even on a value match.

---

## Stage 1 (finish) — make `mode` a real setting  **[DONE — commit `76b0630`]**

Replaced the hardcoded `const GUIDE_MODE = true` with a real `guideMode: boolean` setting
(default `false` = original Nanobrowser auto behaviour). Files:
- `packages/storage/lib/settings/generalSettings.ts` — `guideMode` in `GeneralSettingsConfig` + defaults.
- `chrome-extension/src/background/agent/types.ts` — `guideMode` in `AgentOptions` + `DEFAULT_AGENT_OPTIONS`.
- `chrome-extension/src/background/index.ts` `setupExecutor()` — passes `guideMode` into `agentOptions`;
  forces `maxActionsPerStep: 1` when guide mode is on.
- `chrome-extension/src/background/agent/agents/navigator.ts` — `if (this.context.options.guideMode)`.
- `pages/options/src/components/GeneralSettings.tsx` — a **Guide mode** toggle (plain strings, no i18n key).

Verified: toggle OFF -> extension types/acts itself; toggle ON -> guides the user step by step.
Reload the side panel after changing the toggle so it re-reads the setting.

---

## Stage 3 — the Checker (verification)

**Goal:** confirm the user's action produced the correct outcome. napi's core differentiator; the
highest-risk piece.

### Tier 2 — structural check  **[DONE — commit `38e4a27`]**

File: `chrome-extension/src/background/agent/checker.ts` — pure functions `verifyStep(...)` and
`stepSignature(state)`. Called from the guide branch of `navigator.ts` after `waitForUserStep`:
- captures a "before" fingerprint from `currentState` (already fetched at the top of `execute()`);
- fetches an "after" state via `browserContext.getState(false)`;
- verdict: timeout -> NOT verified; `input_text` (value already matched) -> verified; URL changed ->
  verified; `stepSignature` (URL + interactive-element count) changed -> verified; a click with no
  detectable change -> NOT verified.
- verified -> emit `STEP_OK ✅ Done: <goal>`, reset `context.consecutiveFailures`, advance.
- not verified -> emit `STEP_FAIL ⚠️ ...`, push a "ask the user to try this step again" result into
  memory so the Planner re-issues it; on a timeout also bump `context.consecutiveFailures` (3 in a
  row ends the task via the existing failure limit).

Deliberately conservative: only two hard fails (timeout, dead click). Calibrate the thresholds once
there are real missions to test against.

### Tier 3 — vision fallback  **[not built]**

Screenshot -> vision-capable model -> "does this show X?". Low confidence; only as a tie-breaker,
never block on it alone. Kira has cheap vision models but they need wallet balance.

### Tier 1 — tool API  **[not built; needs a flagship]**

Call the flagship tool's own API to confirm real state (needs OAuth). Add in Stage 6 when a flagship
is chosen. Slot it in ahead of Tier 2 inside `verifyStep` (or a wrapper) — keep the
`{ verified, reason }` shape.

### Still to do for Stage 3

- A per-step `expected` spec (URL pattern / required + forbidden elements) so verification is
  "did the RIGHT thing happen", not just "did something change". Comes with mission templates (Stage 6).
- Wire the "not verified" path into Recovery (Stage 5) instead of just re-issuing the step.
- Calibrate / measure: on the first flagship tool, is it >~90% correct (catches wrong actions,
  passes right ones)? **This is the GO/NO-GO gate.** If it can't hit ~90% on a tool with an API,
  the "we verified you can do this" premise needs rethinking.

---

## Stage 4 — the Skill Map

**Goal:** persist what the user can actually do, per tool.

**Tasks:**
- Schema: `tool -> skillNode -> { status: 'not-started' | 'guided' | 'unaided' | 'rusty',
  verifiedCount, lastVerifiedAt }`.
- New store in `packages/storage` backed by `chrome.storage.local` (or IndexedDB for larger data).
- Update rules:
  - after a guided mission, mark touched skills `guided`.
  - mark `unaided` ONLY after the end-of-mission no-hints challenge passes the Checker.
  - a decay pass flips `unaided` -> `rusty` after N days unused.
- Minimal render in the side panel (list or tree).

**Done when:** completing a mission updates the map and it survives an extension restart.

---

## Stage 5 — Recovery

**Goal:** when the user goes off-track, diagnose the real state and guide them back calmly.

**Tasks:**
- When the Checker returns a `delta`, send actual-vs-expected to the Planner LLM:
  "what happened, and how to get back to the last good checkpoint."
- Pre-author recovery text for the top ~5 known wrong turns per step (fast path, no LLM call).
- Present calmly in the panel. Never say "that's wrong" — describe where the user is and the way back.

**Done when:** a wrong turn during a mission produces a helpful redirect, not a dead end.

---

## Stage 6 — Missions for one flagship tool

**Goal:** real, hand-authored lessons for ONE web app.

**Tasks:**
- Pick the flagship. Recommended: **Notion** (has a public API for Tier 1 checking; large beginner
  audience).
- Mission/step template format:
  `{ instruction, targetDescriptor, why, verification: expected, knownWrongStates: [{ match, recoveryText }] }`.
- Author 3-5 missions (Notion example: create a page, create a database, add a view, share a page,
  use a template).
- Each mission ends with an **unaided challenge**, verified by the Checker.
- Add OAuth to the flagship for Tier 1 checks (read-mostly scopes).
- Mission planner: an LLM maps a user goal to a mission and orders the step templates, checking the
  Skill Map to skip already-mastered skills. The LLM chooses the path; it does NOT invent
  verification logic.

**Done when:** 3-5 missions run start to finish reliably, including the unaided challenge and the
skill-map update.

---

## UI stage — side panel redesign

**Goal:** make the panel feel like a tutor, not a chat log. Do this AFTER Stage 3 so the data shape
is known.

**Tasks (`pages/side-panel/src/`):**
- Current-step card: large instruction, the target's name, a "Why?" expander.
- Progress indicator: "Step 3 of 7".
- States: "waiting for you...", verified check, recovery message.
- Skill Map view (its own tab).
- New event types from the background: `SHOW_STEP`, `STEP_VERIFIED`, `SHOW_RECOVERY`,
  `SKILL_UPDATED`. Keep the existing port plumbing; change what renders.

**Done when:** a first-time user understands what to do without reading a chat transcript.

---

## Stage 7 — polish + first users

- Onboarding: paste a model key (or bundle a limited one), pick a goal.
- Graceful model-error handling, retries, clear messages, no dead ends.
- Package the extension; write a one-page install guide.
- Give it to 5-10 beginners; watch them use it; log every place it breaks or confuses.

**Done when:** a stranger can install it and finish a mission unaided.

---

## MVP definition of done (Phase 1)

- `mode` toggle works (auto / guide).
- Guide loop: intercept -> show step -> spotlight -> wait -> detect (any step type) -> verify ->
  explain -> next.
- Checker reliable (>90%) on the flagship tool.
- Skill Map persists; distinguishes guided vs unaided.
- Recovery handles common wrong turns.
- 3-5 missions for one flagship, each with an unaided challenge.
- Redesigned side panel.
- 5-10 real users have completed a mission.

---

## Milestone gates (do not skip)

| After | Must be true |
|---|---|
| Stage 2 finish | Guide loop advances correctly for in-page (non-navigation) steps |
| Stage 3 | Verification is reliable (~90%+) on the flagship. **Go / no-go for the whole idea.** |
| Stage 6 | 3-5 missions work end to end, including the unaided challenge |
| Stage 7 | A new user installs and completes a mission unaided |

---

## Phase 2 (LATER — not in scope now)

Offline / desktop apps (VS Code, Docker). A separate build, started only after Phase 1 is built and
validated:

- Fork **UI-TARS Desktop** for the desktop engine; apply the same "guide mode" change (show + wait,
  don't act).
- Screen reading via OS accessibility APIs + **OmniParser** for elements the OS can't expose.
  Needs a real GPU or a paid vision endpoint.
- Reuse the Checker, Skill Map, Missions, and Recovery from Phase 1 unchanged.
