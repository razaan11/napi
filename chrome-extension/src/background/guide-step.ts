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
  /**
   * 'click' = advance on a real click.
   * 'value' = advance when the field value matches expectedText exactly (the
   *   model already knows what to type — e.g. filling in known form data).
   * 'input' = advance the moment the field has ANY non-empty content — for
   *   free-form composing where the model has no expected text (a LinkedIn
   *   post, an email body, ...). Without this, a click_element step on an
   *   already-focused text field (nothing to click, the user just types)
   *   would never see a click event and time out even though the user did
   *   exactly the right thing.
   */
  mode: 'click' | 'value' | 'input';
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
