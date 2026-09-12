import type { Mission } from '@extension/storage';

interface MissionListProps {
  missions: Mission[];
  runningMissionId: string | null;
  onStart: (mission: Mission) => void;
  isDarkMode?: boolean;
}

const MissionList = ({ missions, runningMissionId, onStart, isDarkMode = false }: MissionListProps) => {
  return (
    <div className="flex-1 overflow-y-auto p-3">
      <p className={`mb-3 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
        napi runs these steps for you automatically, one after another — just do the action yourself when napi
        spotlights it. See the full description and each step&rsquo;s &ldquo;why&rdquo; in the extension&rsquo;s Options
        page.
      </p>

      {missions.length === 0 ? (
        <p className={`text-sm ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>No missions yet.</p>
      ) : (
        <div className="space-y-3">
          {missions.map(mission => {
            const isRunning = runningMissionId === mission.id;
            return (
              <div
                key={mission.id}
                className={`rounded-lg border p-3 ${isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white'}`}>
                <h3 className={`text-sm font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
                  {mission.title}
                </h3>
                <p className={`mt-0.5 text-xs ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                  {mission.tool} · {mission.steps.length} step{mission.steps.length === 1 ? '' : 's'}
                </p>
                <button
                  type="button"
                  disabled={isRunning || (runningMissionId !== null && !isRunning)}
                  onClick={() => onStart(mission)}
                  className={`mt-2 rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 ${isDarkMode ? 'bg-yellow-700 hover:bg-yellow-600' : 'bg-yellow-500 hover:bg-yellow-600'}`}>
                  {isRunning ? 'Running…' : 'Start mission'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default MissionList;
