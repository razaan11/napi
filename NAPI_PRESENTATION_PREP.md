# napi — Presentation Prep: Likely Questions & Simple Answers

Read this before presenting to your guide. Questions are grouped by angle. Answers are written the
way you'd say them out loud — plain language, no jargon you'd have to explain first.

---

## A. The Big Picture

**Q: What is napi, in one sentence?**
> An AI browser extension that teaches you to use a website by watching you actually do it — it
> shows you what to click, waits for you to click it, and checks you did it right, instead of doing
> the task for you.

**Q: Who is this for?**
> Anyone learning a new tool or website. Instead of reading docs or watching a video, you learn by
> doing the real steps with an AI coach standing next to you.

**Q: How is this different from just asking an AI agent to do the task for me?**
> Most AI browser agents (including the tool this is built on) do the whole task automatically. napi
> deliberately does NOT do it for you — it makes you do every click, because the point is that you
> learn the skill, not that the task gets finished.

**Q: Why does this matter — what's the actual gap it fills?**
> There's a gap between "AI does it for you" tools (you learn nothing) and "watch a tutorial video"
> tools (no feedback, no proof you actually did it). napi is guided, verified practice — you get
> proof, step by step, that you can actually do the thing.

**Q: Is this a brand-new product, or built on something else?**
> It's built on top of an existing open-source project called Nanobrowser — a free AI browser-agent
> Chrome extension. Instead of spending months building the "browser automation" engine from scratch,
> I forked it and added the "guide and verify" layer on top. Reusing solid existing infrastructure and
> putting my own work into what's actually new is a normal, smart way to build.

---

## B. How It Works (technical, kept simple)

**Q: Walk me through what happens step by step when I use it.**
> 1. You type what you want to do, in plain English, into the side panel.
> 2. One AI (the "Planner") works out the general plan.
> 3. A second AI (the "Navigator") looks at the actual webpage and decides the single next thing to
>    do.
> 4. Instead of clicking it automatically, napi highlights that exact spot on the page and waits.
> 5. You do it yourself.
> 6. napi checks the page to confirm it actually worked.
> 7. It shows you the next step.

**Q: Which file did you add the "guide" layer in?**
> The core of it is one file: `chrome-extension/src/background/agent/agents/navigator.ts`. That's
> where napi steps in front of the AI's decision and, instead of letting it act automatically, shows
> it to the user and waits for them.

**Q: How does napi know I actually did the step, and not something random?**
> Two checks. First, it only accepts a genuine click or keystroke — a script pretending to click
> doesn't count, only real input does. Second, after you act, it checks that the right thing actually
> happened: either the page navigated, the page's content changed, or (for typing) what you typed
> matches what was expected.

**Q: Where does the verification logic live?**
> A separate, small file called `checker.ts`. It's deliberately simple — a checklist function, not
> another AI call — so checking is instant and doesn't cost extra API usage.

**Q: How does napi decide what to highlight?**
> A script called `buildDomTree.js` scans the live webpage and numbers every clickable or typeable
> thing on it. The AI picks a number, and napi highlights whatever is behind that number using a
> highlighting library called Driver.js — the same style of spotlight-and-popover you see in app
> onboarding tours.

**Q: What AI models does it use — is it locked to one company?**
> No — you bring your own key from whichever AI provider you want: OpenAI, Google Gemini, Anthropic
> Claude, Groq, and others. You can also set up a backup model, so if your main one is down or over
> its limit, napi automatically switches to the backup instead of failing.

**Q: Does this run in the cloud, or on my computer?**
> It's a Chrome extension — everything runs inside your own browser. The only thing that leaves your
> computer is your typed request and the page's content, sent to whichever AI provider you chose —
> exactly like using ChatGPT normally.

**Q: How does it remember what I've learned?**
> There's a "Skill Map" — every time you finish a guided step, napi quietly records: this site, this
> action, done with guidance. Over time that builds into a record of what you've actually practiced.

**Q: What's a "Mission"?**
> A pre-written lesson for one specific task — like a lesson plan someone wrote in advance (e.g.
> "Create a page in Notion"). One example mission exists today. You don't need a mission to use
> napi, though — typing any request in plain English works too, on any site.

---

## C. Reliability & Testing

**Q: How much have you actually tested this?**
> Live, on real, complex websites — not just simple demo pages. Successfully guided a real post on
> LinkedIn, a page creation in Notion, and a workflow setup on GitHub, using nothing but a typed
> request each time.

**Q: What bugs did you actually find?**
> A few real examples: the AI sometimes decided a task was "done" the moment the right screen opened,
> before the actual action happened. A highlight box was invisible inside certain pop-up windows,
> because of how browsers stack layered content. Detecting that someone typed something didn't work
> for open-ended text like a social media post. All of these were found by testing on real sites and
> fixed.

**Q: What happens if the AI makes a mistake, or the step doesn't work?**
> napi shows a calm "let's try that again" message instead of just failing silently or saying "you
> did it wrong." If it keeps failing, it stops cleanly instead of getting stuck.

**Q: What if the AI service itself goes down or is slow?**
> If you've set up a backup model, napi automatically switches to it. Either way, a broken AI call now
> fails within seconds instead of hanging for minutes — that used to be a real problem before I fixed
> it.

**Q: Is this ready for real users?**
> The core mechanics are proven on hard, real websites. What hasn't happened yet is testing with
> actual beginners — people who aren't me — to see where they personally get confused. That's the
> planned next step.

**Q: This feels slow — how are you going to speed it up?**
> Some of that is already fixed, some is a real next step.
>
> Already done: a broken AI call used to hang for up to 12 minutes before giving up — now it fails in
> seconds. I also cut the number of AI calls per step nearly in half by not re-asking the "planning"
> AI to re-check its plan after every single step, only at the start and the end. And the "did it
> work" check now skips re-scanning the whole page when a much quicker check already answers the
> question.
>
> What's left, in order of impact:
> 1. **The AI model you use is the single biggest factor.** Free models are the slow ones — a faster
>    (usually paid) model would speed up most of what's left, since each step still needs at least one
>    AI call and that call's speed is mostly out of my hands.
> 2. **Send the AI less to think about.** Right now it reads a good chunk of the page's content every
>    step. Trimming that down to just what's relevant means a faster reply and a cheaper one.
> 3. **Use more pre-written Missions.** A Mission already has its steps written down, so it skips the
>    "figure out the plan" AI call entirely — that's the fastest path there is. Right now there's only
>    one example Mission; writing more removes a whole AI call for anything that has one.
>
> Worth being upfront about: some slowness will always exist as long as a real AI call has to happen
> before every step — that's not something more code alone fixes, it's a trade-off of using AI at all.

---

## D. Skeptical / Challenge Questions

**Q: Isn't this just Guidely (or a browser "record a tour" feature) with AI added on top?**
> The key difference is verification. Most guided-tour tools just replay a fixed script — click here,
> click here — with no idea whether you actually did it. napi checks the real page after every step to
> confirm it worked, and it works on any website from a typed request, not only sites someone
> pre-recorded a script for.

**Q: What if I don't have an AI account?**
> You need a free API key from one AI provider — several offer free tiers at no cost, but you do need
> to create one, the same as signing up for any AI tool.

**Q: Why not just make a screen-recording tutorial instead?**
> A recording is static — it can't tell if you actually followed along, and it breaks the moment the
> website's layout changes. napi reads the real, live page every time, so it adapts if a button moves.

**Q: What does this actually cost to run?**
> Free if you use a free-tier AI model. Faster or more capable models from the same providers usually
> cost a small amount per use, same as any AI tool.

---

## E. What's Left / Roadmap

**Q: What's not built yet?**
> Getting it in front of real test users is the main remaining item. Smaller things: connecting
> directly to an app's own official records (e.g. actually confirming via Notion's real account data,
> not just watching the page), writing more pre-made lessons beyond the one example, and a full visual
> rebrand — right now some of the original open-source project's name/icon is still visible in places.

**Q: What's the biggest risk to this becoming a real product?**
> Two things. One: free AI models are unreliable — slow, rate-limited, sometimes down — which is why
> the backup-model feature exists, but it's still a real dependency. Two: this has only been tested by
> me so far; real, non-technical users might get stuck in ways I haven't seen yet, and that's only
> found by actually giving it to people.

**Q: How long did this take?**
> Built and tested over several focused sessions, adding one capability at a time and testing live on
> a real site after almost every change, rather than building everything first and testing at the end.
