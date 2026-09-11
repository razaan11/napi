import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

/**
 * napi Stage 4 — the Skill Map.
 *
 * Persists what the user has actually PROVEN they can do, per tool. A skill
 * starts 'not-started', becomes 'guided' once napi has walked the user
 * through it, and only becomes 'unaided' once the user does it without help
 * and the Checker verifies it worked (Stage 6 missions will drive that path;
 * for now callers can mark it directly). 'unaided' skills decay to 'rusty'
 * after a period of disuse so the map stays honest.
 */
export type SkillStatus = 'not-started' | 'guided' | 'unaided' | 'rusty';

export interface SkillNode {
  /** Which tool/site this skill belongs to (e.g. a hostname, or a mission-defined tool id later). */
  tool: string;
  /** Stable id for the skill within the tool (e.g. derived from the step's action + goal). */
  skillId: string;
  /** Human-readable description of the skill, for display. */
  label: string;
  status: SkillStatus;
  /** How many times the user completed this WITH napi guiding them. */
  guidedCount: number;
  /** How many times the user completed this UNAIDED and the Checker verified it. */
  verifiedCount: number;
  lastGuidedAt: number | null;
  lastVerifiedAt: number | null;
}

export interface SkillMapData {
  // keyed by `${tool}::${skillId}`
  skills: Record<string, SkillNode>;
}

export interface RecordSkillInput {
  tool: string;
  skillId: string;
  label: string;
}

export interface SkillMapStorage {
  /** Call after a guided step is completed and Checker-verified. */
  recordGuidedStep: (input: RecordSkillInput) => Promise<SkillNode>;
  /** Call after the user does a step UNAIDED and the Checker verifies it (Stage 6). */
  recordUnaidedSuccess: (input: RecordSkillInput) => Promise<SkillNode>;
  /** Flip 'unaided' skills untouched for longer than thresholdDays to 'rusty'. Returns how many changed. */
  applyDecay: (thresholdDays?: number) => Promise<number>;
  getAllSkills: () => Promise<SkillNode[]>;
  getSkillsForTool: (tool: string) => Promise<SkillNode[]>;
  getSkill: (tool: string, skillId: string) => Promise<SkillNode | undefined>;
  resetAll: () => Promise<void>;
}

const DEFAULT_DECAY_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const initialState: SkillMapData = { skills: {} };

const skillMapRawStorage: BaseStorage<SkillMapData> = createStorage('skill-map', initialState, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

function keyFor(tool: string, skillId: string): string {
  return `${tool}::${skillId}`;
}

export function createSkillMapStorage(): SkillMapStorage {
  return {
    recordGuidedStep: async ({ tool, skillId, label }: RecordSkillInput): Promise<SkillNode> => {
      const now = Date.now();
      const key = keyFor(tool, skillId);
      let result!: SkillNode;

      await skillMapRawStorage.set(prev => {
        const existing = prev.skills[key];
        const node: SkillNode = existing
          ? {
              ...existing,
              label, // keep the label fresh in case the wording improved
              // A guided repeat doesn't undo an already-proven unaided skill.
              status: existing.status === 'not-started' ? 'guided' : existing.status,
              guidedCount: existing.guidedCount + 1,
              lastGuidedAt: now,
            }
          : {
              tool,
              skillId,
              label,
              status: 'guided',
              guidedCount: 1,
              verifiedCount: 0,
              lastGuidedAt: now,
              lastVerifiedAt: null,
            };
        result = node;
        return { skills: { ...prev.skills, [key]: node } };
      });

      return result;
    },

    recordUnaidedSuccess: async ({ tool, skillId, label }: RecordSkillInput): Promise<SkillNode> => {
      const now = Date.now();
      const key = keyFor(tool, skillId);
      let result!: SkillNode;

      await skillMapRawStorage.set(prev => {
        const existing = prev.skills[key];
        const node: SkillNode = existing
          ? {
              ...existing,
              label,
              status: 'unaided',
              verifiedCount: existing.verifiedCount + 1,
              lastVerifiedAt: now,
            }
          : {
              tool,
              skillId,
              label,
              status: 'unaided',
              guidedCount: 0,
              verifiedCount: 1,
              lastGuidedAt: null,
              lastVerifiedAt: now,
            };
        result = node;
        return { skills: { ...prev.skills, [key]: node } };
      });

      return result;
    },

    applyDecay: async (thresholdDays: number = DEFAULT_DECAY_DAYS): Promise<number> => {
      const cutoff = Date.now() - thresholdDays * DAY_MS;
      let changed = 0;

      await skillMapRawStorage.set(prev => {
        const nextSkills: Record<string, SkillNode> = {};
        for (const [key, node] of Object.entries(prev.skills)) {
          if (node.status === 'unaided' && node.lastVerifiedAt !== null && node.lastVerifiedAt < cutoff) {
            nextSkills[key] = { ...node, status: 'rusty' };
            changed++;
          } else {
            nextSkills[key] = node;
          }
        }
        return { skills: nextSkills };
      });

      return changed;
    },

    getAllSkills: async (): Promise<SkillNode[]> => {
      const { skills } = await skillMapRawStorage.get();
      return Object.values(skills);
    },

    getSkillsForTool: async (tool: string): Promise<SkillNode[]> => {
      const { skills } = await skillMapRawStorage.get();
      return Object.values(skills).filter(node => node.tool === tool);
    },

    getSkill: async (tool: string, skillId: string): Promise<SkillNode | undefined> => {
      const { skills } = await skillMapRawStorage.get();
      return skills[keyFor(tool, skillId)];
    },

    resetAll: async (): Promise<void> => {
      await skillMapRawStorage.set(initialState);
    },
  };
}

export const skillMapStore: SkillMapStorage = createSkillMapStorage();
