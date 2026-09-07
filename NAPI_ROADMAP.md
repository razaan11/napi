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
| 1 | Guide mode: intercept action, show step, spotlight element | DONE except the `mode` toggle |
| 2 | Pause & wait, detect the user's action | PARTIAL — URL-change detection works; non-navigation click detection missing |
| 3 | The Checker (verification) | NOT STARTED |
| 4 | Skill Map | NOT STARTED |
| 5 | Recovery | NOT STARTED |
| 6 | Missions for one flagship tool | NOT STARTED |
| UI | Side panel redesign | NOT STARTED |
| 7 | Polish + first users | NOT STARTED |

---

## Stage 2 (finish) — reliable step-completion detection

**Goal:** know the user completed the step for ALL step types, not just navigations.

**Tasks:**
- Content-script listener on the spotlighted element (`pages/content/src/`). On the user's real
  click (or keypress in a target field), post a message to the background worker.
- Background message handler in `chrome-extension/src/background/index.ts`; route it to the waiting
  Navigator (e.g. via an event on `AgentContext`, or a shared promise/emitter).
- `waitForUserStep()` in `navigator.ts` resolves on the FIRST of:
  - URL change (already implemented)
  - "user clicked the spotlighted element" message
  - target input's value matches the expected text (for type steps)
  - a meaningful DOM change near the target
  Keep the 2-minute timeout and the `paused/stopped` checks.

**Done when:** guiding a multi-step in-page flow (open a dropdown -> pick an item -> confirm)
advances on each real user action without timing out.

---

## Stage 1 (finish) — make `mode` a real setting

**Goal:** remove the hardcoded `const GUIDE_MODE = true`; support `auto` vs `guide`, user-selectable,
no rebuild needed.

**Tasks:**
- `packages/storage` general settings (`generalSettingsStore`): add `mode: 'auto' | 'guide'`
  (default `'auto'`).
- `pages/options`: add a toggle/select in the settings UI.
- `chrome-extension/src/background/index.ts` -> `setupExecutor()`: read the setting; pass it into
  `agentOptions`. When `mode === 'guide'`, also set `maxActionsPerStep: 1`.
- `navigator.ts`: replace `const GUIDE_MODE = true` with
  `const guideMode = this.context.options.mode === 'guide'` (and rename usages).

**Done when:** toggling the setting switches between original Nanobrowser auto behaviour and guide
behaviour.

---

## Stage 3 — the Checker (verification)

**Goal:** confirm the user's action produced the correct outcome. This is napi's core
differentiator; treat it as the highest-risk piece.

**Design — 3 tiers, tried in order:**
- **Tier 2 (build first):** after `waitForUserStep`, compare current URL + presence/absence of key
  DOM elements against the step's `expected` spec. Reuse `browserContext.getState()`.
- **Tier 3:** screenshot -> vision-capable model -> "does this show X?". Low confidence; never block
  on this alone. (Kira vision models exist but need wallet balance.)
- **Tier 1 (per flagship tool):** call the tool's own API to confirm real state (needs OAuth to the
  flagship). Add when a flagship is chosen (Stage 6).

**Data model:** each step template needs an `expected` field (URL pattern, required/forbidden
elements, optional API check).

**Suggested module:** `chrome-extension/src/background/agent/checker/` exporting
`verifyStep(step, context): Promise<{ verified: boolean; actual; expected; delta }>`.

**On fail:** do NOT advance the loop; pass the `delta` to Recovery (Stage 5).

**Done when:** doing the wrong action is caught reliably (>90%) and the right action passes, on the
first flagship tool. THIS IS THE GO/NO-GO GATE for the whole project — if it can't hit ~90% even on a
tool with an API, the "we verified you can do this" premise needs rethinking.

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
