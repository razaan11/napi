import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';

console.log('content script loaded');

let stopWatchingTarget: (() => void) | null = null;

// napi — Driver.js draws the guide-mode spotlight: dims the whole page and
// cuts a highlight around the target element, with a small popover showing
// the instruction. Replaces the plain colored-box highlight buildDomTree.js
// draws for the marked element with something that actually reads as a
// guided tutorial step (buildDomTree.js's own highlighting is untouched —
// it's still needed for the model's own understanding of the page).
//
// Known limitation, same root cause as the buildDomTree.js dialog fix: a
// native <dialog> shown via showModal() (LinkedIn's post composer, for one)
// renders in the browser's "top layer", above the whole document regardless
// of z-index — Driver.js appends its overlay to document.body like most
// libraries do, so it could end up hidden behind such a dialog the same way
// buildDomTree.js's highlight was before that fix. Not addressed here; watch
// for it on dialog-heavy sites and apply the same reparenting approach if so.
const spotlightDriver = driver({
  allowClose: false,
  showButtons: [],
  overlayOpacity: 0.55,
  stagePadding: 4,
  stageRadius: 6,
});

function showSpotlight(target: HTMLElement, label?: string) {
  try {
    spotlightDriver.highlight({
      element: target,
      popover: label ? { description: label } : undefined,
    });
  } catch {
    // A spotlight-drawing failure should never break step detection itself.
  }
}

function hideSpotlight() {
  try {
    spotlightDriver.destroy();
  } catch {
    // ignore
  }
}

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
  const label: string | undefined = typeof message.label === 'string' ? message.label : undefined;

  showSpotlight(target, label);

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
      hideSpotlight();
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
    hideSpotlight();
    stopWatchingTarget = null;
  };
});
