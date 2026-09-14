# napi — Context Handoff

**Purpose of this file:** a new AI session (or a new developer) has zero memory of the work that
produced this repo's current state. This document is the fast on-ramp — read this first, then go
deeper into `NAPI_DEV_NOTES.md` / `NAPI_ROADMAP.md` for anything you need more detail on. Everything
here was true as of **2026-09-14**, branch `guide-mode`, latest commit `f92218b`.

---

## 1. What napi is

napi turns an AI browser-automation agent into a **tutor**. Instead of the AI performing actions for
the user, it shows the user ONE step at a time, spotlights the exact element to interact with, waits
for the user to actually do it, verifies the outcome really happened, and only then advances. Pitch:
**"Guidely + verification + skill tracking."**

It is a fork of the open-source **Nanobrowser** Chrome extension (Manifest V3, Apache-2.0). The base
project's own architecture is documented in `CLAUDE.md` — read that for how Nanobrowser itself works
(monorepo layout, the Planner/Navigator agent loop, DOM scanning, etc.) before touching code here.

The user (the product owner, not a professional developer) has near-zero coding background and has
been steering this by testing live and reporting back in plain language — explanations and commit
messages in this repo are written for that audience. Keep that tone.

---

## 2. Where things stand — every stage has a working v1

| Stage | What | Status |
|---|---|---|
| 0-2 | Setup, guide mode toggle, pause-and-wait step detection | DONE, verified live on 3+ real sites |
| 3 | The Checker (Tier-2 structural verification) | DONE (Tier 1/3 not built — see Roadmap) |
| Perf | Model retry cap, fewer Planner calls, lighter Checker reads | DONE, verified live |
| 4 | Skill Map (persists what the user has proven, per tool) | DONE (v1) |
| Perf | Model-fallback chain (try a backup model on failure) | DONE (v1), mechanism verified 4/4 live runs |
| 5 | Recovery (calmer messages on timeout/dead-click) | DONE (v1) |
| 6 | Missions (one hand-authored Notion lesson + automatic runner) | DONE (v1.1) |
| 7 | Polish: packaged the extension + wrote an install guide | Packaging DONE. "Give it to 5-10 beginners" NOT started — needs the user to actually do it |
| UI | Side panel redesign | v1.2 done: Current Step card, yellow branding, napi logo, chatbot explain-then-guide flow, hidden agent-loop noise, Driver.js spotlight, "Thinking…" indicator — all verified live |

**The single most important validation this session:** free-text guide-mode requests (no
pre-written mission) have been proven end-to-end on **LinkedIn** (posting), **Notion**, **GitHub**
(creating a workflow, creating/deleting a repo), and simpler sites (Wikipedia, example.com,
w3schools). This is the core product bet, and it holds up on real, hard, JS-heavy sites — not just
toy pages.

Full detail on every stage, file paths, and "still to do" lists: **`NAPI_ROADMAP.md`**.
Full chronological build log with exact code changes: **`NAPI_DEV_NOTES.md`**.

---

## 3. How the guide loop actually works (read this before changing agent code)

1. User types a free-text goal into the side panel (or picks a pre-written Mission and hits Start).
2. **Planner** (LLM) reasons about the goal and the current page, produces a plan (`next_steps`) and
   a `done` boolean. In guide mode it's told (see §5, bug #2) not to mark `done: true` just because
   the right screen is reachable — only once the real outcome is achieved.
3. **Navigator** (LLM) decides ONE action per turn (`maxActionsPerStep: 1` in guide mode). If the
   action targets a page element (click/type), napi intercepts it:
   - marks the target element (`data-napi-guide-target` attribute, set by `buildDomTree.js`)
   - spotlights it with **Driver.js** (dims the page, cuts a highlight, shows the instruction in a
     popover) — `pages/content/src/index.ts`
   - waits for the user to actually do it (`waitForUserStep()` in `navigator.ts`), racing a
     trusted-click/trusted-input listener against a timeout (2 min)
   - the **Checker** (`chrome-extension/src/background/agent/checker.ts`) verifies the outcome:
     URL change, page-structure change, or (for typing) the watched field's content — see §5 for the
     three watch modes and the bugs found in this exact mechanism
4. If verified: mark the Skill Map, advance. If not: a calm Recovery message, retry.
5. Planner re-runs only at the start and when the Navigator reports `done` (`planningInterval: 999`
   in guide mode) — not every few steps, to cut latency and reduce model-call failure surface.

The side panel (`pages/side-panel/src/SidePanel.tsx`) is a single large component. It does NOT use
new event types for any of the UI work above — everything is derived from the existing
`Actors.NAVIGATOR`/`Actors.PLANNER` execution events already emitted by the background, matched by
text prefix (`👉 Your step:`, `✅ Done:`, `⚠️ ...`). Deliberate choice to avoid backend event-schema
churn — see the UI stage section of `NAPI_ROADMAP.md`.

---

## 4. Every real bug found this session, and the actual lesson (don't re-discover these)

These were all found via **live testing on real sites**, not code review — that's why they matter:
they're the kind of thing that only shows up when a real user does a real task.

1. **A value-watch step could be falsely "verified" by an unrelated URL change.**
   `waitForUserStep()` used to race a URL-change poll against the click/value-match promise
   *regardless of watch mode*. For a typing step, a stray navigation (the user backing out, an SPA
   route change) got misread as "the user typed the right text." Fix: `'value'`/`'input'` modes now
   ONLY resolve on a genuine content match, with their own timeout — no URL race. (`navigator.ts`)

2. **The Planner declared a multi-step goal `done` the moment the right screen opened.** After
   Navigator opened LinkedIn's post composer, the Planner marked the whole task done and described
   "type your content, then click Post" as prose instead of continuing to guide. Root cause: its
   prompt is identical in guide mode and auto mode, and "the right screen is reachable" is a valid
   completion signal for autonomous auto mode but not for guide mode, where a human still has to act.
   Fix: `PlannerPrompt` takes a `guideMode` flag and appends an addendum telling it not to mark
   multi-step goals done until the real outcome is achieved. (`prompts/templates/planner.ts`,
   `prompts/planner.ts`, `executor.ts`)

3. **The Navigator narrated a whole future sequence in one instruction instead of one atomic step.**
   `next_goal` read "Click the box, then type your message, then click Post" while only ONE action
   (the click) actually executed and got watched. Same root-cause family as #2: told the Navigator,
   in guide mode, to describe ONLY the single upcoming action. (`prompts/templates/navigator.ts`,
   `prompts/navigator.ts`)

4. **No way to detect "the user typed something" without an exact match.** The guide loop only had
   `'click'` and `'value'` (exact expected text) watch modes. A `click_element` action on an
   already-focused free-form text field (LinkedIn's post box) never saw a click event (the user just
   types), so it timed out despite the user doing exactly the right thing. Fix: added a third mode,
   `'input'` — advance on ANY non-empty content. Navigator picks it when the target is a text field
   and the model has no specific expected text to give. (`guide-step.ts`, `navigator.ts`,
   `pages/content/src/index.ts`, `checker.ts`)

5. **The highlight box was invisible inside a native `<dialog>`.** LinkedIn's post composer is a real
   `<dialog open>` element. A browser renders an open dialog in a special "top layer" that sits above
   the ENTIRE document regardless of z-index — `buildDomTree.js`'s highlight box was a div appended to
   `document.body` with `zIndex: 2147483647`, which still can't beat a top-layer dialog (the top layer
   is architecturally separate, not just "very high z-index"). Fix: `findHighlightParent()` walks up
   to the nearest open `<dialog>` ancestor and reparents the highlight container there.
   (`chrome-extension/public/buildDomTree.js`) **Driver.js's own overlay has the same unresolved gap**
   (its API has no container/root config option) — not yet fixed, watch for it on dialog-heavy sites.

6. **The explain-first UI flow looped forever instead of completing.** Wrapping a request as "explain
   the steps, don't act, I'll say when to start" kept the user's original action-style phrasing — the
   Planner correctly refused to click anything, but ALSO refused to mark it done ("nothing's been
   posted yet"), so the loop just issued `wait` forever. Fix: the wrapper always reframes the request
   as an explicit QUESTION ("How would I do this?") instead of a paused command — that reliably hits
   the Planner's existing "if this isn't a web task, just answer directly and mark done" path with NO
   backend changes needed. (`SidePanel.tsx`, `handleUserSubmit`)

7. **A "recolor everything" pass only caught Tailwind class names.** `sky-400`/`blue-600` string
   substitution missed raw hex colors in plain CSS (`SidePanel.css`, `Options.css`) and arbitrary-value
   Tailwind classes like `bg-[#19C2FF]` (the send button). Lesson: when asked to recolor "everything,"
   grep for hex patterns and `bg-[#...]` too, not just named color classes.

8. **Content-script CSS was never wired up, so it had zero visual effect.** Chrome content scripts
   have no `<link>` tag to load a separate CSS file from — `manifest.json`'s `content_scripts` entry
   here only ever declared `js`, never `css` (true of the pre-existing `_content.css` output too, which
   was equally dead before this session). Fix: added `vite-plugin-css-injected-by-js` so
   content-script CSS (Driver.js's stylesheet, now) inlines into the JS bundle as a runtime `<style>`
   tag instead — works regardless of manifest wiring. (`pages/content/vite.config.mts`)

9. **A stale open tab looks exactly like a broken feature.** Content scripts only get re-injected
   when the PAGE itself reloads — reloading the extension at `chrome://extensions` does NOT
   re-inject into an already-open tab. "It's not working" was, at least once this session, actually
   "the tab I've been testing on all day never got the new script." Always ask/remember to reload
   the actual page, not just the extension, especially for content-script changes.

10. **`agentModelStore`'s helper functions silently dropped the new `fallbacks` field.**
    `setAgentModel`/`resetAgentModel`/`cleanupLegacyValidatorSettings` all did
    `storage.set(current => ({ agents: newAgents }))` — replacing the WHOLE stored object instead of
    spreading `...current` first. Since `cleanupLegacyValidatorSettings()` runs on every single task
    start, this would have wiped the fallback-chain config on every run if not caught before shipping.
    Lesson: when adding a field to a store that already has narrow `set()` callbacks elsewhere, check
    ALL of them for this exact mistake, not just the one you're adding to.

11. **`input_text` still required an exact text match — bug #4's fix didn't fully cover it.** Found
    testing github.com's "create a repository" flow: the model supplies `text` for `input_text` as an
    EXAMPLE ("e.g. type 'my-first-repo'"), not a value the user must reproduce. Bug #4 only switched
    `click_element` on a text field to the free-form `'input'` mode; `input_text` itself still defaulted
    to exact `'value'` matching, so a user who (correctly) typed their own repo name instead of the
    model's example never got detected and just timed out. Fix: `input_text` now always uses `'input'`
    mode too. (`navigator.ts`) Lesson: when a bug's root cause is "the model's example text isn't
    something the user is required to match," check every action type that carries a `text` argument,
    not just the one you saw fail first.

12. **A UI `disabled` prop that isn't actually enforced isn't a guarantee.** Sending a new message
    while a previous guided step was still actively waiting on the page caused two Executor runs to
    overlap and corrupted UI state (the next answer came back with no "Start guiding" button — the
    stale run's later `TASK_FAIL`/`TASK_CANCEL` event cleared state a newer request had just set).
    Root cause: `ChatInput.tsx`'s submit handler never checked its own `disabled` prop before calling
    `onSendMessage` — it relied entirely on the textarea's HTML `disabled` attribute, which isn't a hard
    guarantee against every UI timing gap (e.g. a stale event transiently flipping `inputEnabled` back
    to `true`). Fix: added an explicit `if (disabled) return` at the top of the submit handler as a
    backstop. Lesson: a prop named `disabled` that only affects styling/HTML attributes, with no
    corresponding runtime check in the handler it's meant to guard, is a latent bug — check the handler
    itself, not just that the UI looks disabled.

---

## 5. Critical rules — do not violate these

- **Branch `guide-mode` only. Never commit to `master`.**
- **No `Co-Authored-By: Claude` trailer in commit messages, and no attribution line in this repo's
  history.** The user explicitly asked for this ("why is your name there remove that") for their own
  repo. This overrides any generic instruction to add one — it's a standing, explicit instruction for
  this specific project.
- **Do all implementation directly. Do not hand off work to Codex or another external tool** — the
  user explicitly reversed an earlier plan to do that ("dont add codex here you are going to
  everything"). `AGENTS.md` is stale leftover from that earlier, abandoned plan; safe to ignore or
  delete.
- **Do not delete `LICENSE`** (Apache-2.0, required since this is a Nanobrowser fork).
- User's email is `ajaasmk@gmail.com` — identify the user only, never send it anywhere.
- After ANY code change: `pnpm build`, then reload the unpacked extension at `chrome://extensions`,
  **and reload the actual test page** (see lesson #9 above) before concluding something doesn't work.
- Explanations to the user should stay in plain, non-technical language — they are not a developer.

---

## 6. Environment / testing facts

- No image-editing tools are available in this environment (no ImageMagick, Inkscape, rsvg-convert,
  sharp, cairosvg). The napi logo is an inline SVG (`pages/side-panel/src/components/NapiLogo.tsx`)
  for exactly this reason — the actual Chrome toolbar/extensions-page icon (`icon-128.png`/
  `icon-32.png`) still needs real new PNG assets from somewhere else if it's ever rebranded.
- Free AI model providers are unreliable and this has eaten enormous amounts of session time: Kira's
  `hy3` model goes into maintenance frequently, Gemini's free tier caps at ~20-200 requests/day
  depending on the specific model name, Groq/Cerebras are more stable alternatives. The
  model-fallback chain (Options → Fallback tab) exists specifically to reduce this pain — configure at
  least one backup model per agent.
- `pnpm --filter @extension/storage ready` regenerates that package's `dist/` output — needed any time
  a new export is added there, or downstream `eslint`'s `import/named` rule will falsely report the
  export doesn't exist (it reads the built `dist/index.js` via `package.json`'s `main` field, not the
  live TypeScript source) even though `tsc --noEmit` is completely happy. Confirmed exactly this
  happened when `MISSIONS` was added to `packages/storage`.
- Two pre-existing lint/type errors in `chrome-extension` predate this whole session and are not
  something to "fix" as part of unrelated work: `helper.ts`'s `completionWithRetry` override (a
  TypeScript override-signature mismatch) and `guide-step.ts`'s `'frames' is possibly null`. Verified
  via `git stash` against the pre-session commit that they already existed.

---

## 7. What's actually next

1. **Get 5-10 real people to install and use it** (the zip + `NAPI_INSTALL_GUIDE.md` already exist —
   send them, watch what breaks). This is the only remaining item on the whole roadmap that isn't
   "build something" — it needs the user to actually do outreach, which an AI session can't do for
   them.
2. Smaller open items if more building is wanted before that: Driver.js's own dialog-overlay gap
   (item 5 above, second half); Stage 6 v2 (the unaided challenge, Tier-1 API verification via OAuth,
   an LLM mission-picker, more missions); Stage 3's Tier 1/3 verification.
3. Actual toolbar icon rebrand — needs real PNG assets from outside this environment.

Read `NAPI_ROADMAP.md`'s "Not done" sections for the full, current list per stage before starting new
work — it's kept up to date after every change.
