interface MissionProgress {
  stepIndex: number;
  totalSteps: number;
}

interface CurrentStepCardProps {
  status: 'waiting' | 'verified' | 'retry';
  text: string;
  missionProgress?: MissionProgress | null;
  isDarkMode?: boolean;
}

const STATUS_META: Record<
  CurrentStepCardProps['status'],
  { icon: string; label: string; light: string; dark: string; border: string }
> = {
  waiting: {
    icon: '👉',
    label: 'Your turn',
    light: 'bg-sky-50 text-sky-900',
    dark: 'bg-sky-900/40 text-sky-100',
    border: 'border-sky-400',
  },
  verified: {
    icon: '✅',
    label: 'Nice, that worked',
    light: 'bg-green-50 text-green-900',
    dark: 'bg-green-900/30 text-green-100',
    border: 'border-green-400',
  },
  retry: {
    icon: '⚠️',
    label: "Let's try that again",
    light: 'bg-amber-50 text-amber-900',
    dark: 'bg-amber-900/30 text-amber-100',
    border: 'border-amber-400',
  },
};

// napi UI — the single most important thing on screen while a task is
// guiding you: what to do right now, and whether the last thing you did
// worked. Kept deliberately simple — one card, one status, one line of text.
const CurrentStepCard = ({ status, text, missionProgress, isDarkMode = false }: CurrentStepCardProps) => {
  const meta = STATUS_META[status];

  return (
    <div className={`border-l-4 ${meta.border} ${isDarkMode ? meta.dark : meta.light} px-4 py-3`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide opacity-80">
          {meta.icon} {meta.label}
        </span>
        {missionProgress && (
          <span className="shrink-0 text-xs font-medium opacity-70">
            Step {missionProgress.stepIndex + 1} of {missionProgress.totalSteps}
          </span>
        )}
      </div>
      <p className="mt-1 text-sm font-medium leading-snug">{text}</p>
    </div>
  );
};

export default CurrentStepCard;
