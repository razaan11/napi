/**
 * Holds the pending guide-step click while the Navigator waits.
 * Content scripts report clicks to background/index.ts, which resolves the
 * matching tab-and-step pair here.
 */
interface PendingGuideStep {
  tabId: number;
  resolve: () => void;
}

const pendingGuideSteps = new Map<string, PendingGuideStep>();

export function waitForGuideStepClick(tabId: number, stepId: string) {
  let resolveClick: (() => void) | undefined;

  const promise = new Promise<void>(resolve => {
    resolveClick = resolve;
  });

  if (!resolveClick) {
    throw new Error('Could not create guide-step click waiter');
  }

  pendingGuideSteps.set(stepId, { tabId, resolve: resolveClick });

  return {
    promise,
    cancel: () => pendingGuideSteps.delete(stepId),
  };
}

export function notifyGuideStepClick(tabId: number, stepId: string): boolean {
  const pendingStep = pendingGuideSteps.get(stepId);

  if (!pendingStep || pendingStep.tabId !== tabId) {
    return false;
  }

  pendingGuideSteps.delete(stepId);
  pendingStep.resolve();
  return true;
}

export interface GuideStepWatch {
  /** 'click' = advance on a real click; 'value' = advance when the field value matches expectedText. */
  mode: 'click' | 'value';
  expectedText?: string;
}

/** Tell every injected page frame to watch for this step's marked target. */
export async function watchGuideStepTarget(
  tabId: number,
  stepId: string,
  watch: GuideStepWatch = { mode: 'click' },
): Promise<void> {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const frameIds = frames.map(frame => frame.frameId);

  await Promise.all(
    frameIds.map(async frameId => {
      try {
        await chrome.tabs.sendMessage(
          tabId,
          { type: 'guide_watch_target', stepId, mode: watch.mode, expectedText: watch.expectedText },
          { frameId },
        );
      } catch {
        // Content scripts cannot run in some restricted frames.
      }
    }),
  );
}
