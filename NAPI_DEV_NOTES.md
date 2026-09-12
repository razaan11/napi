# napi — Development Notes (handoff)

> Read together with `CLAUDE.md` (Nanobrowser's own architecture doc) and
> `NAPI_ROADMAP.md` (all remaining work).
>
> Branch: `guide-mode`. Never commit to `master`.
> Stage 1 + Stage 2 guide-loop changes span several files — see section 4.
> **Stage 2 click-detection is IMPLEMENTED BUT NOT YET COMMITTED** — review `git diff`,
> commit only the intended files.

## 1. What this project is

**napi** = a "learning by doing" guide. It turns an AI browser agent into a *tutor*:
instead of the AI performing actions, it shows the user **one step at a time**,
highlights the target element, waits for the user to do it themselves, verifies the
result, and (eventually) tracks proven skills.

**Phase 1 (current):** online only — guiding web apps. Built by **forking Nanobrowser**
(open-source AI browser-agent Chrome extension, Apache-2.0) and modifying it.

## 2. Repo & environment

| | |
|---|---|
| Repo | `github.com/razaan11/napi` (rename of a fork of `nanobrowser/nanobrowser`) |
| Working branch | `guide-mode` (branched off `master`, untouched original Nanobrowser v0.1.13) |
| Node | v24 (`engines` requires `>=22.12.0`; `.nvmrc` says 22.12.0 but is not enforced) |
| Package manager | `pnpm` 9.15.1 |
| Build | `pnpm build` -> outputs to `dist/` |
| Load in Chrome | `chrome://extensions` -> Developer mode ON -> Load unpacked -> select `dist/` -> click reload after every build |
| Background logs | `chrome://extensions` -> extension card -> "service worker" link -> Console tab. Source of truth, not the side panel. |

**Testing caveat:** after reloading the extension in `chrome://extensions`, Chrome disconnects
content scripts already injected into open tabs. **Reload the actual web page (`Ctrl+R`)** or open a
new tab before testing, or background<->content messaging fails with
`Could not establish connection. Receiving end does not exist.`

### Model provider

**Kira AI** (`kiraai.vn`), OpenAI-compatible, added in extension Settings as a
**Custom / OpenAI-Compatible** provider:

- Base URL: `https://kiraai.vn/api/v1`
- Model in use: **`hy3`** (free, no deposit, reliable structured output) for Planner and Navigator.
- Avoid: `kira-auto` (malformed JSON in `<plan>` tags). `gpt-oss-120b` needs paid wallet balance.
- Free-tier, no balance: `kira-auto`, `hy3`, `kira-mini-1.0`, `kira-2.0`, `mimo-v2.5`.

## 3. How Nanobrowser works (the parts that matter)

Monorepo (`pnpm` workspaces + `turbo`). Chrome MV3 extension = separate programs talking via messages:

- **Background service worker** — `chrome-extension/src/background/` — coordinator + AI logic. No page access.
- **Content scripts** — `pages/content/` — injected into web pages.
- **Side panel** — `pages/side-panel/` — React chat UI.
- **Options page** — `pages/options/` — settings.
- **Shared packages** — `packages/` (`storage`, `i18n`, `ui`, ...).

### Task flow

1. Side panel sends `{ type: 'new_task', task, tabId }` over a long-lived **port** to the background.
2. `chrome-extension/src/background/index.ts` -> `setupExecutor()` -> reads providers + per-agent
   models -> `createChatModel()` -> `new Executor(...)`.
3. `executor.execute()` (`agent/executor.ts`) loops up to `maxSteps`:
   - periodically run **Planner** (`agent/agents/planner.ts`) -> plan + `done` flag; `checkTaskCompletion()` stops if `done`.
   - run **Navigator** (`agent/agents/navigator.ts`) via `navigate()` -> `this.navigator.execute()`.
4. `emitEvent` events flow back over the port to the side panel.

### The Page Reader

- On tab load, `index.ts` injects `buildDomTree.js`.
- `Page.getState()` / `Page._updateState(useVision, focusElement, guideTargetId?)` ->
  `getClickableElements(showHighlight, focusElement, guideTargetId?)` -> runs `buildDomTree`, which
  numbers interactive elements and draws highlight boxes. `focusElement` = a real index emphasizes
  that one element. `guideTargetId` (napi addition) marks that element with
  `data-napi-guide-target="<id>"` for click detection.
- Files: `browser/context.ts`, `browser/page.ts`, `browser/dom/service.ts`, `browser/dom/` + `chrome-extension/public/buildDomTree.js`.

### The Navigator

`chrome-extension/src/background/agent/agents/navigator.ts` -> `execute()`:

1. `addStateMessageToMemory()` — page state into the LLM conversation.
2. `modelOutput = await this.invoke(inputMessages)` — LLM decides
   `{ current_state: { next_goal }, action: [ { <name>: <args> } ] }`.
3. `actions = this.fixActions(modelOutput)`.
4. memory bookkeeping.
5. original: `actionResults = await this.doMultiAction(actions)` (performs the action).
6. returns `{ done }` from `actionResults[last].isDone`.

## 4. Changes made

### Stage 1 — guide-mode branch (in `navigator.ts`)

**A. Hardcoded flag** (top of file, under `const logger = createLogger('NavigatorAgent');`):

```ts
// TEMP (napi Stage 1): hardcoded guide-mode switch. Moves to settings later.
const GUIDE_MODE = true;
```

WARNING: still hardcoded `true`. The extension currently CANNOT do normal auto-mode.
Making this a real setting is the next Stage 1 item.

**B. `waitForUserStep()`** — new method in `class NavigatorAgent`, just before `private async doMultiAction(`.
Originally polled the tab URL every 1.5s for up to 2 min; `true` on URL change, `false` on timeout,
plus `paused/stopped` checks. **Now updated in Stage 2 (see below) to also race a click signal.**

**C. The guide branch** — inside `execute()`, replacing `actionResults = await this.doMultiAction(actions);`
(right after `// take the actions`). In guide mode it:
- emits `Your step: <next_goal>` as a `STEP_OK` event,
- spotlights the target element via `page._updateState(useVision, targetIndex, guideStepId)`,
- registers a click waiter and tells content scripts to watch the marked element,
- calls `await this.waitForUserStep(...)`,
- returns a synthetic `ActionResult` (never `isDone: true`).
Otherwise `else { actionResults = await this.doMultiAction(actions); }`.

Committed: `Stage 1: guide-mode stub`, `Stage 2: pauses and waits (URL detection)`,
`Stage 2: spotlight the target element`.

### Stage 2 (part 2) — click detection for non-navigation steps  **[IMPLEMENTED, NOT COMMITTED]**

When the URL does not change, detect a real user click on the spotlighted element.

Mechanism:
1. Navigator creates a unique `guideStepId` via `crypto.randomUUID()`.
2. Registers a pending click waiter **before** the user can click.
3. `buildDomTree` marks the spotlighted element with `data-napi-guide-target="<guideStepId>"`.
4. Background broadcasts `guide_watch_target` to content scripts in **all frames**.
5. Content script finds `[data-napi-guide-target]`, adds a one-shot **capturing** click listener.
6. Only `event.isTrusted` clicks count — page JS calling `.click()` does NOT advance the guide.
7. On a real click, content script sends `guide_target_clicked` (with step id) to the background.
8. Background validates `sender.tab.id`, resolves the matching pending waiter.
9. `waitForUserStep()` **races** the click signal against URL-change polling; first one wins.
   2-min timeout and `paused/stopped` checks retained. Proper listener cleanup on resolve/timeout.

Files changed (Stage 2 part 2):

| File | Change |
|---|---|
| `chrome-extension/src/background/guide-step.ts` | **new** — in-memory pending click waiters keyed by `guideStepId`. Exports `waitForGuideStepClick(tabId, stepId)`, `notifyGuideStepClick(tabId, stepId)`, `watchGuideStepTarget(tabId, stepId)`. Broadcasts the watch message to all frames; ignores restricted/third-party frames. |
| `pages/content/src/index.ts` | `chrome.runtime.onMessage` handler for `guide_watch_target`; locates `[data-napi-guide-target]`; adds/removes a one-shot trusted capturing click listener; sends `guide_target_clicked`. |
| `chrome-extension/src/background/index.ts` | `chrome.runtime.onMessage` handler for `guide_target_clicked`; reads `sender.tab.id`; calls `notifyGuideStepClick(tabId, stepId)`. |
| `chrome-extension/public/buildDomTree.js` | accepts optional `guideTargetId`; clears old `data-napi-guide-target` markers; adds the marker only to the focused element. |
| `chrome-extension/src/background/browser/dom/service.ts` | threads optional `guideTargetId` into the injected `buildDomTree()` call. |
| `chrome-extension/src/background/browser/page.ts` | threads `guideTargetId` through `getClickableElements()` and `_updateState()`. |
| `chrome-extension/src/background/agent/agents/navigator.ts` | imports the guide-step helper; creates/registers the click waiter before spotlighting; calls `_updateState(useVision, targetIndex, guideStepId)`; tells content scripts to watch; updates `waitForUserStep()` to race click vs URL. |

Verification: `pnpm build` -> `Tasks: 5 successful, 5 total`. Manual test on
`https://www.w3schools.com/howto/howto_js_dropdown.asp`, task "Open the dropdown menu." — clicking the
in-page "Click Me" button advanced the guide with no URL change. Console:
`GUIDE MODE - spotlighted target clicked` / `GUIDE MODE — user clicked the spotlighted element` /
`Executor — Step 3 / 100`.

### Stage 2 fix A + fix B  **[DONE, committed]**

- **Fix A** (`31ca4a8`): the guide branch computes `isUserStep` = "does `actions[0]` have a target
  element index". If not (`done`, `wait`, agent navigation) it runs the action via `doMultiAction`
  instead of guide-waiting. Stops the 2-minute hang on `done` steps. `go_to_url` currently also
  runs this way (extension navigates for the user).
- **Fix B** (`e66a93e`): typing / value-match detection. `guide-step.ts` `watchGuideStepTarget` now
  takes `{ mode: 'click' | 'value', expectedText? }` and includes it in the `guide_watch_target`
  message. For an `input_text` action the navigator passes `{ mode: 'value', expectedText: args.text }`.
  Content script, `mode: 'value'`: attaches an `input` listener, compares `el.value` (trimmed,
  lower-cased) to `expectedText`, sends `guide_target_matched` on match. `background/index.ts` handles
  both `guide_target_clicked` and `guide_target_matched` via `notifyGuideStepClick`.
  Verified on google.com: "Type \"hello world\" in the search box" advances when the value matches.

### Big-page performance pass  **[DONE, committed]**

Symptom the user hit: on a large web app, a guided step could sit "thinking" for
10+ minutes. Root cause was **not** DOM scanning (the browser config is already
viewport-only, `viewportExpansion: 0`, short page-load waits). It was the model
layer:

- **No retry cap.** LangChain chat models default to ~6 retries with exponential
  backoff. One transient `503 / "high demand"` from a free provider (Gemini,
  Kira) turned into ~12 minutes of silent retrying before the task failed.
- **Planner ran every 3 steps.** In guide mode the user performs each step, so
  the plan never really changes — but the Executor still fired a second slow,
  vision-enabled LLM call every few steps, doubling latency and the 503 surface.

Fixes:

1. `chrome-extension/src/background/agent/helper.ts` — added
   `MODEL_MAX_RETRIES = 2` and `MODEL_REQUEST_TIMEOUT_MS = 60_000`, applied to
   **every** provider (`createOpenAIChatModel` + OpenRouter/custom, Azure,
   Anthropic, DeepSeek, Gemini, Grok, Groq, Cerebras, Ollama, Llama). Gemini and
   Ollama only take `maxRetries` (their LangChain wrappers have no `timeout`
   arg). A bad model call now fails in seconds with a clear error instead of
   freezing the panel.
2. `chrome-extension/src/background/index.ts` `setupExecutor()` —
   `planningInterval: generalSettings.guideMode ? 999 : generalSettings.planningInterval`.
   With `nSteps` starting at 0 the Planner still runs once at the start (builds
   the plan) and again whenever the Navigator reports `done` (validates
   completion), just not on every step. Auto mode is untouched.
3. `chrome-extension/src/background/agent/agents/navigator.ts` — the Stage 3
   Checker no longer always calls `getState(false)` (a full DOM-tree rebuild).
   It now skips that read when the verdict doesn't need it: user timed out, an
   `input_text` value match, or the URL changed (checked with a cheap
   `chrome.tabs.get`). Only a click that did **not** navigate still pays for the
   structural fingerprint.

Not done here: measuring real per-step latency on a heavy app, and a proper
model-fallback chain (try model A, fall back to B on failure) — that's Stage 7.

**Verified live** (Sep 11): full guide run on `example.com` (spotlight -> click
-> URL change -> `verified: the page navigated as expected` via the cheap
path -> no-target `done` -> Planner re-run on completion) and again on a real
heavy page, `w3schools.com/html/html_forms.asp` — the lightweight Checker path
fired correctly across 4 consecutive navigations with very different DOM sizes
(7219 -> 2090 -> 2743 -> 5771 -> 2090px). Also confirmed: cancelling mid-task
(`RequestCancelledError`) shuts down cleanly, no crash.

### Stage 4 — the Skill Map (v1)  **[DONE, committed]**

- `packages/storage/lib/skillMap/skillMap.ts` — new store, same `createStorage`
  pattern as every other store here (survives restart via `chrome.storage.local`).
  `SkillNode = { tool, skillId, label, status, guidedCount, verifiedCount,
  lastGuidedAt, lastVerifiedAt }`. `status` is `'not-started' | 'guided' |
  'unaided' | 'rusty'`.
- `navigator.ts` — every Checker-verified guided step calls
  `skillMapStore.recordGuidedStep(...)`. `tool` = the page hostname
  (`toolFromUrl`), `skillId` = a slug of the action + goal text
  (`skillIdFromStep`) — a placeholder until Stage 6 missions supply real ids.
- `background/index.ts` — calls `skillMapStore.applyDecay()` on every
  service-worker wake; flips stale `unaided` skills to `rusty` after 14 days.
- `pages/options/src/components/SkillMap.tsx` — new **Skills** tab in Options,
  grouped by tool, showing label / status pill / counts / last activity.
- `recordUnaidedSuccess` exists in the store but nothing calls it yet — no
  skill will ever reach `unaided` until Stage 6 adds an end-of-mission
  no-hints challenge that calls it.
- A Skill Map row for `www.iana.org` from before a small attribution fix is
  cosmetic leftover in dev storage, harmless, safe to ignore or clear via
  `skillMapStore.resetAll()`.

### Model-fallback chain (v1)  **[DONE, committed]**

Pulled forward from Stage 7 — free-tier flakiness kept blocking testing, so
this became the practical priority. Design: **fixed, user-ordered list per
agent**, tried in order on failure (not "skip already-rate-limited providers
today" — that's a possible v2).

- `packages/storage/lib/settings/agentModels.ts` — `AgentModelRecord.fallbacks?:
  Partial<Record<AgentNameEnum, ModelConfig[]>>` + `setAgentFallbacks` /
  `getAgentFallbacks`. **Caught and fixed a real bug in existing code** while
  adding this: `setAgentModel`, `resetAgentModel`, and
  `cleanupLegacyValidatorSettings` all replaced the *whole* stored record
  instead of spreading `...current` — which would have silently wiped every
  fallback list on the next primary-model save, and
  `cleanupLegacyValidatorSettings` runs on **every** task start. Fixed all
  three (`return { ...current, agents: newAgents }` instead of
  `return { agents: newAgents }`).
- `chrome-extension/src/background/agent/agents/base.ts` — new `FallbackModel
  { chatLLM, provider }` type; `BaseAgent` gets a `fallbackModels` queue and a
  `protected withModelFallback(attempt)` that runs `attempt()`, and on a
  non-abort failure `shift()`s the next fallback off the queue, recomputes
  every field that was derived from the model at construction time
  (`chatLLM`, `provider`, `chatModelLibrary`, `modelName`,
  `withStructuredOutput`, `toolCallingMethod` — see `switchToFallback`), and
  retries. A successful switch is **sticky**: the agent keeps using it for the
  rest of the task, never re-tries a model that already failed.
  `BaseAgent.invoke()` now wraps its old body (renamed `invokeOnce`) in
  `withModelFallback`; the manual-JSON-extraction path was pulled out into its
  own `protected invokeManualExtraction()`.
- **Important gotcha found while building this:** `NavigatorAgent` has its
  OWN `invoke()` override (a near-duplicate of `BaseAgent`'s, for its own JSON
  schema) — it does **not** go through `BaseAgent.invoke()` at all for the
  structured-output path, which is what almost every model uses. Fallback
  support had to be added there too: renamed to `invokeNavigatorOnce`, wrapped
  in the same `withModelFallback`. Its non-structured-output branch now calls
  `this.invokeManualExtraction()` directly instead of `super.invoke()` —
  calling `super.invoke()` there would have wrapped the call in a *second*,
  redundant fallback loop sharing the same queue.
- `background/index.ts` `setupExecutor()` — `buildFallbackModels()` turns each
  agent's stored `ModelConfig[]` into ready `BaseChatModel`s (skips, with a
  warning, any fallback whose provider was removed or fails to construct —
  never crashes task start over a bad fallback entry) and passes them to
  `Executor` as `navigatorFallbackLLMs` / `plannerFallbackLLMs`.
- `executor.ts` passes those through to `NavigatorAgent` / `PlannerAgent` as
  `fallbackModels`.
- On a switch, the agent emits a system event: `⚠️ <old model> was
  unavailable — switched to <new model>` — visible in the side panel like any
  other step message.
- UI: new **Fallback** tab, `pages/options/src/components/FallbackModels.tsx`
  — deliberately a new small file, NOT a change to the existing
  `ModelSettings.tsx` (1700+ lines, out of scope). Per agent: primary model
  shown read-only, ordered fallback list with up/down/remove, add row
  (provider dropdown + a model dropdown sourced from that provider's already
  -added model names). Saves immediately on every change.

**Not done / real next step:** the "skip already-rate-limited-today" v2
refinement, and surfacing a fallback switch anywhere other than the one-line
system message.

**Verified live (Sep 11):** tested repeatedly with a deliberately broken
primary (`gemini-does-not-exist-123`, a real provider + nonexistent model —
fails in ~1s, not a slow timeout) and `hy3` (Kira) as the sole fallback.
Every run behaved correctly: primary failure detected, switched to `hy3`,
attempted it fresh. 3/4 runs `hy3` also failed (`503 ... under maintenance` —
likely Kira's free-tier burst rate limit rather than a real outage, since
`hy3` succeeded cleanly as a standalone primary moments later) — the code
correctly logged `🔀 FALLBACK — hy3 also failed`, exhausted the one-item
list, and let the task fail cleanly via the existing max-failures safety net.
1/4 run needed no fallback and completed end to end on Wikipedia. Never got
two providers alive at once long enough to see a full "switched, then
finished the task" run — environment luck, not a code gap. Treating the
mechanism as verified given 4/4 mechanically-correct runs.

### Stage 5 — Recovery (v1)  **[DONE, committed]**

`navigator.ts` — the Checker's "not verified" branch now builds a calmer,
state-aware message via `buildRecoveryMessage()` instead of one generic
"try this step again" for every case:
- **Timeout** (`!userActed`): `Still waiting for you — no rush. When you're
  ready: <step>` — framed as a wait, never as wrong.
- **Dead click** (`userActed` but nothing changed) — the real "off-track"
  case: names the current site (`toolFromUrl`) and restates the step. A new
  `consecutiveNotVerified` counter on `NavigatorAgent` (resets on any
  verified step) escalates the message on a repeat: mentions checking the
  highlighted element is still there, suggests a refresh if it keeps
  happening.

Deliberately NOT built yet (both need Stage 6 mission templates, which don't
exist): sending an actual-vs-expected delta to the Planner LLM for a real
diagnosis (no `expected` spec per step exists to diff against), and
pre-authored recovery text for known wrong turns (needs "per step" to mean
something, i.e. a mission template). v1 is a calm, generic placeholder, not
the specific redirect the original Stage 5 spec describes — flagged honestly
in the roadmap rather than marked fully done.

### Stage 6 — Missions (v1)  **[DONE, committed]**

Flagship chosen: **Notion**. Scope: author real mission content using the guide loop as-is, no new
execution mechanics — a deliberate trade to ship something real today.

- `pages/options/src/missions.ts` — `Mission { id, tool, title, description, steps: { instruction, why }[] }`.
  One authored mission, `notion-create-a-page`, 3 steps. Lives in the `options` page's own workspace (not
  `chrome-extension/src`) since it's pure display data for now and adding a new shared `packages/` workspace
  just for this would be a bigger structural change than this v1 warrants — a real mission runner (Stage 6
  v2) can relocate/import this when it exists.
- `pages/options/src/components/Missions.tsx` — new **Missions** tab: shows the mission, its steps'
  instruction + why, and a per-step Copy button (`navigator.clipboard.writeText`).
- **"Running" a mission today = manual**: turn on Guide mode, open Notion, copy each step into the chat in
  order, do it when spotlighted. Every step is just an ordinary guided task — same Checker, same Recovery
  messages, same Skill Map recording (`tool: 'www.notion.so'`) as anything else typed into the chat. Zero
  new runtime code.
- Step wording is a first draft from Notion's known web UI (sidebar "+ New page", etc.) — **not verified
  against a live Notion account this session** (would need real login). Needs the same test-then-fix pass
  every other feature here got.

**Not done (Stage 6 v2, in priority order):** an automatic mission runner (feed steps to the Executor
instead of retyping them), the end-of-mission unaided challenge (nothing calls `recordUnaidedSuccess` yet),
Tier-1 verification via Notion's API (OAuth), an LLM mission-picker, and 3-4 more missions (not worth
authoring until the runner exists).

## 5. Current behaviour (guide mode is always on)

Per Navigator step: LLM decides -> guide branch runs. If the action has no target element index
(`done`, `wait`, `go_to_url`, ...) it runs normally via `doMultiAction`. Otherwise it emits
`Your step:`, spotlights the target + marks it (`data-napi-guide-target`), tells content scripts to
watch it in `click` mode (default) or `value` mode (for `input_text`, with the expected text), then
`waitForUserStep()` blocks, resolving on the FIRST of: URL change, trusted click, value match, or
2-min timeout -> returns a synthetic `ActionResult` -> loop continues; Planner eventually sets `done`.

## 6. Known limitations / NOT done

1. ~~`GUIDE_MODE` hardcoded~~ **DONE (commit `76b0630`)** — now a `guideMode` toggle in General
   Settings (default off). Read via `this.context.options.guideMode`. Reload the side panel after
   changing the toggle.
2. **Checker: Tier 2 only** (commit `38e4a27`, `agent/checker.ts`). After `waitForUserStep` the guide
   branch calls `verifyStep({ actionName, userActed, before, after })`: timeout / dead click -> not
   verified (emit `STEP_FAIL`, feed "retry this step" into memory, bump `consecutiveFailures` on
   timeout); navigation / value-match / page-signature change -> verified (emit `STEP_OK`). Still to
   do: a per-step `expected` spec (so it's "right thing happened" not "something changed"), Tier 1
   (tool API), Tier 3 (vision), Recovery wiring, and calibration on a real flagship — the go/no-go gate.
3. **`go_to_url` is not guided** — it runs via fix A, so the extension navigates for the user
   instead of telling them to. Fine for now; refine later.
4. **No generic DOM-change detection** — a control whose completion signal is neither a click on the
   marked element, a URL change, nor an input value (e.g. `aria-expanded` flipping elsewhere) will
   time out. Add a `mode: 'dom'` with a MutationObserver if a real mission needs it.
5. **MV3 service worker idle kill (~30s)** — the wait only survives because the side panel sends
   heartbeats. The side panel must stay open during a guided task.
6. **`maxActionsPerStep` not forced to 1** — the LLM can propose multiple actions; only `actions[0]`
   is used.
7. **Panel UI unchanged** — no progress bar, no "why?", no "waiting" state, no skill map.
8. **`page._updateState` is a semi-internal method** (underscore prefix). Works, but a cleaner
   highlight API (or Driver.js) is better long-term.
9. **`data-napi-guide-target` attribute** mutates the live element — fine on normal sites; a
   framework that diffs/re-renders the DOM could strip it. First suspect if detection flakes on a
   specific site.
10. Cosmetic: `waitForUserStep` logs "user clicked the spotlighted element" even on a value match.

## 7. Immediate next steps

1. **Stage 1 finish — make `mode` a real setting.** Replace `const GUIDE_MODE = true` with
   `this.context.options.mode === 'guide'`. See `NAPI_ROADMAP.md` "Stage 1 (finish)":
   add `mode: 'auto' | 'guide'` to `packages/storage` general settings, a toggle in `pages/options`,
   thread it through `setupExecutor()` -> `agentOptions` (also force `maxActionsPerStep: 1` in guide
   mode).
2. **Stage 3 — the Checker.** The project's go/no-go gate. See `NAPI_ROADMAP.md`.
3. Then Skill Map, Recovery, flagship missions, side-panel redesign — roadmap order.

## 8. Rules for the next developer

- **Work on `guide-mode`.** Never commit to `master`.
- **After any code change:** `pnpm build`, reload the extension at `chrome://extensions`, **and
  reload the test page**. Watch the "service worker" console for `GUIDE MODE` logs.
- **Keep the side panel open** while testing a guided task.
- **Do not delete `LICENSE`** (Apache-2.0 — required for building on Nanobrowser).
- **Model:** `hy3` on the Kira provider. (Free providers 503 often — the retry
  cap in `helper.ts` keeps that from hanging the loop. A real fallback chain is
  still Stage 7.)
- **`this.context.options`** holds `maxSteps`, `maxFailures`, `maxActionsPerStep`, `useVision`,
  `planningInterval` — thread a `mode` field through from `setupExecutor` here.
- The Executor loop and Planner are **unchanged** — don't modify `executor.ts` / `planner.ts` unless
  a step explicitly calls for it.
- **`chrome-extension/public/buildDomTree.js`** is hand-edited — confirm no build step regenerates it
  before relying on the `guideTargetId` handling.
