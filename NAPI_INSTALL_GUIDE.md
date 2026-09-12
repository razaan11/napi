# napi — Install & First Run Guide

napi turns an AI browser assistant into a **tutor**: instead of doing things for you, it shows you
one step at a time, highlights exactly what to click, waits for you to do it, and checks that it
actually worked before moving on.

This build is a fork of the open-source **Nanobrowser** extension — you'll still see "Nanobrowser"
as the extension's name in Chrome for now (a visual rebrand comes later); everything described here
is napi's guided-learning layer built on top of it.

---

## 1. What you need

- **Google Chrome** or **Microsoft Edge** (any recent version)
- An API key from at least one AI provider. Free options that work today:
  - **Groq** — `console.groq.com` — free, no card, generous daily limit
  - **Google Gemini** — `aistudio.google.com` — free tier (daily limit resets each day)
  - Any other provider you already have a key for (OpenAI, Anthropic, DeepSeek, etc. also work)

You do **not** need to pay for anything to try napi.

---

## 2. Install the extension

1. Unzip the file you were given (`extension-<date>.zip`) into a folder you'll keep around — don't
   delete it after installing, Chrome needs the files to stay in place.
2. Open Chrome and go to `chrome://extensions`
3. Turn on **Developer mode** (top-right toggle)
4. Click **Load unpacked**
5. Select the folder you unzipped (the one containing `manifest.json`)
6. The extension icon should now appear in your toolbar

---

## 3. First-time setup (one time only)

1. Click the extension icon → **Settings** (gear icon), or right-click the icon → **Options**
2. Go to the **Models** tab
3. Add a provider: paste in your API key (from Groq, Gemini, etc.)
4. Assign a model to the **Navigator** agent (this is the one that reads pages and acts) — pick any
   model from the provider you just added
5. Optionally assign a model to the **Planner** agent too (if you skip this, it reuses the Navigator's)
6. Go to the **General** tab → turn **Guide mode** ON
   - Guide mode ON = napi shows you each step and waits for you
   - Guide mode OFF = the AI does everything itself (the original Nanobrowser behavior)

Reload the extension (`chrome://extensions` → the reload icon) after saving settings the first time.

---

## 4. Using it

1. Open any website you want help with
2. Click the extension icon to open the side panel
3. Type what you want to do in plain English — e.g. `How do I create a new page in Notion?` or
   `Guide me to post on LinkedIn`
4. napi will highlight the first thing to click. Do it yourself — napi is watching, not acting for you
5. Once it confirms that step worked, it shows you the next one
6. Keep going until the task is done

**Tip:** keep instructions specific and single-purpose ("Click the Post button") rather than vague
("help me with LinkedIn") — the more concrete the ask, the more reliably napi can guide you.

There's also a **Missions** tab in the side panel with a pre-written, ready-to-run lesson (currently:
"Create a new page in Notion") — open it and press **Start** to have napi walk you through it
automatically, step by step.

---

## 5. Known limitations (so you're not surprised)

- **Free AI models can be unreliable.** They sometimes go down or hit daily limits. napi will
  automatically try a backup model if you've set one up (Options → Fallback tab) — otherwise it'll
  tell you clearly when a model fails, rather than hanging.
- **Some complex sites need a moment.** Heavy pages (LinkedIn, Notion, etc.) take a bit longer per
  step than simple ones — this is expected.
- **This is an early build.** You may hit rough edges. If something doesn't work the way this guide
  describes, that's useful to know — see below.

---

## 6. Something not working?

Note what you were trying to do, what napi did instead, and (if you can) open the browser's
developer console (`chrome://extensions` → napi → "service worker" → Inspect) to copy any error
text you see there. That detail is what makes a bug fixable.
