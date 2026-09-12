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
  const mode: 'click' | 'value' | 'input' =
    message.mode === 'value' ? 'value' : message.mode === 'input' ? 'input' : 'click';

  if (mode === 'value' || mode === 'input') {
    // 'value': advance when the user has typed the EXACT expected text (the model
    // already knows what belongs here — e.g. known form data).
    // 'input': advance the moment the field has ANY non-empty content — for
    // free-form composing where there's no expected text to match (a post,
    // an email body, ...).
    const expected = String(message.expectedText ?? '')
      .trim()
      .toLowerCase();

    const onInput = (event: Event) => {
      if (!event.isTrusted) return;
      const el = target as HTMLInputElement & HTMLTextAreaElement;
      const current = String(el.value ?? el.textContent ?? '')
        .trim()
        .toLowerCase();
      const satisfied = mode === 'input' ? current.length > 0 : expected.length > 0 && current === expected;
      if (satisfied) {
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
