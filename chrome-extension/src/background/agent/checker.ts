/**
 * napi Stage 3 — the Checker.
 *
 * After the user performs a guided step, decide whether the intended outcome
 * actually happened, before letting the loop advance.
 *
 * v1 = Tier 2 only (structural, no LLM call, no per-tool API):
 *   - the user never acted (timeout)        -> NOT verified
 *   - typing step, value already matched     -> verified
 *   - the page navigated or visibly changed  -> verified
 *   - a click produced no detectable change  -> NOT verified
 *
 * Tier 1 (call the flagship tool's API) and Tier 3 (screenshot -> vision model)
 * are added later; keep this function's shape stable so they can slot in.
 */

export interface CheckResult {
  verified: boolean;
  reason: string;
}

interface PageLike {
  url?: string;
  selectorMap?: { size: number } | null;
}

/** Cheap fingerprint of a page: URL + count of interactive elements. */
export function stepSignature(state: PageLike | null | undefined): string {
  const url = state?.url ?? '';
  const count = state?.selectorMap?.size ?? 0;
  return `${url}::${count}`;
}

export function verifyStep(params: {
  actionName: string;
  userActed: boolean;
  before: PageLike | null | undefined;
  after: PageLike | null | undefined;
}): CheckResult {
  const { actionName, userActed, before, after } = params;

  if (!userActed) {
    return { verified: false, reason: 'no action was detected within the time limit' };
  }

  // The typing watcher only resolves once the field value already matches the
  // expected text, so a detected input_text step is verified by definition.
  if (actionName === 'input_text') {
    return { verified: true, reason: 'typed text matches the expected value' };
  }

  const beforeUrl = before?.url ?? '';
  const afterUrl = after?.url ?? '';
  if (afterUrl && afterUrl !== beforeUrl) {
    return { verified: true, reason: 'the page navigated as expected' };
  }

  if (stepSignature(before) !== stepSignature(after)) {
    return { verified: true, reason: 'the page changed after the step' };
  }

  return {
    verified: false,
    reason: 'the page did not change after the step, so it may not have worked',
  };
}
