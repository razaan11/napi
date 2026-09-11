import type { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentContext, AgentOutput } from '../types';
import type { BasePrompt } from '../prompts/base';
import type { BaseMessage } from '@langchain/core/messages';
import { createLogger } from '@src/background/log';
import type { Action } from '../actions/builder';
import { convertInputMessages, extractJsonFromModelOutput, removeThinkTags } from '../messages/utils';
import { isAbortedError, ResponseParseError } from './errors';
import { ProviderTypeEnum } from '@extension/storage';
import { Actors, ExecutionState } from '../event/types';

const logger = createLogger('agent');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CallOptions = Record<string, any>;

// napi: a ready-to-use alternate model an agent can switch to if its primary
// model call fails. Built by the caller (setupExecutor) since building a
// BaseChatModel needs the provider's config (API key, base URL, ...), which
// agents themselves don't have access to.
export interface FallbackModel {
  chatLLM: BaseChatModel;
  provider: string;
}

// Update options to use Zod schema
export interface BaseAgentOptions {
  chatLLM: BaseChatModel;
  context: AgentContext;
  prompt: BasePrompt;
  provider?: string;
  // napi: ordered list of models to try, in order, if chatLLM's call fails.
  fallbackModels?: FallbackModel[];
}
export interface ExtraAgentOptions {
  id?: string;
  toolCallingMethod?: string;
  callOptions?: CallOptions;
}

/**
 * Base class for all agents
 * @param T - The Zod schema for the model output
 * @param M - The type of the result field of the agent output
 */
export abstract class BaseAgent<T extends z.ZodType, M = unknown> {
  protected id: string;
  protected chatLLM: BaseChatModel;
  protected prompt: BasePrompt;
  protected context: AgentContext;
  protected actions: Record<string, Action> = {};
  protected modelOutputSchema: T;
  protected toolCallingMethod: string | null;
  protected chatModelLibrary: string;
  protected modelName: string;
  protected provider: string;
  protected withStructuredOutput: boolean;
  protected callOptions?: CallOptions;
  protected modelOutputToolName: string;
  // napi: remaining fallback models for this agent instance. Consumed
  // (shift()ed off) as they're tried, so a task never re-tries a model that
  // already failed, and a successful switch is sticky for the rest of the run.
  protected fallbackModels: FallbackModel[];
  private readonly toolCallingMethodOption?: string;
  declare ModelOutput: z.infer<T>;

  constructor(modelOutputSchema: T, options: BaseAgentOptions, extraOptions?: Partial<ExtraAgentOptions>) {
    // base options
    this.modelOutputSchema = modelOutputSchema;
    this.chatLLM = options.chatLLM;
    this.prompt = options.prompt;
    this.context = options.context;
    this.provider = options.provider || '';
    this.fallbackModels = options.fallbackModels ? [...options.fallbackModels] : [];
    // TODO: fix this, the name is not correct in production environment
    this.chatModelLibrary = this.chatLLM.constructor.name;
    this.modelName = this.getModelName();
    this.withStructuredOutput = this.setWithStructuredOutput();
    // extra options
    this.id = extraOptions?.id || 'agent';
    this.toolCallingMethodOption = extraOptions?.toolCallingMethod;
    this.toolCallingMethod = this.setToolCallingMethod(this.toolCallingMethodOption);
    this.callOptions = extraOptions?.callOptions;
    this.modelOutputToolName = `${this.id}_output`;
  }

  // Set the model name
  private getModelName(model: BaseChatModel = this.chatLLM): string {
    if ('modelName' in model) {
      return model.modelName as string;
    }
    if ('model_name' in model) {
      return model.model_name as string;
    }
    if ('model' in model) {
      return model.model as string;
    }
    return 'Unknown';
  }

  // napi: switch this agent to a fallback model, recomputing every field that
  // was derived from the old chatLLM at construction time.
  private switchToFallback(fallback: FallbackModel): void {
    this.chatLLM = fallback.chatLLM;
    this.provider = fallback.provider;
    this.chatModelLibrary = this.chatLLM.constructor.name;
    this.modelName = this.getModelName(this.chatLLM);
    this.withStructuredOutput = this.setWithStructuredOutput();
    this.toolCallingMethod = this.setToolCallingMethod(this.toolCallingMethodOption);
  }

  // napi: run `attempt` with the current model; on a non-abort failure, try
  // each remaining fallback model in order until one succeeds or the list is
  // exhausted. A successful switch stays in effect for the rest of this
  // agent's life (this task run) — later calls don't re-try the dead model.
  protected async withModelFallback<R>(attempt: () => Promise<R>): Promise<R> {
    try {
      return await attempt();
    } catch (error) {
      if (isAbortedError(error) || this.fallbackModels.length === 0) {
        throw error;
      }

      let lastError = error;
      while (this.fallbackModels.length > 0) {
        const next = this.fallbackModels.shift();
        if (!next) break;
        const previousModelName = this.modelName;
        this.switchToFallback(next);
        try {
          const result = await attempt();
          this.context.emitEvent(
            Actors.SYSTEM,
            ExecutionState.STEP_OK,
            `⚠️ ${previousModelName} was unavailable — switched to ${this.modelName}`,
          );
          logger.info(`🔀 FALLBACK — ${previousModelName} failed, switched to ${this.modelName} and it worked`);
          return result;
        } catch (fallbackError) {
          if (isAbortedError(fallbackError)) throw fallbackError;
          lastError = fallbackError;
          logger.warning(`🔀 FALLBACK — ${this.modelName} also failed`, fallbackError);
        }
      }
      throw lastError;
    }
  }

  // Set the tool calling method
  private setToolCallingMethod(toolCallingMethod?: string): string | null {
    if (toolCallingMethod === 'auto') {
      switch (this.chatModelLibrary) {
        case 'ChatGoogleGenerativeAI':
          return null;
        case 'ChatOpenAI':
        case 'AzureChatOpenAI':
        case 'ChatGroq':
        case 'ChatXAI':
          return 'function_calling';
        default:
          return null;
      }
    }
    return toolCallingMethod || null;
  }

  // Check if model is a Llama model (only for Llama-specific handling)
  private isLlamaModel(modelName: string): boolean {
    return modelName.includes('Llama-4') || modelName.includes('Llama-3.3') || modelName.includes('llama-3.3');
  }

  // Set whether to use structured output based on the model name
  private setWithStructuredOutput(): boolean {
    if (this.modelName === 'deepseek-reasoner' || this.modelName === 'deepseek-r1') {
      return false;
    }

    // Llama API models don't support json_schema response format
    if (this.provider === ProviderTypeEnum.Llama || this.isLlamaModel(this.modelName)) {
      logger.debug(`[${this.modelName}] Llama API doesn't support structured output, using manual JSON extraction`);
      return false;
    }

    return true;
  }

  async invoke(inputMessages: BaseMessage[]): Promise<this['ModelOutput']> {
    // napi: wrap the actual call so a failure can fall through to the next
    // configured model instead of failing the whole task.
    return this.withModelFallback(() => this.invokeOnce(inputMessages));
  }

  private async invokeOnce(inputMessages: BaseMessage[]): Promise<this['ModelOutput']> {
    // Use structured output
    if (this.withStructuredOutput) {
      logger.debug(`[${this.modelName}] Preparing structured output call with schema:`, {
        schemaName: this.modelOutputToolName,
        messageCount: inputMessages.length,
        modelProvider: this.provider,
      });

      const structuredLlm = this.chatLLM.withStructuredOutput(this.modelOutputSchema, {
        includeRaw: true,
        name: this.modelOutputToolName,
      });

      let response = undefined;
      try {
        logger.debug(`[${this.modelName}] Invoking LLM with structured output...`);
        response = await structuredLlm.invoke(inputMessages, {
          signal: this.context.controller.signal,
          ...this.callOptions,
        });

        logger.debug(`[${this.modelName}] LLM response received:`, {
          hasParsed: !!response.parsed,
          hasRaw: !!response.raw,
          rawContent: response.raw?.content?.slice(0, 500) + (response.raw?.content?.length > 500 ? '...' : ''),
        });

        if (response.parsed) {
          logger.debug(`[${this.modelName}] Successfully parsed structured output`);
          return response.parsed;
        }
        logger.error('Failed to parse response', response);
        throw new Error('Could not parse response with structured output');
      } catch (error) {
        if (isAbortedError(error)) {
          throw error;
        }

        // Try to extract JSON from raw response manually if possible
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
        logger.error(`[${this.modelName}] LLM call failed with error: \n${errorMessage}`);
        throw new Error(`Failed to invoke ${this.modelName} with structured output: \n${errorMessage}`);
      }
    }

    // Fallback: Without structured output support, need to extract JSON from model output manually
    return this.invokeManualExtraction(inputMessages);
  }

  // napi: manual JSON-extraction path for models without structured output
  // support (Llama, deepseek-reasoner, ...). Pulled out of invokeOnce so
  // NavigatorAgent's own invoke override can call it directly instead of
  // going through BaseAgent.invoke() (which would wrap it in a second,
  // redundant fallback loop).
  protected async invokeManualExtraction(inputMessages: BaseMessage[]): Promise<this['ModelOutput']> {
    logger.debug(`[${this.modelName}] Using manual JSON extraction fallback method`);
    const convertedInputMessages = convertInputMessages(inputMessages, this.modelName);

    try {
      const response = await this.chatLLM.invoke(convertedInputMessages, {
        signal: this.context.controller.signal,
        ...this.callOptions,
      });

      if (typeof response.content === 'string') {
        const parsed = this.manuallyParseResponse(response.content);
        if (parsed) {
          return parsed;
        }
      }
    } catch (error) {
      logger.error(`[${this.modelName}] LLM call failed in manual extraction mode:`, error);
      throw error;
    }
    const errorMessage = `Failed to parse response from ${this.modelName}`;
    logger.error(errorMessage);
    throw new ResponseParseError('Could not parse response');
  }

  // Execute the agent and return the result
  abstract execute(): Promise<AgentOutput<M>>;

  // Helper method to validate metadata
  protected validateModelOutput(data: unknown): this['ModelOutput'] | undefined {
    if (!this.modelOutputSchema || !data) return undefined;
    try {
      return this.modelOutputSchema.parse(data);
    } catch (error) {
      logger.error('validateModelOutput', error);
      throw new ResponseParseError('Could not validate model output');
    }
  }

  // Helper method to manually parse the response content
  protected manuallyParseResponse(content: string): this['ModelOutput'] | undefined {
    const cleanedContent = removeThinkTags(content);
    try {
      const extractedJson = extractJsonFromModelOutput(cleanedContent);
      return this.validateModelOutput(extractedJson);
    } catch (error) {
      logger.warning('manuallyParseResponse failed', error);
      return undefined;
    }
  }
}
