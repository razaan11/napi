// napi Stage 6 — hand-authored missions.
//
// A mission is an ordered script of single, bounded instructions — the same
// shape as any task typed into the chat ("Click the X button", "Type Y").
// The mission runner (side panel) sends each step to napi automatically, one
// after another, waiting for each to finish before sending the next — every
// step still goes through the normal guide loop, Tier-2 Checker, Recovery
// messaging, and Skill Map recording, exactly like a task you typed yourself.
//
// Deliberately NOT built yet (real Stage 6 v2 work):
// - The end-of-mission "unaided challenge" (do it again with no hints,
//   verified) that's what actually unlocks a Skill Map skill's `unaided`
//   status — see packages/storage/lib/skillMap.
// - Tier-1 verification via Notion's real API (OAuth) instead of just the
//   on-page Checker.
// - An LLM that maps a free-text goal to the right mission automatically.
//
// These step instructions are a first draft based on Notion's known web UI
// patterns (the sidebar "+ New page" control, etc.) — Notion's UI does
// change over time, so validate/tune the wording against your real account
// the same way every other feature this session got tested, then adjust.

export interface MissionStep {
  instruction: string;
  why: string;
}

export interface Mission {
  id: string;
  tool: string; // matches toolFromUrl()'s hostname convention, e.g. "www.notion.so"
  title: string;
  description: string;
  steps: MissionStep[];
}

export const MISSIONS: Mission[] = [
  {
    id: 'notion-create-a-page',
    tool: 'www.notion.so',
    title: 'Create a new page in Notion',
    description:
      'The first thing anyone needs to do in Notion. Open a fresh, blank page, give it a title, and add ' +
      'a line of content — the building block every other Notion feature sits on top of.',
    steps: [
      {
        instruction: "Click the '+ New page' button in the left sidebar",
        why: 'This is the fastest way to start a new page from anywhere in Notion.',
      },
      {
        instruction: 'Type a title for your page, then press Enter',
        why: 'Every page needs a title. Pressing Enter locks it in and moves you into the page body.',
      },
      {
        instruction: 'Type a line of text in the page body',
        why: 'This confirms the page is ready to use — Notion pages are a blank canvas until you add something.',
      },
    ],
  },
];
