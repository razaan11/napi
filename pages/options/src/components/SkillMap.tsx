import { useState, useEffect, useCallback } from 'react';
import { skillMapStore, type SkillNode, type SkillStatus } from '@extension/storage';

interface SkillMapProps {
  isDarkMode?: boolean;
}

const STATUS_LABEL: Record<SkillStatus, string> = {
  'not-started': 'Not started',
  guided: 'Guided',
  unaided: 'Unaided ✓',
  rusty: 'Rusty',
};

const STATUS_COLOR: Record<SkillStatus, string> = {
  'not-started': 'bg-gray-200 text-gray-700',
  guided: 'bg-blue-100 text-blue-700',
  unaided: 'bg-green-100 text-green-700',
  rusty: 'bg-amber-100 text-amber-700',
};

function timeAgo(ms: number | null): string {
  if (!ms) return 'never';
  const diffMs = Date.now() - ms;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export const SkillMap = ({ isDarkMode = false }: SkillMapProps) => {
  const [skills, setSkills] = useState<SkillNode[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const all = await skillMapStore.getAllSkills();
    setSkills(all);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const byTool = skills.reduce<Record<string, SkillNode[]>>((acc, node) => {
    (acc[node.tool] ??= []).push(node);
    return acc;
  }, {});

  return (
    <section className="space-y-6">
      <div
        className={`rounded-lg border ${isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-blue-100 bg-white'} p-6 text-left shadow-sm`}>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className={`text-left text-xl font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
              Skill Map
            </h2>
            <p className={`text-sm font-normal ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              What napi has seen you do, per site. &ldquo;Guided&rdquo; means napi walked you through it.
              &ldquo;Unaided&rdquo; means you did it yourself and it was verified — that only happens once mission
              challenges exist.
            </p>
          </div>
          <button
            onClick={() => load()}
            className={`rounded-md border px-3 py-1.5 text-sm ${isDarkMode ? 'border-slate-600 text-gray-300 hover:bg-slate-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
            Refresh
          </button>
        </div>

        {loading ? (
          <p className={`text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>Loading…</p>
        ) : skills.length === 0 ? (
          <p className={`text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            Nothing here yet. Complete a guided step in guide mode and it&rsquo;ll show up here.
          </p>
        ) : (
          <div className="space-y-6">
            {Object.entries(byTool).map(([tool, nodes]) => (
              <div key={tool}>
                <h3
                  className={`mb-2 text-sm font-semibold uppercase tracking-wide ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  {tool}
                </h3>
                <ul className="space-y-2">
                  {nodes.map(node => (
                    <li
                      key={`${node.tool}::${node.skillId}`}
                      className={`flex items-center justify-between rounded-md border px-3 py-2 ${isDarkMode ? 'border-slate-700' : 'border-gray-100'}`}>
                      <div className="min-w-0 flex-1">
                        <p className={`truncate text-sm ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
                          {node.label}
                        </p>
                        <p className={`text-xs ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                          guided {node.guidedCount}× · verified {node.verifiedCount}× · last{' '}
                          {timeAgo(node.lastVerifiedAt ?? node.lastGuidedAt)}
                        </p>
                      </div>
                      <span
                        className={`ml-3 shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[node.status]}`}>
                        {STATUS_LABEL[node.status]}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
};
