import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';
import { AgentNameEnum, llmProviderParameters } from './types';

// Interface for a single model configuration
export interface ModelConfig {
  // providerId, the key of the provider in the llmProviderStore, not the provider name
  provider: string;
  modelName: string;
  parameters?: Record<string, unknown>;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'; // For o-series models (OpenAI and Azure)
}

// Interface for storing multiple agent model configurations
export interface AgentModelRecord {
  agents: Record<AgentNameEnum, ModelConfig>;
  // napi: ordered list of fallback models per agent, tried in order when the
  // primary model's call fails (rate limit, 503, timeout, ...).
  fallbacks?: Partial<Record<AgentNameEnum, ModelConfig[]>>;
}

export type AgentModelStorage = BaseStorage<AgentModelRecord> & {
  setAgentModel: (agent: AgentNameEnum, config: ModelConfig) => Promise<void>;
  getAgentModel: (agent: AgentNameEnum) => Promise<ModelConfig | undefined>;
  resetAgentModel: (agent: AgentNameEnum) => Promise<void>;
  hasAgentModel: (agent: AgentNameEnum) => Promise<boolean>;
  getConfiguredAgents: () => Promise<AgentNameEnum[]>;
  getAllAgentModels: () => Promise<Record<AgentNameEnum, ModelConfig>>;
  cleanupLegacyValidatorSettings: () => Promise<void>;
  // napi: fallback chain per agent
  setAgentFallbacks: (agent: AgentNameEnum, configs: ModelConfig[]) => Promise<void>;
  getAgentFallbacks: (agent: AgentNameEnum) => Promise<ModelConfig[]>;
};

const storage = createStorage<AgentModelRecord>(
  'agent-models',
  { agents: {} as Record<AgentNameEnum, ModelConfig>, fallbacks: {} },
  {
    storageEnum: StorageEnum.Local,
    liveUpdate: true,
  },
);

function validateModelConfig(config: ModelConfig) {
  if (!config.provider || !config.modelName) {
    throw new Error('Provider and model name must be specified');
  }
}

function getModelParameters(agent: AgentNameEnum, provider: string): Record<string, unknown> {
  const providerParams = llmProviderParameters[provider as keyof typeof llmProviderParameters]?.[agent];
  return providerParams ?? { temperature: 0.1, topP: 0.1 };
}

export const agentModelStore: AgentModelStorage = {
  ...storage,
  setAgentModel: async (agent: AgentNameEnum, config: ModelConfig) => {
    validateModelConfig(config);
    // Merge default parameters with provided parameters
    const defaultParams = getModelParameters(agent, config.provider);
    const mergedConfig = {
      ...config,
      parameters: {
        ...defaultParams,
        ...config.parameters,
      },
    };
    await storage.set(current => ({
      ...current,
      agents: {
        ...current.agents,
        [agent]: mergedConfig,
      },
    }));
  },
  getAgentModel: async (agent: AgentNameEnum) => {
    const data = await storage.get();
    const config = data.agents[agent];
    if (!config) return undefined;

    // Merge default parameters with stored parameters
    const defaultParams = getModelParameters(agent, config.provider);
    return {
      ...config,
      parameters: {
        ...defaultParams,
        ...config.parameters,
      },
    };
  },
  resetAgentModel: async (agent: AgentNameEnum) => {
    await storage.set(current => {
      const newAgents = { ...current.agents };
      delete newAgents[agent];
      return { ...current, agents: newAgents };
    });
  },
  hasAgentModel: async (agent: AgentNameEnum) => {
    const data = await storage.get();
    return agent in data.agents;
  },
  getConfiguredAgents: async () => {
    const data = await storage.get();
    // Filter out any legacy validator entries for backward compatibility
    return Object.keys(data.agents).filter(
      agentKey => agentKey !== 'validator' && Object.values(AgentNameEnum).includes(agentKey as AgentNameEnum),
    ) as AgentNameEnum[];
  },
  getAllAgentModels: async () => {
    const data = await storage.get();
    // Filter out any legacy validator entries for backward compatibility
    const filteredAgents: Partial<Record<AgentNameEnum, ModelConfig>> = {};
    for (const [agentKey, config] of Object.entries(data.agents)) {
      if (agentKey !== 'validator' && Object.values(AgentNameEnum).includes(agentKey as AgentNameEnum)) {
        filteredAgents[agentKey as AgentNameEnum] = config;
      }
    }
    return filteredAgents as Record<AgentNameEnum, ModelConfig>;
  },
  cleanupLegacyValidatorSettings: async () => {
    await storage.set(current => {
      const newAgents = { ...current.agents };
      delete newAgents['validator' as keyof typeof newAgents];
      return { ...current, agents: newAgents };
    });
  },
  setAgentFallbacks: async (agent: AgentNameEnum, configs: ModelConfig[]) => {
    configs.forEach(validateModelConfig);
    const mergedConfigs = configs.map(config => ({
      ...config,
      parameters: {
        ...getModelParameters(agent, config.provider),
        ...config.parameters,
      },
    }));
    await storage.set(current => ({
      ...current,
      fallbacks: {
        ...(current.fallbacks ?? {}),
        [agent]: mergedConfigs,
      },
    }));
  },
  getAgentFallbacks: async (agent: AgentNameEnum) => {
    const data = await storage.get();
    return data.fallbacks?.[agent] ?? [];
  },
};
