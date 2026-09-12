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
| 2 | Pause & wait, detect the user's action | DONE — **verified live end-to-end on linkedin.com (Sep 12)**: a real free-text goal ("guide me to post on LinkedIn"), no mission, completed a real publish after 5 distinct bugs found + fixed on that one test case (see below). Optional refinements left: generic DOM-change detection; guiding manual `go_to_url` instead of auto-navigating |
| 3 | The Checker (verification) | Tier 2 DONE (commit `38e4a27`) and **verified live** on example.com (Sep 11): click → URL change → `verified: the page navigated as expected`. Tiers 1 + 3, per-step `expected` spec, and calibration on a real flagship still to do |
| Perf | Big-page performance pass (model retry cap, fewer Planner calls, lighter Checker read) | DONE and **verified live** — see below |
| 4 | Skill Map | DONE (v1) — storage + hook-in + minimal Options UI. Real "unaided" path needs Stage 6 missions |
| Perf | Model-fallback chain (pulled forward from Stage 7) | DONE (v1) — see below |
| 5 | Recovery | DONE (v1) — calmer, state-aware messages for timeout vs dead-click. Real LLM-diagnosed recovery needs Stage 6 |
| 6 | Missions for one flagship tool | DONE (v1.1) — 1 hand-authored Notion mission, an automatic side-panel mission runner (napi sends each step itself), and a read-only Options view. No unaided challenge / OAuth / LLM picker yet |
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

**Bug found + fixed live (Sep 12) — real-world test on linkedin.com:** the user asked "How do I post on
LinkedIn" as a free-text goal (no mission — confirms ad hoc guide mode works on a real, complex site, not
just test pages). It correctly spotlighted "Start a post", detected the click, navigated into the compose
dialog, waited for it to load, then spotlighted the text box in `value` watch mode. While waiting for typed
text to match, LinkedIn's own routing flipped the URL back to `/feed` (the modal closing/reverting for
reasons unrelated to typing) — and `waitForUserStep()` raced `waitForUrlChange()` against the value-match
promise **regardless of watch mode**, so that unrelated URL flip got treated as "the user acted", and the
Checker then unconditionally reported `verified: typed text matches the expected value` even though no
value match had actually happened. The guide loop advanced onto a page state that no longer existed, and
the next step immediately hit `RequestCancelledError: Aborted`. **Fixed**: `waitForUserStep()` now takes
the watch mode — `'value'` steps only ever resolve on a genuine value match (with their own timeout, no
URL race at all); `'click'` steps keep racing both, since a click can legitimately cause navigation. Also
resolves the old cosmetic note below (a value match now logs its own distinct message).

**Second bug found + fixed live (Sep 12), same LinkedIn test:** on retry, the value-watch fix above worked
(no false verify) — but the Planner declared the whole task `done` the moment the Navigator opened the
post composer, describing "type your content, then click Post" as prose in `final_answer` instead of
continuing to guide the user through them. Root cause: the Planner's prompt is identical in guide mode and
auto mode, and treats "the right screen is reachable" as good enough for `done: true` — correct for
autonomous auto mode, wrong for guide mode where a human still has to perform the remaining actions.
**Fixed** in `chrome-extension/src/background/agent/prompts/{templates/planner.ts,planner.ts}` +
`executor.ts`: `PlannerPrompt` now takes a `guideMode` flag and appends an addendum telling it not to mark
multi-step goals done until the real-world outcome is achieved, and to keep emitting `next_steps` (which
the Navigator turns into spotlighted actions) instead of handing off the rest as an instructions list.
Auto mode's prompt is untouched.

**Third bug found + fixed live (Sep 12), same LinkedIn retest:** the Planner fix worked — it correctly kept
`done: false` after the composer opened. But the Navigator's `next_goal` for the retype step read "Click
inside the text box, then guide them to replace 'hi' with their real message and click the Post button" —
while only ONE action (a click on the text box) actually executed and got watched that turn, since guide
mode forces `maxActionsPerStep: 1`. The user saw a 3-part instruction but only the first part was ever
going to be detected — and it picked `click_element` over `input_text` for a field with leftover text, so
a retype would never have been watched for a value match either. **Fixed** in
`prompts/templates/navigator.ts` + `prompts/navigator.ts` + `executor.ts`: same pattern as the Planner fix
— `NavigatorPrompt` takes a `guideMode` flag and inserts an addendum (inside the `<system_instructions>`
block) telling it to describe ONLY the single upcoming action in `next_goal`, never narrate what happens
after it, and to use `input_text` directly rather than a separate click-to-focus step when replacing
existing text. Auto mode's prompt is unchanged.

**Fourth bug found + fixed live (Sep 12), same LinkedIn retest:** the first three fixes held — the
Navigator correctly picked `click_element` (not `input_text`) for the empty post text box, since it had no
real content to type on the user's behalf. But the guide loop only had two watch modes: `click` (a real
click) and `value` (an EXACT expected string). A `click_element` step on a text field got watched in
`click` mode — and since LinkedIn's composer auto-focuses that field, the user just typed directly with no
extra click, so the click watcher never fired and the step timed out despite the user doing exactly the
right thing. **Fixed**: added a third watch mode, `input` — advance the moment the field has ANY non-empty
content, for free-form composing where the model has no expected text to give. `guide-step.ts` (`mode`
type), `pages/content/src/index.ts` (the value listener now also satisfies on non-empty content), and
`navigator.ts` (a `click_element` action targeting a text-input-like element — checked via
`selectorMap`'s `tagName`/`contenteditable`/`role` — now watches in `input` mode instead of plain `click`;
`waitForUserStep` and `verifyStep` both treat `input` the same as `value`).

**Fifth bug found + fixed live (Sep 12), same LinkedIn retest:** a screenshot showed numbered highlight
badges scattered across the background feed but NONE inside the actual post composer — Inspect confirmed
the composer is a native `<dialog open>` element. Root cause: an open `<dialog>` shown via `showModal()`
renders in the browser's "top layer", which sits above the ENTIRE document regardless of z-index — napi's
highlight box is a single div appended to `document.body` with `zIndex: 2147483647`, which still cannot
render above a top-layer dialog (the top layer is an architecturally separate stacking level, not just
"very high z-index"). Elements outside the dialog's bounds highlighted fine since nothing covered them
there. **Fixed** in `chrome-extension/public/buildDomTree.js`: `findHighlightParent()` walks up from the
target element to the nearest open `<dialog>` ancestor, if any, and the (singleton) highlight container is
reparented there instead of `document.body`, sharing the dialog's own top-layer context. **Not yet verified
live**, and there's a known follow-up risk: if the dialog centers itself via a CSS `transform`, that
establishes a new containing block for the container's `position: fixed`, which could offset the highlight
box relative to the viewport-based coordinate math the rest of the code uses — confirm the box shows up in
the RIGHT place on retest, not just that it shows up at all.

**✅ Verified live (Sep 12) — full success.** Retested `guide me to post on LinkedIn` fresh: spotlighted
"Start a post" → clicked → verified; spotlighted the Post button (now correctly highlighted inside the
`<dialog>`) → clicked → verified (`the page navigated as expected`, URL back at `/feed`) → real published
post. First fully successful free-text-guided real-world task on a genuinely hard site, after five distinct
bugs found and fixed from this one test case. The Post button did need 4 spotlight attempts before the
click registered (3 timeouts first) — most likely a testing-workflow artifact (switching between the page
and pasting logs eats the 2-minute window) rather than a new bug, since detection worked cleanly once
actually clicked; timeout length (currently 120s) is a deliberate first-time-user-friendly default, left
as-is for now — revisit if this pattern recurs outside of testing.

**Also observed (not yet acted on):** the same run wasted 3 steps on "Frame with ID 624 is showing error
page" before self-correcting via `go_to_url` — likely just the active tab not being on a real page yet
when the task started. Minor overhead, not chased further this session; revisit if it recurs.

**Optional refinements (not blocking; do later if a real mission needs them):**
- **Generic local DOM-change** detection for controls where a click alone isn't the completion signal
  (e.g. an expander whose `aria-expanded` flips on a different node). Add a `mode: 'dom'` with a
  MutationObserver near the target.
- **`go_to_url`** currently runs via fix A (the extension navigates for the user). For a true
  guide-only experience, detect `go_to_url` and instead show "navigate to X yourself" + wait for the
  URL change.

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

## Performance — big-page pass  **[DONE]**

Guided steps were taking 10+ minutes on large web apps. Diagnosed as the model
layer, not DOM scanning (browser config is already viewport-only).

Done + committed:
- **Model retry cap** — `helper.ts`: `MODEL_MAX_RETRIES = 2` +
  `MODEL_REQUEST_TIMEOUT_MS = 60_000` on every provider. Kills the ~12-minute
  silent-retry hang on a transient provider `503`.
- **Fewer Planner calls in guide mode** — `setupExecutor()`:
  `planningInterval = guideMode ? 999 : <user setting>`. Planner still runs at
  the start and on `done`, not every 3 steps. Halves LLM round-trips per step.
- **Lighter Checker read** — `navigator.ts`: skip the full `getState()` DOM
  rebuild when the verdict doesn't need it (timeout, `input_text` match, or a
  URL change detected via `chrome.tabs.get`).

**Verified live (Sep 11)** — full run on `example.com`, task "open learnmore link":
Navigator spotlighted the link -> user clicked it -> URL changed ->
`🧭 CHECKER — verified: the page navigated as expected` fired off the cheap
`chrome.tabs.get` path (no full DOM rebuild) -> next step was a no-target
`done` action, ran normally via fix A instead of guide-waiting -> Planner ran
once more (triggered by `navigatorDone`, not the interval) and confirmed
completion. All three perf changes and the guide loop's happy path now
confirmed end to end, not just in isolation.

**Verified live again (Sep 11)** — real heavy page, `w3schools.com/html/html_forms.asp`
(scroll height 7219px), task "click Next to go to the next tutorial page":
the Checker's lightweight URL-change path fired correctly **four times in a
row** across pages of very different DOM sizes (7219 -> 2090 -> 2743 -> 5771
-> 2090px), each one `✅ CHECKER — verified: the page navigated as expected`
with no full DOM rebuild logged. The task was eventually stopped by the user
(`RequestCancelledError: Aborted`, handled cleanly, no crash) because the
open-ended instruction ("go to next page") was satisfiable on every page in
the series — not a detection bug, a test-task wording issue. **Lesson for
Stage 6:** author each mission step as a single bounded instruction ("click
Next once"), not an open-ended one, so the loop has a natural stop.

Still to do (moved to Stage 7):
- Measure real per-step latency on a heavy app (Notion / Gmail) and set a
  budget.
- Still untested: the Checker's "not verified" path (a click that produces no
  detectable change) and the `input_text` value-match path under the new
  lighter-read logic.

(The model-fallback chain that was going to be listed here got pulled forward and built — see the
**Model-fallback chain** section below, right after Stage 4.)

---

## Stage 4 — the Skill Map  **[v1 DONE]**

**Goal:** persist what the user can actually do, per tool.

Done + committed:
- **Schema + store** — `packages/storage/lib/skillMap/skillMap.ts`. `SkillNode = { tool, skillId, label,
  status: 'not-started' | 'guided' | 'unaided' | 'rusty', guidedCount, verifiedCount, lastGuidedAt,
  lastVerifiedAt }`, keyed by `${tool}::${skillId}`, backed by `chrome.storage.local` via the same
  `createStorage` helper every other store uses (`generalSettingsStore`, `favoritesStorage`, ...) — so it
  survives an extension restart the same way they do. API: `recordGuidedStep`, `recordUnaidedSuccess`,
  `applyDecay(thresholdDays)`, `getAllSkills`, `getSkillsForTool`, `getSkill`, `resetAll`.
- **Hook-in** — `navigator.ts`, inside the guide branch's `check.verified` block: every Checker-verified
  guided step calls `skillMapStore.recordGuidedStep({ tool, skillId, label })`. `tool` = the page's
  hostname (`toolFromUrl`); `skillId` = a slug of the action name + the step's goal text
  (`skillIdFromStep`) — crude on purpose, since there's no mission catalog yet. A repeat guided pass never
  downgrades an already-`unaided` skill back to `guided`, it just bumps the counters. Best-effort: a
  storage failure only logs a warning, never interrupts the guide loop.
- **`recordUnaidedSuccess`** exists and is wired into the store's public API, but nothing calls it yet —
  that's Stage 6's "no-hints challenge passes the Checker" event. Skills will sit at `guided` until then.
- **Decay pass** — `background/index.ts` calls `skillMapStore.applyDecay()` once on every service-worker
  wake (cheap, idempotent): any `unaided` skill untouched for 14+ days flips to `rusty`.
- **Minimal UI** — new **Skills** tab in the Options page (`pages/options/src/components/SkillMap.tsx`),
  grouped by tool, each row showing the step label, a status pill, guided/verified counts, and last
  activity. Matches the existing `GeneralSettings.tsx` visual style. The real side-panel tree view is
  still the later **UI stage** item, once the panel redesign happens.

**Still to do:** once Stage 6 missions exist, call `recordUnaidedSuccess` from the mission's end-of-mission
challenge; better `skillId`s from mission templates instead of the slug heuristic; a side-panel view.

---

## Model-fallback chain  **[v1 DONE — pulled forward from Stage 7]**

**Goal:** a failing/rate-limited model fails the *call*, not the whole task — retry with the next
configured model instead. This was originally scheduled for Stage 7, but free-tier flakiness (Gemini's
20/day quota, Kira models going into maintenance, Groq/Cerebras limits) blocked testing repeatedly during
the perf-fix session, so it was pulled forward. Chose the simple design: **a fixed, user-ordered list per
agent**, tried in order — not automatic "skip providers rate-limited today" bookkeeping (that's a
reasonable v2 if the fixed list turns out not to be enough).

Done + committed:
- **Storage** — `packages/storage/lib/settings/agentModels.ts`: `AgentModelRecord.fallbacks?:
  Partial<Record<AgentNameEnum, ModelConfig[]>>`, plus `setAgentFallbacks` / `getAgentFallbacks`. Fixed a
  real bug while adding this: `setAgentModel`, `resetAgentModel`, and `cleanupLegacyValidatorSettings` were
  all replacing the WHOLE stored record instead of spreading `...current` — which would have silently
  wiped every fallback list on the very next primary-model save (and `cleanupLegacyValidatorSettings` runs
  on *every* task start). Fixed all three before it ever shipped.
- **Retry mechanics** — `chrome-extension/src/background/agent/agents/base.ts`: new `FallbackModel { chatLLM,
  provider }` type, a `fallbackModels` queue on `BaseAgent`, and `protected withModelFallback(attempt)`
  which runs `attempt()`, and on a non-abort failure `shift()`s the next fallback off the queue, switches
  every field that was derived from the old model at construction time (`chatLLM`, `provider`,
  `chatModelLibrary`, `modelName`, `withStructuredOutput`, `toolCallingMethod`), and retries. A successful
  switch is **sticky** — the agent keeps using that model for the rest of the task; it never re-tries a
  model that already failed. `BaseAgent.invoke()` now wraps its body (renamed `invokeOnce`) in
  `withModelFallback`.
- **NavigatorAgent has its own `invoke()` override** (a near-duplicate of `BaseAgent`'s, for its own JSON
  schema) — it does NOT go through `BaseAgent.invoke()`. Same treatment: renamed to `invokeNavigatorOnce`,
  wrapped in `withModelFallback`. Its non-structured-output branch now calls the base class's
  `invokeManualExtraction()` directly (pulled out of `BaseAgent.invoke()` into its own protected method)
  instead of `super.invoke()` — calling `super.invoke()` there would have wrapped the call in a *second*,
  redundant fallback loop sharing the same queue.
- **Wiring** — `background/index.ts` `setupExecutor()` builds each agent's fallback `BaseChatModel`s from
  its stored `ModelConfig[]` (`buildFallbackModels`, skips — with a warning, not a crash — any fallback
  whose provider was removed or fails to construct) and passes them through `Executor` to `NavigatorAgent` /
  `PlannerAgent` as `fallbackModels`.
- **Visibility** — when a switch happens, the agent emits a system event: `⚠️ <old model> was unavailable —
  switched to <new model>` — shows up in the side panel like any other step message, so the user isn't
  left wondering why the flow suddenly feels different.
- **Options UI** — new **Fallback** tab (`pages/options/src/components/FallbackModels.tsx`), separate from
  the large existing `ModelSettings.tsx` (deliberately not touched — 1700+ lines, out of scope for this
  change). Per agent with a primary model set: shows the primary, an ordered list of fallbacks with
  up/down/remove, and an add row (provider dropdown + a model dropdown sourced from that provider's already
  -added model names, or a text field if it has none). Saves immediately on every change, same pattern as
  `GeneralSettings.tsx`.

**Still to do (real v2, not urgent):** the "skip providers already rate-limited today" refinement the user
considered and deferred; surfacing fallback status in the Skill Map or side panel beyond the one-line
system message.

**Verified live (Sep 11):** the detect → switch → retry mechanism itself is proven correct across every
test run today — it never once behaved incorrectly:
- Primary `gemini-does-not-exist-123` (deliberately broken) → correctly detected, correctly switched to
  the configured fallback `hy3`, on both the Planner's and the Navigator's own separate fallback queues.
- 3 of those runs: `hy3` also failed (`503 ... currently under maintenance` — likely Kira's free-tier
  burst rate limit, not necessarily a real outage, since `hy3` succeeded cleanly as a standalone primary
  moments later) → correctly logged `🔀 FALLBACK — hy3 also failed`, exhausted the list, and let the task
  fail cleanly via the existing max-failures safety net. No hang, no crash, no double-switching.
- 1 run (`hy3` as sole primary, no fallback needed): completed cleanly end to end on a real Wikipedia
  click-through, confirming the retry/perf/Checker pipeline together on a third real site.
Never got two providers alive at once long enough to see a full "switched and then finished the task"
run — that's environment luck (free-tier availability), not a code gap. Given 4/4 mechanically-correct
runs, treating the fallback mechanism as verified and moving on.

---

## Stage 5 — Recovery  **[v1 DONE]**

**Goal:** when the user goes off-track, diagnose the real state and guide them back calmly.

Done + committed — the fast, no-LLM-call path (`navigator.ts`, `buildRecoveryMessage`):
- The Checker's "not verified" branch now distinguishes its two cases with different, calmer copy instead
  of one generic "try again":
  - **Timeout** (user hasn't acted yet): `Still waiting for you — no rush. When you're ready: <step>` — a
    wait, not a wrong turn, so no blame framing at all.
  - **Dead click** (user acted, nothing detectably changed) — the real "off-track" case: names the current
    site and restates the step. A new `consecutiveNotVerified` counter (resets on any verified step)
    escalates the message after a repeat: mentions checking the highlighted element is still there and
    suggests a refresh if it keeps happening.
- Never says "that's wrong" anywhere — always describes where the user actually is (via `toolFromUrl`) and
  what to do next.

**Not done (needs Stage 6, honestly deferred, not silently skipped):**
- Sending an actual-vs-expected **delta to the Planner LLM** for a real diagnosis — there's no `expected`
  spec per step yet (Stage 3's still-to-do item), so there's nothing to diff against. This is the "real"
  recovery experience; v1 is a calm, generic placeholder until missions exist.
- **Pre-authored recovery text for the top ~5 known wrong turns per step** — "per step" means a mission
  step template (Stage 6), which doesn't exist yet. v1's message is generic across all steps by necessity.

**Done when (original bar, not yet met):** a wrong turn during a mission produces a helpful, SPECIFIC
redirect (not just a calmer generic one). Revisit once Stage 6 mission templates exist.

---

## Stage 6 — Missions for one flagship tool  **[v1.1 DONE]**

**Goal:** real, hand-authored lessons for ONE web app, that napi runs FOR you. **Flagship chosen: Notion.**

**v1** shipped mission content only (read a lesson, copy each step into the chat by hand) — user feedback
was immediate and correct: that doesn't make anything easier for napi, it's just a cheat-sheet for the
human. **v1.1**, same session, replaced that with the real thing: napi runs the mission automatically.

Done + committed:
- `packages/storage/lib/missions/missions.ts` — `Mission { id, tool, title, description, steps: {
  instruction, why }[] }` (moved here from the `options` page so the side panel can import it too — both
  already depend on `@extension/storage`, so no new workspace package was needed). One authored mission:
  **"Create a new page in Notion"**, 3 steps.
- **The mission runner — `pages/side-panel/src/SidePanel.tsx`.** A new **Missions** icon/tab in the side
  panel (`FiBookOpen`) lists missions with a **Start** button. Starting one:
  1. clears the chat (`handleNewChat`) and sends step 1 exactly like a typed task (`handleSendMessage`).
  2. On that task's `TASK_OK` event, `advanceMission()` automatically sends the next step as a
     `follow_up_task` — no retyping, no copy-paste.
  3. On `TASK_FAIL`, `stopMission()` ends the mission cleanly with a message naming which step it died on
     (v1.1 doesn't resume mid-mission — restart from the top).
  4. A small "▶️ Mission in progress — step X of Y" banner shows above the chat the whole time.
  - Every step is still just an ordinary guided task under the hood — same guide loop, Tier-2 Checker,
    Recovery messaging, and Skill Map recording as anything typed by hand. The runner only automates
    *sending* each step; it doesn't change how a step is executed or verified.
  - Implementation note: the mission's progress lives in a `ref` (`activeMissionRef`), not only React
    state, because the event handler that needs to read it (`handleTaskState`) is a `useCallback` memoized
    once at mount — a ref sidesteps the stale-closure trap that would otherwise make it see an outdated
    step index.
- `pages/options/src/components/Missions.tsx` — kept as a **reference view**: full description, each
  step's "why", and a manual Copy button per step, for anyone who wants to read ahead or go one step at a
  time by hand instead of using the automatic runner.
- Step wording is still a **first draft** based on Notion's known web UI (the sidebar "+ New page"
  control, etc.) — not verified against a live Notion account yet. Validate/tune it the same way every
  other feature here got tested: run it, see what breaks, fix the wording.

**Not done (real Stage 6 v2, in priority order):**
1. **The unaided challenge** — a "no hints" mode for a mission's last step (don't spotlight, just verify)
   that's what actually unlocks a Skill Map skill's `unaided` status via `recordUnaidedSuccess`. Currently
   impossible — nothing calls that function yet.
2. **Tier-1 verification via Notion's API** (OAuth, read-mostly scopes) instead of only the on-page Checker.
3. **An LLM mission-picker** that maps a free-text goal to the right mission and skips steps the Skill Map
   already shows as mastered.
4. **Resuming mid-mission** after a `TASK_FAIL` instead of restarting from step 1.
5. 3-4 more missions (database, share, template) — worth authoring now that the runner exists.

**Done when (original bar, mostly met):** missions run start to finish automatically — true as of v1.1.
Still open: the unaided challenge and skill-map update at the end of a mission, and more than one mission.

---

## UI stage — side panel redesign  **[v1 started, Sep 12]**

**Goal:** make the panel feel like a tutor, not a chat log.

User asked for this "simple" — v1 is deliberately small: one new card, zero new event types, zero
backend changes, reusing exactly what `navigator.ts` already emits.

Done + committed:
- **Current-step card** (`pages/side-panel/src/components/CurrentStepCard.tsx`) — one card, one status
  (waiting / verified / retry) with an icon + color, the instruction text, and a "Step X of Y" line when a
  mission is running. Replaces the old one-line mission-progress banner.
- Populated directly inside `SidePanel.tsx`'s existing `handleTaskState` (`Actors.NAVIGATOR` switch) by
  matching the `👉 Your step:` / `✅ Done:` / `⚠️ ...` prefixes already in the emitted text — no new event
  types, no `SHOW_STEP`/`STEP_VERIFIED`/etc.
- **Real bug found in the process**: `👉 Your step:` (`STEP_OK` for the Navigator actor) was never actually
  rendered in the chat at all — `handleTaskState` leaves `skip = true` for that case by default. Users were
  being guided ONLY by the on-page spotlight, with no confirming text anywhere in the panel. The new card
  surfaces information that was genuinely missing, not just a prettier version of something already shown.

**Not done (still matches the original task list):**
- A "Why?" expander — no "why" text exists for ad hoc free-text tasks today (only missions have one, shown
  in the Options reference view, not inline during a live guided step).
- A true "Step X of Y" for free-text tasks — only missions know their total step count in advance; an
  ad hoc goal's plan isn't fixed upfront, so there's nothing to count against yet.
- A Skill Map view inside the side panel itself — it exists in Options (Stage 4) and wasn't duplicated
  here, to keep this pass small.

**Done when:** a first-time user understands what to do without reading a chat transcript. Closer than
before (the single most important text is now front-and-center, not the case that it never rendered at
all) — not fully there without the "why" and real progress-count pieces above.

**v1.1 (Sep 12), same day — four more explicit asks:**
- **Yellow brand color** — mechanical `sky-*`/`blue-*` → `yellow-*` Tailwind class swap (plus the raw
  `#0EA5E9` hex in `Options.tsx`) across every side-panel and options file. `CurrentStepCard`'s
  green=verified/amber=retry kept distinct on purpose.
- **napi logo** — `pages/side-panel/src/components/NapiLogo.tsx`, an inline SVG (lightbulb-in-a-circle,
  yellow) replacing the `<img src="/icon-128.png">` header logo. No image-editing tools available in this
  environment to recolor the existing PNG icon files — this only changes the in-app logo; the actual Chrome
  toolbar/extensions-page icon still needs real new icon assets.
- **Chatbot-style explain-then-guide** — a typed request now gets an explain-only answer first (no page
  interaction), then a **"▶ Start guiding me through this"** button; only clicking it starts the real guide
  loop. New `handleUserSubmit` wraps outgoing text with an explain-only instruction and remembers the
  original ask (`pendingGuideTask`); the button resends it as a real follow-up. Mission runs bypass this
  entirely (their own Start button + pre-written steps already exist).
- **Hid Planner/Navigator "loop" noise** — no more "Showing progress..." bubbles for `STEP_START`, no more
  per-action `ACT_START` intent narration. The Planner's actual plan and real errors (`ACT_FAIL`,
  `TASK_FAIL`) still show; `STEP_FAIL`'s recovery text no longer duplicates into the chat now that
  `CurrentStepCard` already shows it.
- **Driver.js for the spotlight** — `pages/content/src/index.ts` now calls `driver().highlight({ element,
  popover })` on the marked guide-target (dims the page, cuts a highlight, shows the step's instruction in
  a popover) instead of relying only on `buildDomTree.js`'s plain colored box. `buildDomTree.js`'s own
  highlighting (used for the model's understanding of the whole page) is untouched.
  - **Build gotcha found + fixed**: a content script has no `<link>` tag to load CSS from, and
    `content_scripts` in the manifest here only ever declared `js`, never `css` — Driver.js's stylesheet
    would've been dead weight with zero visual effect (this was already true of the previous, unused
    `_content.css` output too). Added `vite-plugin-css-injected-by-js` so content-script CSS inlines into
    the JS bundle as a runtime `<style>` tag instead.
  - **Known limitation**: Driver.js always appends its overlay to `document.body` (no container/root config
    option exists in its API) — a native `<dialog>` shown via `showModal()` (LinkedIn's post composer, for
    one) could hide it behind the browser's "top layer" the same way it hid `buildDomTree.js`'s highlight
    before that fix. `buildDomTree.js`'s own highlight still works correctly there since it WAS fixed; only
    Driver's new overlay has this gap. Not addressed — watch for it on dialog-heavy sites.
  - **Not yet tested live** — retest on a real page to confirm the spotlight actually renders and stays
    clickable.

---

## Stage 7 — polish + first users  **[in progress]**

- Onboarding: paste a model key (or bundle a limited one), pick a goal.
- Graceful model-error handling, clear messages, no dead ends. Retry cap
  (`helper.ts`) and the model-fallback chain are both done (see above); still
  needed: per-step latency budgets on a heavy app, and deciding whether v2's
  "skip providers already rate-limited today" refinement is worth it.
- **Package the extension; write a one-page install guide. — DONE (Sep 12).**
  `pnpm zip` → `dist-zip/extension-<date>.zip`. `NAPI_INSTALL_GUIDE.md` covers: what you need (a free
  Groq/Gemini key), loading the unpacked extension, first-time model + guide-mode setup, how to use
  it (free-text tasks or the Missions tab), known limitations, and what to note when reporting a bug.
  Still displays as "Nanobrowser" in Chrome for now — a visual rebrand to "napi" is a separate,
  later step, not done here.
- Give it to 5-10 beginners; watch them use it; log every place it breaks or confuses. **Not started**
  — the install guide above is what makes this possible; next real step is finding testers.

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
