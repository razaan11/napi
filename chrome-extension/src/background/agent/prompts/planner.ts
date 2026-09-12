/* eslint-disable @typescript-eslint/no-unused-vars */
import { BasePrompt } from './base';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { AgentContext } from '@src/background/agent/types';
import { plannerSystemPromptTemplate, guideModePlannerAddendum } from './templates/planner';

export class PlannerPrompt extends BasePrompt {
  private readonly systemMessage: SystemMessage;

  constructor(guideMode = false) {
    super();
    const prompt = guideMode ? plannerSystemPromptTemplate + guideModePlannerAddendum : plannerSystemPromptTemplate;
    this.systemMessage = new SystemMessage(prompt);
  }

  getSystemMessage(): SystemMessage {
    return this.systemMessage;
  }

  async getUserMessage(context: AgentContext): Promise<HumanMessage> {
    return new HumanMessage('');
  }
}
