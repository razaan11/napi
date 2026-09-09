console.log('content script loaded');

let stopWatchingTarget: (() => void) | null = null;

chrome.runtime.onMessage.addListener(message => {
  if (message?.type !== 'guide_watch_target' || typeof message.stepId !== 'string') return;

  stopWatchingTarget?.();

  const target = Array.from(document.querySelectorAll<HTMLElement>('[data-napi-guide-target]')).find(
    element => element.dataset.napiGuideTarget === message.stepId,
  );

  if (!target) return;

  const stepId: string = message.stepId;
  const mode: 'click' | 'value' = message.mode === 'value' ? 'value' : 'click';

  if (mode === 'value') {
    // Advance when the user has typed the expected text into the spotlighted field.
    const expected = String(message.expectedText ?? '')
      .trim()
      .toLowerCase();

    const onInput = (event: Event) => {
      if (!event.isTrusted) return;
      const el = target as HTMLInputElement & HTMLTextAreaElement;
      const current = String(el.value ?? el.textContent ?? '')
        .trim()
        .toLowerCase();
      if (expected.length > 0 && current === expected) {
        chrome.runtime.sendMessage({ type: 'guide_target_matched', stepId }).catch(() => {
          // The background worker may already have moved on.
        });
        stopWatchingTarget?.();
      }
    };

    target.addEventListener('input', onInput, { capture: true });

    stopWatchingTarget = () => {
      target.removeEventListener('input', onInput, { capture: true });
      stopWatchingTarget = null;
    };
    return;
  }

  // mode === 'click'
  const onClick = (event: MouseEvent) => {
    if (!event.isTrusted) return;

    chrome.runtime.sendMessage({ type: 'guide_target_clicked', stepId }).catch(() => {
      // The background worker may already have moved on.
    });

    stopWatchingTarget?.();
  };

  target.addEventListener('click', onClick, { capture: true });

  stopWatchingTarget = () => {
    target.removeEventListener('click', onClick, { capture: true });
    stopWatchingTarget = null;
  };
});
