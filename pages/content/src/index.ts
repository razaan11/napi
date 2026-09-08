console.log('content script loaded');

let stopWatchingTarget: (() => void) | null = null;

chrome.runtime.onMessage.addListener(message => {
  if (message?.type !== 'guide_watch_target' || typeof message.stepId !== 'string') return;

  stopWatchingTarget?.();

  const target = Array.from(document.querySelectorAll<HTMLElement>('[data-napi-guide-target]')).find(
    element => element.dataset.napiGuideTarget === message.stepId,
  );

  if (!target) return;

  const onClick = (event: MouseEvent) => {
    if (!event.isTrusted) return;

    chrome.runtime.sendMessage({ type: 'guide_target_clicked', stepId: message.stepId }).catch(() => {
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
