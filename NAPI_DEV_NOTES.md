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
- **Model:** `hy3` on the Kira provider.
- **`this.context.options`** holds `maxSteps`, `maxFailures`, `maxActionsPerStep`, `useVision`,
  `planningInterval` — thread a `mode` field through from `setupExecutor` here.
- The Executor loop and Planner are **unchanged** — don't modify `executor.ts` / `planner.ts` unless
  a step explicitly calls for it.
- **`chrome-extension/public/buildDomTree.js`** is hand-edited — confirm no build step regenerates it
  before relying on the `guideTargetId` handling.
