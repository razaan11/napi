import { useState } from 'react';
import { MISSIONS, type Mission } from '@extension/storage';

interface MissionsProps {
  isDarkMode?: boolean;
}

const MissionCard = ({ mission, isDarkMode }: { mission: Mission; isDarkMode: boolean }) => {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const copyStep = async (index: number, instruction: string) => {
    try {
      await navigator.clipboard.writeText(instruction);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(current => (current === index ? null : current)), 1500);
    } catch {
      // Clipboard access can be denied by the browser — not worth surfacing an error for.
    }
  };

  return (
    <div className={`rounded-lg border ${isDarkMode ? 'border-slate-700' : 'border-gray-200'} p-4`}>
      <h3 className={`text-base font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>{mission.title}</h3>
      <p className={`mb-1 text-xs ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>{mission.tool}</p>
      <p className={`mb-3 text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>{mission.description}</p>

      <ol className="space-y-2">
        {mission.steps.map((step, index) => (
          <li
            key={index}
            className={`rounded-md border px-3 py-2 ${isDarkMode ? 'border-slate-700' : 'border-gray-100'}`}>
            <div className="flex items-start justify-between gap-3">
              <p className={`text-sm ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
                <span className={`font-medium ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{index + 1}.</span>{' '}
                {step.instruction}
              </p>
              <button
                onClick={() => copyStep(index, step.instruction)}
                className={`shrink-0 rounded-md border px-2 py-1 text-xs ${isDarkMode ? 'border-slate-600 text-gray-300 hover:bg-slate-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
                {copiedIndex === index ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <p className={`mt-1 text-xs italic ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>Why: {step.why}</p>
          </li>
        ))}
      </ol>
    </div>
  );
};

export const Missions = ({ isDarkMode = false }: MissionsProps) => {
  return (
    <section className="space-y-6">
      <div
        className={`rounded-lg border ${isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-blue-100 bg-white'} p-6 text-left shadow-sm`}>
        <h2 className={`mb-1 text-left text-xl font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
          Missions
        </h2>
        <p className={`mb-4 text-sm font-normal ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
          Hand-written lessons. Turn on Guide mode, open the app named below, then open the side panel&rsquo;s{' '}
          <strong>Missions</strong> tab and press Start — napi sends each step automatically and waits for you to do it
          before moving to the next one. (You can also copy a step from here into the chat by hand if you&rsquo;d rather
          go one at a time yourself.) Every step runs through the same guide loop, verification, and skill tracking as
          anything else you type.
        </p>

        <div className="space-y-4">
          {MISSIONS.map(mission => (
            <MissionCard key={mission.id} mission={mission} isDarkMode={isDarkMode} />
          ))}
        </div>
      </div>
    </section>
  );
};
