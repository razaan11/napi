# Agent context

This repo is **napi** — a fork of Nanobrowser being modified into a "learning by doing" guide.

Read these before making changes:

1. `NAPI_DEV_NOTES.md` — what napi is, every change made so far, current state, known
   limitations, and rules to avoid mistakes. **Start here.**
2. `NAPI_ROADMAP.md` — all remaining work, stage by stage, with file pointers and
   "done when" criteria.
3. `CLAUDE.md` — Nanobrowser's own architecture / dev doc (the base project).

Key facts:

- Active branch: `guide-mode`. Do not commit to `master`.
- All napi changes so far are in `chrome-extension/src/background/agent/agents/navigator.ts`.
- Build: `pnpm build` -> `dist/`. Reload the unpacked extension in `chrome://extensions` after each build.
- Watch the "service worker" console at `chrome://extensions` for logs.
- Model: `hy3` on a Custom/OpenAI-Compatible provider pointed at `https://kiraai.vn/api/v1`.
- Scope right now is Phase 1 (online, web apps). Phase 2 (offline/desktop) is not started.
