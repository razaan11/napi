import { useState, useEffect, useCallback } from 'react';
import {
  agentModelStore,
  llmProviderStore,
  AgentNameEnum,
  type ModelConfig,
  type ProviderConfig,
  getDefaultDisplayNameFromProviderId,
} from '@extension/storage';

interface FallbackModelsProps {
  isDarkMode?: boolean;
}

const AGENT_LABEL: Record<AgentNameEnum, string> = {
  [AgentNameEnum.Navigator]: 'Navigator',
  [AgentNameEnum.Planner]: 'Planner',
};

function providerLabel(id: string, config?: ProviderConfig): string {
  return config?.name || getDefaultDisplayNameFromProviderId(id);
}

interface AgentFallbackRowProps {
  agent: AgentNameEnum;
  primary: ModelConfig;
  providers: Record<string, ProviderConfig>;
  fallbacks: ModelConfig[];
  onChange: (agent: AgentNameEnum, next: ModelConfig[]) => void;
  isDarkMode: boolean;
}

const AgentFallbackCard = ({ agent, primary, providers, fallbacks, onChange, isDarkMode }: AgentFallbackRowProps) => {
  const providerIds = Object.keys(providers);
  const [newProvider, setNewProvider] = useState(providerIds[0] ?? '');
  const [newModel, setNewModel] = useState('');

  const availableModels = providers[newProvider]?.modelNames ?? [];

  const addFallback = () => {
    const modelName = newModel.trim();
    if (!newProvider || !modelName) return;
    onChange(agent, [...fallbacks, { provider: newProvider, modelName }]);
    setNewModel('');
  };

  const removeFallback = (index: number) => {
    onChange(
      agent,
      fallbacks.filter((_, i) => i !== index),
    );
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= fallbacks.length) return;
    const next = [...fallbacks];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(agent, next);
  };

  const inputClass = `rounded-md border px-2 py-1.5 text-sm ${isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-200' : 'border-gray-300 bg-white text-gray-700'}`;

  return (
    <div className={`rounded-lg border ${isDarkMode ? 'border-slate-700' : 'border-gray-200'} p-4`}>
      <h3 className={`mb-1 text-base font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
        {AGENT_LABEL[agent]}
      </h3>
      <p className={`mb-3 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
        Primary: {providerLabel(primary.provider, providers[primary.provider])} / {primary.modelName}
      </p>

      {fallbacks.length === 0 ? (
        <p className={`mb-3 text-sm ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
          No fallback models configured — if the primary fails, the task just fails.
        </p>
      ) : (
        <ol className="mb-3 space-y-1.5">
          {fallbacks.map((fb, index) => (
            <li
              key={`${fb.provider}-${fb.modelName}-${index}`}
              className={`flex items-center justify-between rounded-md border px-2.5 py-1.5 ${isDarkMode ? 'border-slate-700' : 'border-gray-100'}`}>
              <span className={`text-sm ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                {index + 1}. {providerLabel(fb.provider, providers[fb.provider])} / {fb.modelName}
              </span>
              <span className="flex items-center gap-1">
                <button
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  className={`px-1.5 text-sm ${isDarkMode ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-800'} disabled:opacity-30`}
                  aria-label="Move up">
                  ↑
                </button>
                <button
                  onClick={() => move(index, 1)}
                  disabled={index === fallbacks.length - 1}
                  className={`px-1.5 text-sm ${isDarkMode ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-800'} disabled:opacity-30`}
                  aria-label="Move down">
                  ↓
                </button>
                <button
                  onClick={() => removeFallback(index)}
                  className={`px-1.5 text-sm text-red-500 hover:text-red-700`}
                  aria-label="Remove">
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}

      {providerIds.length === 0 ? (
        <p className={`text-xs ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
          Add a provider on the Models tab first to configure fallbacks.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={newProvider}
            onChange={e => {
              setNewProvider(e.target.value);
              setNewModel('');
            }}
            className={inputClass}>
            {providerIds.map(id => (
              <option key={id} value={id}>
                {providerLabel(id, providers[id])}
              </option>
            ))}
          </select>
          {availableModels.length > 0 ? (
            <select value={newModel} onChange={e => setNewModel(e.target.value)} className={inputClass}>
              <option value="">Select a model…</option>
              {availableModels.map(name => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={newModel}
              onChange={e => setNewModel(e.target.value)}
              placeholder="model name"
              className={inputClass}
            />
          )}
          <button
            onClick={addFallback}
            disabled={!newModel.trim()}
            className={`rounded-md border px-3 py-1.5 text-sm disabled:opacity-40 ${isDarkMode ? 'border-slate-600 text-gray-300 hover:bg-slate-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
            Add fallback
          </button>
        </div>
      )}
    </div>
  );
};

export const FallbackModels = ({ isDarkMode = false }: FallbackModelsProps) => {
  const [providers, setProviders] = useState<Record<string, ProviderConfig>>({});
  const [primaries, setPrimaries] = useState<Partial<Record<AgentNameEnum, ModelConfig>>>({});
  const [fallbacks, setFallbacks] = useState<Partial<Record<AgentNameEnum, ModelConfig[]>>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [allProviders, allPrimaries] = await Promise.all([
      llmProviderStore.getAllProviders(),
      agentModelStore.getAllAgentModels(),
    ]);
    setProviders(allProviders);
    setPrimaries(allPrimaries);

    const agents = [AgentNameEnum.Navigator, AgentNameEnum.Planner];
    const entries = await Promise.all(agents.map(agent => agentModelStore.getAgentFallbacks(agent)));
    setFallbacks(Object.fromEntries(agents.map((agent, i) => [agent, entries[i]])));
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleChange = async (agent: AgentNameEnum, next: ModelConfig[]) => {
    setFallbacks(prev => ({ ...prev, [agent]: next }));
    await agentModelStore.setAgentFallbacks(agent, next);
  };

  const configuredAgents = ([AgentNameEnum.Navigator, AgentNameEnum.Planner] as AgentNameEnum[]).filter(
    agent => primaries[agent],
  );

  return (
    <section className="space-y-6">
      <div
        className={`rounded-lg border ${isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-yellow-100 bg-white'} p-6 text-left shadow-sm`}>
        <h2 className={`mb-1 text-left text-xl font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
          Fallback Models
        </h2>
        <p className={`mb-4 text-sm font-normal ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
          If an agent&rsquo;s primary model fails (rate limit, outage, timeout), napi tries these next, in order. A
          model that succeeds stays in use for the rest of the task — it won&rsquo;t keep retrying the one that failed.
        </p>

        {loading ? (
          <p className={`text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>Loading…</p>
        ) : configuredAgents.length === 0 ? (
          <p className={`text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            Set up a primary model for Navigator or Planner on the Models tab first.
          </p>
        ) : (
          <div className="space-y-4">
            {configuredAgents.map(agent => (
              <AgentFallbackCard
                key={agent}
                agent={agent}
                primary={primaries[agent] as ModelConfig}
                providers={providers}
                fallbacks={fallbacks[agent] ?? []}
                onChange={handleChange}
                isDarkMode={isDarkMode}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
};
