import { z } from 'zod';
import { BaseAgent, type BaseAgentOptions, type ExtraAgentOptions } from './base';
import { createLogger } from '@src/background/log';
import { ActionResult, type AgentOutput } from '../types';
import type { Action } from '../actions/builder';
import { buildDynamicActionSchema } from '../actions/builder';
import { agentBrainSchema } from '../types';
import { type BaseMessage, HumanMessage } from '@langchain/core/messages';
import { Actors, ExecutionState } from '../event/types';
import {
  ChatModelAuthError,
  ChatModelBadRequestError,
  ChatModelForbiddenError,
  EXTENSION_CONFLICT_ERROR_MESSAGE,
  ExtensionConflictError,
  isAbortedError,
  isAuthenticationError,
  isBadRequestError,
  isExtensionConflictError,
  isForbiddenError,
  ResponseParseError,
  LLM_FORBIDDEN_ERROR_MESSAGE,
  RequestCancelledError,
} from './errors';
import { calcBranchPathHashSet } from '@src/background/browser/dom/views';
import { type BrowserState, BrowserStateHistory, URLNotAllowedError } from '@src/background/browser/views';
import { convertZodToJsonSchema, repairJsonString } from '@src/background/utils';
import { HistoryTreeProcessor } from '@src/background/browser/dom/history/service';
import { AgentStepRecord } from '../history';
import { type DOMHistoryElement } from '@src/background/browser/dom/history/view';
import { waitForGuideStepClick, watchGuideStepTarget, type GuideStepWatch } from '@src/background/guide-step';
import { verifyStep } from '../checker';
import { skillMapStore } from '@extension/storage';

const logger = createLogger('NavigatorAgent');

// napi Stage 4 — turn a page URL into a "tool" id for the Skill Map.
// Until Stage 6 gives us mission-defined tool ids, the hostname is a
// reasonable stand-in (e.g. "www.notion.so").
function toolFromUrl(url: string | undefined | null): string {
  if (!url) return 'unknown';
  try {
    return new URL(url).hostname || 'unknown';
  } catch {
    return 'unknown';
  }
}

// napi Stage 4 — turn an action + its goal text into a stable-ish skill id.
// Crude on purpose: Stage 6 missions will supply real skill ids directly.
function skillIdFromStep(actionName: string, label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${actionName}:${slug || 'step'}`;
}

// napi Stage 5 — Recovery, v1. When a guided step isn't verified, describe
// where the user actually is and the way forward — never "that's wrong".
// This is the fast, no-LLM-call path: a real per-step `expected` spec and
// pre-authored recovery text for known wrong turns are Stage 6 (missions)
// work; until then this is generic but calm and state-aware.
function buildRecoveryMessage(params: {
  userActed: boolean;
  nextGoal: string;
  currentUrl: string | undefined;
  streak: number;
}): string {
  const { userActed, nextGoal, currentUrl, streak } = params;

  if (!userActed) {
    // The user hasn't acted yet — this is a wait, not a wrong turn.
    return `Still waiting for you — no rush. When you're ready: ${nextGoal}`;
  }

  // The user acted (clicked something) but nothing detectable changed.
  const site = toolFromUrl(currentUrl);
  if (streak <= 1) {
    return `That didn't seem to change anything on ${site} — you're still on the same page. Let's try again: ${nextGoal}`;
  }
  return (
    `Still no change after a couple of tries on ${site}. Make sure you're clicking the highlighted ` +
    `element — if it's no longer there, the page may have changed underneath it. Try again: ${nextGoal}. ` +
    `If this keeps happening, refreshing the page and restarting the task usually clears it.`
  );
}

interface ParsedModelOutput {
  current_state?: {
    next_goal?: string;
  };
  action?: (Record<string, unknown> | null)[] | null;
}

export class NavigatorActionRegistry {
  private actions: Record<string, Action> = {};

  constructor(actions: Action[]) {
    for (const action of actions) {
      this.registerAction(action);
    }
  }

  registerAction(action: Action): void {
    this.actions[action.name()] = action;
  }

  unregisterAction(name: string): void {
    delete this.actions[name];
  }

  getAction(name: string): Action | undefined {
    return this.actions[name];
  }

  setupModelOutputSchema(): z.ZodType {
    const actionSchema = buildDynamicActionSchema(Object.values(this.actions));
    return z.object({
      current_state: agentBrainSchema,
      action: z.array(actionSchema),
    });
  }
}

export interface NavigatorResult {
  done: boolean;
}

export class NavigatorAgent extends BaseAgent<z.ZodType, NavigatorResult> {
  private actionRegistry: NavigatorActionRegistry;
  private jsonSchema: Record<string, unknown>;
  private _stateHistory: BrowserStateHistory | null = null;
  // napi Stage 5 — how many guided steps in a row the user acted on but
  // nothing detectably changed (a "dead click"). Resets on any verified step.
  // Used to escalate the recovery message's tone/detail, not to fail the task.
  private consecutiveNotVerified = 0;

  constructor(
    actionRegistry: NavigatorActionRegistry,
    options: BaseAgentOptions,
    extraOptions?: Partial<ExtraAgentOptions>,
  ) {
    super(actionRegistry.setupModelOutputSchema(), options, { ...extraOptions, id: 'navigator' });

    this.actionRegistry = actionRegistry;

    // The zod object is too complex to be used directly, so we need to convert it to json schema first for the model to use
    this.jsonSchema = convertZodToJsonSchema(this.modelOutputSchema, 'NavigatorAgentOutput', true);
  }

  async invoke(inputMessages: BaseMessage[]): Promise<this['ModelOutput']> {
    // napi: wrap the actual call so a failure can fall through to the next
    // configured fallback model instead of failing the whole task.
    return this.withModelFallback(() => this.invokeNavigatorOnce(inputMessages));
  }

  private async invokeNavigatorOnce(inputMessages: BaseMessage[]): Promise<this['ModelOutput']> {
    // Use structured output
    if (this.withStructuredOutput) {
      const structuredLlm = this.chatLLM.withStructuredOutput(this.jsonSchema, {
        includeRaw: true,
        name: this.modelOutputToolName,
      });

      let response = undefined;
      try {
        response = await structuredLlm.invoke(inputMessages, {
          signal: this.context.controller.signal,
          ...this.callOptions,
        });

        if (response.parsed) {
          return response.parsed;
        }
      } catch (error) {
        if (isAbortedError(error)) {
          throw error;
        }

        // Try to extract JSON from markdown code blocks if parsing failed
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (
          errorMessage.includes('is not valid JSON') &&
          response?.raw?.content &&
          typeof response.raw.content === 'string'
        ) {
          const parsed = this.manuallyParseResponse(response.raw.content);
          if (parsed) {
            return parsed;
          }
        }
        throw new Error(`Failed to invoke ${this.modelName} with structured output: \n${errorMessage}`);
      }

      // Use type assertion to access the properties
      const rawResponse = response.raw as BaseMessage & {
        tool_calls?: Array<{
          args: {
            currentState: typeof agentBrainSchema._type;
            action: z.infer<ReturnType<typeof buildDynamicActionSchema>>;
          };
        }>;
      };

      // sometimes LLM returns an empty content, but with one or more tool calls, so we need to check the tool calls
      if (rawResponse.tool_calls && rawResponse.tool_calls.length > 0) {
        logger.info('Navigator structuredLlm tool call with empty content', rawResponse.tool_calls);
        // only use the first tool call
        const toolCall = rawResponse.tool_calls[0];
        return {
          current_state: toolCall.args.currentState,
          action: [...toolCall.args.action],
        };
      }
      throw new ResponseParseError('Could not parse navigator response');
    }

    // Fallback to the base class's manual JSON extraction for models without
    // structured output support (calling the extraction method directly, not
    // super.invoke(), which would wrap this in a second fallback loop).
    return this.invokeManualExtraction(inputMessages);
  }

  async execute(): Promise<AgentOutput<NavigatorResult>> {
    const agentOutput: AgentOutput<NavigatorResult> = {
      id: this.id,
    };

    let cancelled = false;
    let modelOutputString: string | null = null;
    let browserStateHistory: BrowserStateHistory | null = null;
    let actionResults: ActionResult[] = [];

    try {
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_START, 'Navigating...');

      const messageManager = this.context.messageManager;
      // add the browser state message
      await this.addStateMessageToMemory();
      const currentState = await this.context.browserContext.getCachedState();
      browserStateHistory = new BrowserStateHistory(currentState);

      // check if the task is paused or stopped
      if (this.context.paused || this.context.stopped) {
        cancelled = true;
        return agentOutput;
      }

      // call the model to get the actions to take
      const inputMessages = messageManager.getMessages();
      // logger.info('Navigator input message', inputMessages[inputMessages.length - 1]);

      const modelOutput = await this.invoke(inputMessages);

      // check if the task is paused or stopped
      if (this.context.paused || this.context.stopped) {
        cancelled = true;
        return agentOutput;
      }

      const actions = this.fixActions(modelOutput);
      modelOutput.action = actions;
      modelOutputString = JSON.stringify(modelOutput);

      // remove the last state message from memory before adding the model output
      this.removeLastStateMessageFromMemory();
      this.addModelOutputToMemory(modelOutput);

      // take the actions
      if (this.context.options.guideMode) {
        const nextGoal = modelOutput.current_state?.next_goal ?? '(no goal text)';

        // Does this step target an element the USER can act on?
        const step = actions[0];
        const actionName = step && typeof step === 'object' ? Object.keys(step)[0] : '';
        const actionInstance = actionName ? this.actionRegistry.getAction(actionName) : undefined;
        const targetIndex =
          actionInstance && step ? actionInstance.getIndexArg(step[actionName] as Record<string, unknown>) : null;
        const isUserStep = targetIndex !== null && targetIndex !== undefined;

        if (!actionName) {
          // The model returned no usable action (flaky output). Don't crash — ask it to re-plan.
          logger.warning('🧭 GUIDE MODE — model returned no usable action; re-planning');
          actionResults = [
            new ActionResult({
              extractedContent: 'No valid action was returned for this step. Re-plan and issue the next step.',
              includeInMemory: true,
            }),
          ];
        } else if (!isUserStep) {
          // No element for the user to act on (e.g. `done`, `wait`, agent navigation).
          // Run it normally so task completion still works, instead of hanging 2 minutes.
          logger.info('🧭 GUIDE MODE — non-user action, running it normally:', actionName);
          actionResults = await this.doMultiAction(actions);
        } else {
          logger.info('🧭 GUIDE MODE — step for user:', nextGoal);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_OK, `👉 Your step: ${nextGoal}`);

          // Pick how we'll know the user did this step:
          //  - input_text with known text -> exact 'value' match (the model
          //    knows what belongs here, e.g. filling in known form data).
          //  - click_element targeting a text field -> 'input' — any
          //    non-empty content counts. This covers free-form composing
          //    (a LinkedIn post, an email body, ...) where the model has no
          //    expected text to give. Without this, a click on an
          //    already-focused field would never see a click event (the
          //    user just types) and would time out despite the user doing
          //    exactly the right thing — found testing on linkedin.com.
          //  - everything else -> a real click.
          const stepArgs = (step[actionName] ?? {}) as Record<string, unknown>;
          const targetNode = currentState?.selectorMap?.get(targetIndex);
          const isTextField =
            targetNode?.tagName === 'input' ||
            targetNode?.tagName === 'textarea' ||
            targetNode?.attributes?.contenteditable === 'true' ||
            targetNode?.attributes?.role === 'textbox';
          const watch: GuideStepWatch =
            actionName === 'input_text' && typeof stepArgs.text === 'string'
              ? { mode: 'value', expectedText: stepArgs.text, label: nextGoal }
              : actionName === 'click_element' && isTextField
                ? { mode: 'input', label: nextGoal }
                : { mode: 'click', label: nextGoal };

          let guideStepClick: ReturnType<typeof waitForGuideStepClick> | undefined;

          // spotlight the target element on the page
          try {
            const page = await this.context.browserContext.getCurrentPage();
            const guideStepId = crypto.randomUUID();

            // Register first, so a fast user action cannot be missed.
            guideStepClick = waitForGuideStepClick(page.tabId, guideStepId);

            await page._updateState(this.context.options.useVision, targetIndex, guideStepId);
            await watchGuideStepTarget(page.tabId, guideStepId, watch);

            logger.info('🧭 GUIDE MODE — spotlighting element index', targetIndex, `(watch: ${watch.mode})`);
          } catch (e) {
            logger.warning('🧭 GUIDE MODE — could not spotlight target', e);
          }

          // pause and wait for the USER to perform the step
          const userActed = await this.waitForUserStep(guideStepClick, watch.mode);

          // Stage 3 — verify the intended outcome actually happened.
          // Reading the full page state rebuilds the DOM tree, which is slow on
          // big apps. Skip it whenever the verdict doesn't need it:
          //   - the user never acted        -> not verified, no state needed
          //   - a 'value'/'input' watch hit -> already verified by the watcher
          //   - the URL changed             -> verified by navigation (cheap tab read)
          // Only a click that did NOT navigate needs the structural comparison.
          type AfterState = Parameters<typeof verifyStep>[0]['after'];
          let afterState: AfterState = null;
          if (userActed && watch.mode === 'click') {
            const beforeUrl = currentState?.url ?? '';
            let newUrl = '';
            try {
              const page = await this.context.browserContext.getCurrentPage();
              const nowTab = await chrome.tabs.get(page.tabId);
              newUrl = nowTab.url ?? '';
            } catch (e) {
              logger.warning('🧭 CHECKER — could not read tab URL after step', e);
            }

            if (newUrl && newUrl !== beforeUrl) {
              // Navigation happened — enough to verify, no DOM rebuild needed.
              afterState = { url: newUrl };
            } else {
              try {
                afterState = await this.context.browserContext.getState(false);
              } catch (e) {
                logger.warning('🧭 CHECKER — could not read page after step', e);
              }
            }
          }
          const check = verifyStep({
            actionName,
            userActed,
            before: currentState,
            after: afterState,
            watchMode: watch.mode,
          });

          if (check.verified) {
            logger.info('🧭 CHECKER — verified:', check.reason);
            this.context.consecutiveFailures = 0;
            this.consecutiveNotVerified = 0;
            this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_OK, `✅ Done: ${nextGoal}`);

            // Stage 4 — a verified guided step is proof the user did this, with
            // help. Record it in the Skill Map. Best-effort: never let a
            // storage hiccup interrupt the guide loop.
            // Attribute the skill to the page the user ACTED on, not where a
            // navigation may have landed them (e.g. clicking a link on
            // example.com is an example.com skill, even though it lands on
            // iana.org).
            const tool = toolFromUrl(currentState?.url ?? afterState?.url);
            const skillId = skillIdFromStep(actionName, nextGoal);
            skillMapStore.recordGuidedStep({ tool, skillId, label: nextGoal }).catch(e => {
              logger.warning('🧭 SKILL MAP — could not record guided step', e);
            });

            actionResults = [
              new ActionResult({
                extractedContent: `Step verified (${check.reason}): "${nextGoal}"`,
                includeInMemory: true,
              }),
            ];
          } else {
            logger.warning('🧭 CHECKER — NOT verified:', check.reason);
            if (!userActed) {
              // consecutive timeouts eventually end the task via the failure limit
              this.context.consecutiveFailures++;
            } else {
              // a dead click — the real "off-track" case Recovery cares about
              this.consecutiveNotVerified++;
            }

            // Stage 5 — Recovery, v1: describe where the user actually is and
            // the way forward, instead of just repeating "try again". See
            // buildRecoveryMessage for what's still missing (Stage 6).
            const recoveryMessage = buildRecoveryMessage({
              userActed,
              nextGoal,
              currentUrl: afterState?.url ?? currentState?.url,
              streak: this.consecutiveNotVerified,
            });
            this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_FAIL, `⚠️ ${recoveryMessage}`);
            actionResults = [
              new ActionResult({
                extractedContent: `Step NOT verified for "${nextGoal}": ${check.reason}. ${recoveryMessage}`,
                includeInMemory: true,
              }),
            ];
          }
        }
      } else {
        actionResults = await this.doMultiAction(actions);
      }

      this.context.actionResults = actionResults;

      // check if the task is paused or stopped
      if (this.context.paused || this.context.stopped) {
        cancelled = true;
        return agentOutput;
      }
      // emit event
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_OK, 'Navigation done');
      let done = false;
      if (actionResults.length > 0 && actionResults[actionResults.length - 1].isDone) {
        done = true;
      }
      agentOutput.result = { done };
      return agentOutput;
    } catch (error) {
      this.removeLastStateMessageFromMemory();
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Check if this is an authentication error
      if (isAuthenticationError(error)) {
        throw new ChatModelAuthError(errorMessage, error);
      } else if (isBadRequestError(error)) {
        throw new ChatModelBadRequestError(errorMessage, error);
      } else if (isAbortedError(error)) {
        throw new RequestCancelledError(errorMessage);
      } else if (isExtensionConflictError(error)) {
        throw new ExtensionConflictError(EXTENSION_CONFLICT_ERROR_MESSAGE, error);
      } else if (isForbiddenError(error)) {
        throw new ChatModelForbiddenError(LLM_FORBIDDEN_ERROR_MESSAGE, error);
      } else if (error instanceof URLNotAllowedError) {
        throw error;
      }

      const errorString = `Navigation failed: ${errorMessage}`;
      logger.error(errorString);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_FAIL, errorString);
      agentOutput.error = errorMessage;
      return agentOutput;
    } finally {
      // if the task is cancelled, remove the last state message from memory and emit event
      if (cancelled) {
        this.removeLastStateMessageFromMemory();
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_CANCEL, 'Navigation cancelled');
      }
      if (browserStateHistory) {
        // Create a copy of actionResults to store in history
        const actionResultsCopy = actionResults.map(result => {
          return new ActionResult({
            isDone: result.isDone,
            success: result.success,
            extractedContent: result.extractedContent,
            error: result.error,
            includeInMemory: result.includeInMemory,
            interactedElement: result.interactedElement,
          });
        });

        const history = new AgentStepRecord(modelOutputString, actionResultsCopy, browserStateHistory);
        this.context.history.history.push(history);

        // logger.info('All history', JSON.stringify(this.context.history, null, 2));
      }
    }
  }

  /**
   * Add the state message to the memory
   */
  public async addStateMessageToMemory() {
    if (this.context.stateMessageAdded) {
      return;
    }

    const messageManager = this.context.messageManager;
    // Handle results that should be included in memory
    if (this.context.actionResults.length > 0) {
      let index = 0;
      for (const r of this.context.actionResults) {
        if (r.includeInMemory) {
          if (r.extractedContent) {
            const msg = new HumanMessage(`Action result: ${r.extractedContent}`);
            // logger.info('Adding action result to memory', msg.content);
            messageManager.addMessageWithTokens(msg);
          }
          if (r.error) {
            // Get error text and convert to string
            const errorText = r.error.toString().trim();

            // Get only the last line of the error
            const lastLine = errorText.split('\n').pop() || '';

            const msg = new HumanMessage(`Action error: ${lastLine}`);
            logger.info('Adding action error to memory', msg.content);
            messageManager.addMessageWithTokens(msg);
          }
          // reset this action result to empty, we dont want to add it again in the state message
          // NOTE: in python version, all action results are reset to empty, but in ts version, only those included in memory are reset to empty
          this.context.actionResults[index] = new ActionResult();
        }
        index++;
      }
    }

    const state = await this.prompt.getUserMessage(this.context);
    messageManager.addStateMessage(state);
    this.context.stateMessageAdded = true;
  }

  /**
   * Remove the last state message from the memory
   */
  protected async removeLastStateMessageFromMemory() {
    if (!this.context.stateMessageAdded) return;
    const messageManager = this.context.messageManager;
    messageManager.removeLastStateMessage();
    this.context.stateMessageAdded = false;
  }

  private async addModelOutputToMemory(modelOutput: this['ModelOutput']) {
    const messageManager = this.context.messageManager;
    messageManager.addModelOutput(modelOutput);
  }

  /**
   * Fix the actions to be an array of objects, sometimes the action is a string or an object
   * @param response
   * @returns
   */
  private fixActions(response: this['ModelOutput']): Record<string, unknown>[] {
    let actions: Record<string, unknown>[] = [];
    if (Array.isArray(response.action)) {
      // if the item is null, skip it
      actions = response.action.filter((item: unknown) => item !== null);
      if (actions.length === 0) {
        logger.warning('No valid actions found', response.action);
      }
    } else if (typeof response.action === 'string') {
      try {
        logger.warning('Unexpected action format', response.action);
        // First try to parse the action string directly
        actions = JSON.parse(response.action);
      } catch (parseError) {
        try {
          // If direct parsing fails, try to fix the JSON first
          const fixedAction = repairJsonString(response.action);
          logger.info('Fixed action string', fixedAction);
          actions = JSON.parse(fixedAction);
        } catch (error) {
          logger.error('Invalid action format even after repair attempt', response.action);
          throw new Error('Invalid action output format');
        }
      }
    } else {
      // if the action is neither an array nor a string, it should be an object
      actions = [response.action];
    }
    return actions;
  }

  /**
   * GUIDE MODE (napi): pause the loop and wait for the user to do the step themselves.
   * v1: detect completion by the page URL changing. Times out after 2 minutes.
   * Requires the side panel to stay open (keeps the service worker alive).
   */
  /**
   * GUIDE MODE (napi): wait for the user to complete the spotlighted step.
   * Times out after 2 minutes.
   *
   * The watch modes need different success signals:
   *  - 'click': either a real click on the target OR a URL change counts —
   *    a click that navigates might be observed via either path first.
   *  - 'value' (typing known text) / 'input' (typing anything): ONLY a
   *    genuine field-content match counts. Racing this against a URL-change
   *    poll (like the click path does) would let an unrelated navigation —
   *    the user backing out, a page redirect, an SPA
   *    route change — get misreported as "the user typed the expected
   *    text", which the Checker then takes at face value (an input_text step
   *    is trusted as verified once userActed is true — see checker.ts). This
   *    is a real bug that showed up testing on linkedin.com: the compose
   *    dialog's URL flipped back to /feed while waiting for typed content,
   *    and the step was wrongly marked "typed text matches" even though no
   *    text had actually been confirmed to match.
   */
  private async waitForUserStep(
    guideStepMatch?: ReturnType<typeof waitForGuideStepClick>,
    watchMode: GuideStepWatch['mode'] = 'click',
    timeoutMs = 120_000,
  ): Promise<boolean> {
    const page = await this.context.browserContext.getCurrentPage();
    const startTab = await chrome.tabs.get(page.tabId);
    const beforeUrl = startTab.url ?? '';
    logger.info('🧭 GUIDE MODE — waiting for user. Current URL:', beforeUrl);

    let stillWaiting = true;

    const waitForUrlChange = async (): Promise<boolean> => {
      const start = Date.now();

      while (stillWaiting && Date.now() - start < timeoutMs) {
        if (this.context.paused || this.context.stopped) return false;

        await new Promise(resolve => setTimeout(resolve, 1500));

        try {
          const nowTab = await chrome.tabs.get(page.tabId);
          const nowUrl = nowTab.url ?? '';

          if (nowUrl && nowUrl !== beforeUrl) {
            logger.info('🧭 GUIDE MODE — user acted. URL changed:', beforeUrl, '→', nowUrl);
            return true;
          }
        } catch (e) {
          logger.warning('🧭 GUIDE MODE — could not read tab during wait', e);
        }
      }

      return false;
    };

    // A timeout for the 'value' path, which doesn't get one for free from
    // waitForUrlChange() since that poller isn't part of its race.
    const waitForTimeout = (): Promise<false> => new Promise(resolve => setTimeout(() => resolve(false), timeoutMs));

    try {
      let userActed: boolean;
      if (!guideStepMatch) {
        userActed = await waitForUrlChange();
      } else if (watchMode === 'value' || watchMode === 'input') {
        userActed = await Promise.race([
          guideStepMatch.promise.then(() => {
            logger.info(
              watchMode === 'value'
                ? '🧭 GUIDE MODE — the spotlighted field matched the expected value'
                : '🧭 GUIDE MODE — the spotlighted field now has content',
            );
            return true;
          }),
          waitForTimeout(),
        ]);
      } else {
        userActed = await Promise.race([
          waitForUrlChange(),
          guideStepMatch.promise.then(() => {
            logger.info('🧭 GUIDE MODE — user clicked the spotlighted element');
            return true;
          }),
        ]);
      }

      if (!userActed) {
        logger.warning('🧭 GUIDE MODE — timed out waiting for the user');
      }

      return userActed;
    } finally {
      stillWaiting = false;
      guideStepMatch?.cancel();
    }
  }

  private async doMultiAction(actions: Record<string, unknown>[]): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    let errCount = 0;
    logger.info('Actions', actions);

    const browserContext = this.context.browserContext;
    const browserState = await browserContext.getState(this.context.options.useVision);
    const cachedPathHashes = await calcBranchPathHashSet(browserState);

    await browserContext.removeHighlight();

    for (const [i, action] of actions.entries()) {
      const actionName = Object.keys(action)[0];
      const actionArgs = action[actionName];
      try {
        // check if the task is paused or stopped
        if (this.context.paused || this.context.stopped) {
          return results;
        }

        const actionInstance = this.actionRegistry.getAction(actionName);
        if (actionInstance === undefined) {
          throw new Error(`Action ${actionName} not exists`);
        }

        const indexArg = actionInstance.getIndexArg(actionArgs);
        if (i > 0 && indexArg !== null) {
          const newState = await browserContext.getState(this.context.options.useVision);
          const newPathHashes = await calcBranchPathHashSet(newState);
          // next action requires index but there are new elements on the page
          if (!newPathHashes.isSubsetOf(cachedPathHashes)) {
            const msg = `Something new appeared after action ${i} / ${actions.length}`;
            logger.info(msg);
            results.push(
              new ActionResult({
                extractedContent: msg,
                includeInMemory: true,
              }),
            );
            break;
          }
        }

        const result = await actionInstance.call(actionArgs);
        if (result === undefined) {
          throw new Error(`Action ${actionName} returned undefined`);
        }

        // if the action has an index argument, record the interacted element to the result
        if (indexArg !== null) {
          const domElement = browserState.selectorMap.get(indexArg);
          if (domElement) {
            const interactedElement = HistoryTreeProcessor.convertDomElementToHistoryElement(domElement);
            result.interactedElement = interactedElement;
            logger.info('Interacted element', interactedElement);
            logger.info('Result', result);
          }
        }
        results.push(result);

        // check if the task is paused or stopped
        if (this.context.paused || this.context.stopped) {
          return results;
        }
        // TODO: wait for 1 second for now, need to optimize this to avoid unnecessary waiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        if (error instanceof URLNotAllowedError) {
          throw error;
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(
          'doAction error',
          actionName,
          JSON.stringify(actionArgs, null, 2),
          JSON.stringify(errorMessage, null, 2),
        );
        // unexpected error, emit event
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMessage);
        errCount++;
        if (errCount > 3) {
          throw new Error('Too many errors in actions');
        }
        results.push(
          new ActionResult({
            error: errorMessage,
            isDone: false,
            includeInMemory: true,
          }),
        );
      }
    }
    return results;
  }

  /**
   * Parse and validate model output from history item
   */
  private parseHistoryModelOutput(historyItem: AgentStepRecord): {
    parsedOutput: ParsedModelOutput;
    goal: string;
    actionsToReplay: (Record<string, unknown> | null)[] | null;
  } {
    if (!historyItem.modelOutput) {
      throw new Error('No model output found in history item');
    }

    let parsedOutput: ParsedModelOutput;
    try {
      parsedOutput = JSON.parse(historyItem.modelOutput) as ParsedModelOutput;
    } catch (error) {
      throw new Error(`Could not parse modelOutput: ${error}`);
    }

    // logger.info('Parsed output', JSON.stringify(parsedOutput, null, 2));

    const goal = parsedOutput?.current_state?.next_goal || '';
    const actionsToReplay = parsedOutput?.action;

    // Validate that there are actions to replay
    if (
      !parsedOutput || // No model output string at all
      !actionsToReplay || // 'action' field is missing or null after parsing
      (Array.isArray(actionsToReplay) && actionsToReplay.length === 0) || // 'action' is an empty array
      (Array.isArray(actionsToReplay) && actionsToReplay.length === 1 && actionsToReplay[0] === null) // 'action' is [null]
    ) {
      throw new Error('No action to replay');
    }

    return { parsedOutput, goal, actionsToReplay };
  }

  /**
   * Execute actions from history with element index updates
   */
  private async executeHistoryActions(
    parsedOutput: ParsedModelOutput,
    historyItem: AgentStepRecord,
    delay: number,
  ): Promise<ActionResult[]> {
    const state = await this.context.browserContext.getState(this.context.options.useVision);
    if (!state) {
      throw new Error('Invalid browser state');
    }

    const updatedActions: (Record<string, unknown> | null)[] = [];
    for (let i = 0; i < parsedOutput.action!.length; i++) {
      const result = historyItem.result[i];
      if (!result) {
        break;
      }
      const interactedElement = result.interactedElement;
      const currentAction = parsedOutput.action![i];

      // Skip null actions
      if (currentAction === null) {
        updatedActions.push(null);
        continue;
      }

      // If there's no interacted element, just use the action as is
      if (!interactedElement) {
        updatedActions.push(currentAction);
        continue;
      }

      const updatedAction = await this.updateActionIndices(interactedElement, currentAction, state);
      updatedActions.push(updatedAction);

      if (updatedAction === null) {
        throw new Error(`Could not find matching element ${i} in current page`);
      }
    }

    logger.debug('updatedActions', updatedActions);

    // Filter out null values and cast to the expected type
    const validActions = updatedActions.filter((action): action is Record<string, unknown> => action !== null);
    const result = await this.doMultiAction(validActions);

    // Wait for the specified delay
    await new Promise(resolve => setTimeout(resolve, delay));
    return result;
  }

  async executeHistoryStep(
    historyItem: AgentStepRecord,
    stepIndex: number,
    totalSteps: number,
    maxRetries = 3,
    delay = 1000,
    skipFailures = true,
  ): Promise<ActionResult[]> {
    const replayLogger = createLogger('NavigatorAgent:executeHistoryStep');
    const results: ActionResult[] = [];

    // Parse and validate model output
    let parsedData: {
      parsedOutput: ParsedModelOutput;
      goal: string;
      actionsToReplay: (Record<string, unknown> | null)[] | null;
    };
    try {
      parsedData = this.parseHistoryModelOutput(historyItem);
    } catch (error) {
      const errorMsg = `Step ${stepIndex + 1}: ${error instanceof Error ? error.message : String(error)}`;
      replayLogger.warning(errorMsg);
      return [
        new ActionResult({
          error: errorMsg,
          includeInMemory: false,
        }),
      ];
    }

    const { parsedOutput, goal, actionsToReplay } = parsedData;
    replayLogger.info(`Replaying step ${stepIndex + 1}/${totalSteps}: goal: ${goal}`);
    replayLogger.debug(`🔄 Replaying actions:`, actionsToReplay);

    // Try to execute the step with retries
    let retryCount = 0;
    let success = false;

    while (retryCount < maxRetries && !success) {
      try {
        // Check if execution should stop
        if (this.context.stopped) {
          replayLogger.info('Replay stopped by user');
          break;
        }

        // Execute the history actions
        const stepResults = await this.executeHistoryActions(parsedOutput, historyItem, delay);
        results.push(...stepResults);
        success = true;
      } catch (error) {
        retryCount++;
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (retryCount >= maxRetries) {
          const failMsg = `Step ${stepIndex + 1} failed after ${maxRetries} attempts: ${errorMessage}`;
          replayLogger.error(failMsg);

          results.push(
            new ActionResult({
              error: failMsg,
              includeInMemory: true,
            }),
          );

          if (!skipFailures) {
            throw new Error(failMsg);
          }
        } else {
          replayLogger.warning(`Step ${stepIndex + 1} failed (attempt ${retryCount}/${maxRetries}), retrying...`);
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    return results;
  }

  async updateActionIndices(
    historicalElement: DOMHistoryElement,
    action: Record<string, unknown>,
    currentState: BrowserState,
  ): Promise<Record<string, unknown> | null> {
    // If no historical element or no element tree in current state, return the action unchanged
    if (!historicalElement || !currentState.elementTree) {
      return action;
    }

    // Find the current element in the tree based on the historical element
    const currentElement = await HistoryTreeProcessor.findHistoryElementInTree(
      historicalElement,
      currentState.elementTree,
    );

    // If no current element found or it doesn't have a highlight index, return null
    if (!currentElement || currentElement.highlightIndex === null) {
      return null;
    }

    // Get action name and args
    const actionName = Object.keys(action)[0];
    const actionArgs = action[actionName] as Record<string, unknown>;

    // Get the action instance to access the index
    const actionInstance = this.actionRegistry.getAction(actionName);
    if (!actionInstance) {
      return action;
    }

    // Get the index argument from the action
    const oldIndex = actionInstance.getIndexArg(actionArgs);

    // If the index has changed, update it
    if (oldIndex !== null && oldIndex !== currentElement.highlightIndex) {
      // Create a new action object with the updated index
      const updatedAction: Record<string, unknown> = { [actionName]: { ...actionArgs } };

      // Update the index in the action arguments
      actionInstance.setIndexArg(updatedAction[actionName] as Record<string, unknown>, currentElement.highlightIndex);

      logger.info(`Element moved in DOM, updated index from ${oldIndex} to ${currentElement.highlightIndex}`);
      return updatedAction;
    }

    return action;
  }
}
