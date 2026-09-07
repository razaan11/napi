# napi — Development Notes (handoff)

> Read this together with `CLAUDE.md` (Nanobrowser's own architecture doc).
> All napi-specific work so far is on branch `guide-mode`, in ONE file:
> `chrome-extension/src/background/agent/agents/navigator.ts`.

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
| Working branch | `guide-mode` (branched off `master`, which is untouched original Nanobrowser v0.1.13) |
| Node | v24 (project `engines` requires `>=22.12.0`; `.nvmrc` says 22.12.0 but is not enforced) |
| Package manager | `pnpm` 9.15.1 |
| Build | `pnpm build` -> outputs to `dist/` |
| Load in Chrome | `chrome://extensions` -> Developer mode ON -> Load unpacked -> select `dist/` -> click reload after every build |
| Background logs | `chrome://extensions` -> extension card -> "service worker" link -> Console tab. This is the source of truth, not the side panel. |

### Model provider

Uses **Kira AI** (`kiraai.vn`), an OpenAI-compatible API, added in the extension Settings
as a **Custom / OpenAI-Compatible** provider:

- Base URL: `https://kiraai.vn/api/v1`
- Model in use: **`hy3`** (free, no deposit, reliable structured output) for both Planner and Navigator.
- Avoid: `kira-auto` (returns malformed JSON wrapped in `<plan>` tags). `gpt-oss-120b` needs a paid wallet balance.
- Other free-tier models needing no balance: `kira-auto`, `hy3`, `kira-mini-1.0`, `kira-2.0`, `mimo-v2.5`.

## 3. How Nanobrowser works (the parts that matter)

Monorepo (`pnpm` workspaces + `turbo`). Chrome MV3 extension = separate programs that talk via messages:

- **Background service worker** — `chrome-extension/src/background/` — coordinator + AI logic. No page access.
- **Content scripts** — `pages/content/` — injected into web pages.
- **Side panel** — `pages/side-panel/` — the React chat UI.
- **Options page** — `pages/options/` — settings (providers, models).
- **Shared packages** — `packages/` (`storage`, `i18n`, `ui`, ...).

### Task flow

1. Side panel sends `{ type: 'new_task', task, tabId }` over a long-lived **port** to the background.
2. `chrome-extension/src/background/index.ts` catches it -> `setupExecutor()` -> reads providers + per-agent
   models -> `createChatModel()` builds the Navigator LLM + Planner LLM -> `new Executor(...)`.
3. `executor.execute()` (`chrome-extension/src/background/agent/executor.ts`) runs a loop up to `maxSteps`:
   - periodically run **Planner** (`agent/agents/planner.ts`) -> returns a plan + `done` flag;
     `checkTaskCompletion()` stops the loop if `done`.
   - run **Navigator** (`agent/agents/navigator.ts`) via `navigate()` -> `this.navigator.execute()`.
4. Events (`emitEvent`) flow back over the port to the side panel to display.

### The Page Reader

- On tab load, `index.ts` injects `buildDomTree.js` into the page.
- `Page.getState()` / `Page._updateState(useVision, focusElement)` ->
  `getClickableElements(showHighlight, focusElement)` -> runs `buildDomTree`, which numbers every
  interactive element and draws highlight boxes. Passing a real index as `focusElement`
  **emphasizes that one element**.
- Files: `chrome-extension/src/background/browser/context.ts`, `.../browser/page.ts`, `.../browser/dom/`.

### The Navigator (where all napi changes are)

`chrome-extension/src/background/agent/agents/navigator.ts` -> `execute()`:

1. `addStateMessageToMemory()` — page state into the LLM conversation
2. `modelOutput = await this.invoke(inputMessages)` — **LLM decides**
   `{ current_state: { next_goal }, action: [ { <name>: <args> } ] }`
3. `actions = this.fixActions(modelOutput)`
4. memory bookkeeping
5. **`actionResults = await this.doMultiAction(actions)`** — original: **performs** the action
   (`actionInstance.call(actionArgs)`)
6. returns `{ done }` based on `actionResults[last].isDone`

## 4. Changes made (all in `navigator.ts`, branch `guide-mode`)

### Change A — hardcoded flag (top of file, just under `const logger = createLogger('NavigatorAgent');`)

```ts
// TEMP (napi Stage 1): hardcoded guide-mode switch. Moves to settings later.
const GUIDE_MODE = true;
```

WARNING: hardcoded `true`. The extension currently CANNOT do normal Nanobrowser auto-mode.
Replacing this with a real setting is a priority next step.

### Change B — new method (inside `class NavigatorAgent`, placed immediately before `private async doMultiAction(`)

```ts
  /**
   * GUIDE MODE (napi): pause the loop and wait for the user to do the step themselves.
   * v1: detect completion by the page URL changing. Times out after 2 minutes.
   * Requires the side panel to stay open (keeps the service worker alive).
   */
  private async waitForUserStep(timeoutMs = 120_000): Promise<boolean> {
    const page = await this.context.browserContext.getCurrentPage();
    const startTab = await chrome.tabs.get(page.tabId);
    const beforeUrl = startTab.url ?? '';
    logger.info('GUIDE MODE - waiting for user. Current URL:', beforeUrl);

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.context.paused || this.context.stopped) return false;
      await new Promise(resolve => setTimeout(resolve, 1500));
      try {
        const nowTab = await chrome.tabs.get(page.tabId);
        const nowUrl = nowTab.url ?? '';
        if (nowUrl && nowUrl !== beforeUrl) {
          logger.info('GUIDE MODE - user acted. URL changed:', beforeUrl, '->', nowUrl);
          return true;
        }
      } catch (e) {
        logger.warning('GUIDE MODE - could not read tab during wait', e);
      }
    }
    logger.warning('GUIDE MODE - timed out waiting for the user');
    return false;
  }
```

### Change C — the guide branch (inside `execute()`, replacing the single line `actionResults = await this.doMultiAction(actions);` that came right after the `// take the actions` comment)

```ts
      // take the actions
      if (GUIDE_MODE) {
        const nextGoal = modelOutput.current_state?.next_goal ?? '(no goal text)';
        logger.info('GUIDE MODE - step for user:', nextGoal);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_OK, `Your step: ${nextGoal}`);

        // spotlight the target element on the page (only if this step targets one)
        try {
          const step = actions[0];
          const actionName = Object.keys(step)[0];
          const actionInstance = this.actionRegistry.getAction(actionName);
          const targetIndex = actionInstance?.getIndexArg(step[actionName] as Record<string, unknown>);
          if (targetIndex !== null && targetIndex !== undefined) {
            const page = await this.context.browserContext.getCurrentPage();
            await page._updateState(this.context.options.useVision, targetIndex);
            logger.info('GUIDE MODE - spotlighting element index', targetIndex);
          }
        } catch (e) {
          logger.warning('GUIDE MODE - could not spotlight target', e);
        }

        // Stage 2: pause and wait for the USER to perform the step
        const userActed = await this.waitForUserStep();

        actionResults = [
          new ActionResult({
            extractedContent: userActed
              ? `user completed the step: "${nextGoal}"`
              : `timed out - user did not complete: "${nextGoal}"`,
            includeInMemory: true,
          }),
        ];
      } else {
        actionResults = await this.doMultiAction(actions);
      }
```

Everything after this (`this.context.actionResults = actionResults;` etc.) is unchanged.

### Git state

Branch `guide-mode`, pushed to `origin`. Commits (run `git log --oneline` to confirm current HEAD):

- Stage 1: guide-mode stub - intercept actions before execution
- Stage 2: guide mode pauses and waits for user action (URL-change detection)
- Stage 2: spotlight the target element while waiting for user

## 5. Current behaviour (guide mode is always on right now)

Per Navigator step:

1. LLM decides an action.
2. Guide branch runs instead of `doMultiAction`.
3. Emits `Your step: <next_goal>` as a `STEP_OK` event (shows in the panel as a plain status line, not a prominent card).
4. If the action has a target element index, calls `page._updateState(useVision, index)` -> that element is visually emphasized on the page. Confirmed working.
5. `waitForUserStep()` blocks: polls the tab URL every 1.5s for up to 2 min. Resolves `true` on URL change, `false` on timeout.
6. Returns a synthetic `ActionResult` (never `isDone: true`).
7. Loop continues; Planner eventually sets `done` and the task ends.

Tested end-to-end on `linear.app` with task "Go to the Pricing page": instruction shown, Pricing link
spotlighted, loop paused, user clicked Pricing, URL change detected, loop resumed and finished.

## 6. Known limitations / NOT done

1. **`GUIDE_MODE` is hardcoded `true`** — no auto-mode, no user toggle.
2. **Completion detection is URL-change only** — in-page clicks (dropdowns, modals, form fields,
   buttons that don't navigate) are NOT detected -> `waitForUserStep` times out after 2 min and the
   loop limps forward. Blocks flows like "create a LinkedIn post".
3. **No Checker** — nothing verifies the user did the *right* thing or that the real outcome happened.
   The Navigator's result is synthetic.
4. **MV3 service worker idle kill (~30s)** — the wait only survives because the side panel sends
   heartbeats. The side panel must stay open during a guided task.
5. **`maxActionsPerStep` is not forced to 1** — the LLM can still propose multiple actions;
   only `actions[0]` is used for the spotlight.
6. **Panel UI unchanged** — no progress bar, no "why?", no "waiting for you" state, no skill map.
7. **Weak free models** — `hy3` works but sometimes hallucinates stale context; Nanobrowser's
   prompt-injection guard logs `task_override` warnings (harmless).
8. **`page._updateState` is a semi-internal method** (underscore prefix). It works, but a cleaner
   highlight API (or Driver.js) would be better long-term.

## 7. Next steps (in order)

1. **Click detection for non-navigation steps.**
   - Look at `pages/content/src/` and how it messages the background.
   - When guide mode spotlights element `index`, also tell the content script to attach a one-shot
     listener to that element; on the user's real click, post a message to the background.
   - Add a message handler in `chrome-extension/src/background/index.ts`; have `waitForUserStep()`
     resolve on **either** that message **or** a URL change (race), whichever first.
2. **Make `mode` a real setting.**
   - Add `mode: 'auto' | 'guide'` to general settings in `packages/storage` (`generalSettingsStore`).
   - Add a toggle in `pages/options`.
   - Read it in `setupExecutor()` (`chrome-extension/src/background/index.ts`) and pass into
     `agentOptions`. Also set `maxActionsPerStep: 1` when `mode === 'guide'`.
   - In `navigator.ts`, replace `const GUIDE_MODE = true` with
     `const guideMode = this.context.options.mode === 'guide'`.
3. **Checker (Stage 3).** After `waitForUserStep` returns, verify the outcome:
   - Tier 2: compare current URL + key DOM against the step's expected state.
   - Tier 1 (later): call the flagship tool's API.
   - Return a real pass/fail; on fail, don't advance — trigger recovery.
4. **Panel:** render the step as a visible card + a "waiting for you" indicator.
   `pages/side-panel/src/SidePanel.tsx`.

## 8. Rules for the next developer (avoid mistakes)

- **Work on the `guide-mode` branch.** Never commit to `master` (pristine upstream).
- **All napi logic so far lives in one file:** `chrome-extension/src/background/agent/agents/navigator.ts`.
- **After any code change:** `pnpm build`, then reload the extension at `chrome://extensions`.
  Watch the "service worker" console for `GUIDE MODE` logs.
- **Keep the side panel open** while testing a guided task (service-worker keep-alive).
- **Do not delete `LICENSE`** (Apache-2.0 — required for building on Nanobrowser).
- **Model:** use `hy3` on the Kira provider.
- **`this.context.options`** holds `maxSteps`, `maxFailures`, `maxActionsPerStep`, `useVision`,
  `planningInterval` — thread a `mode` field through from `setupExecutor` here.
- The Executor loop and Planner are **unchanged** — don't modify `executor.ts` or `planner.ts`
  unless a step explicitly calls for it.
