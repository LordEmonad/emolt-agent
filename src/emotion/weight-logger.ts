/**
 * Weight Change Logger — Append-only JSONL log for strategy weight changes
 * Tracks decay, reflection adjustments, and prophecy adjustments
 */

import { readFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { ensureStateDir, atomicWriteFileSync, STATE_DIR } from '../state/persistence.js';
import type { StrategyWeightKey } from './types.js';

const WEIGHT_HISTORY_FILE = join(STATE_DIR, 'weight-history.jsonl');
const MAX_ENTRIES = 1000;

export interface WeightChange {
  category: StrategyWeightKey;
  before: number;
  after: number;
  delta: number;
  reason?: string;
  magnitude?: string;
  direction?: string;
}

export interface WeightChangeEntry {
  timestamp: number;
  cycle: number;
  type: 'decay' | 'reflection' | 'prophecy';
  changes: WeightChange[];
  weightsSnapshot: Record<StrategyWeightKey, number>;
}

export function logWeightSnapshot(
  cycle: number,
  type: WeightChangeEntry['type'],
  changes: WeightChange[],
  allWeights: Record<StrategyWeightKey, number>,
): void {
  if (changes.length === 0) return;

  ensureStateDir();
  const entry: WeightChangeEntry = {
    timestamp: Date.now(),
    cycle,
    type,
    changes,
    weightsSnapshot: { ...allWeights },
  };
  appendFileSync(WEIGHT_HISTORY_FILE, JSON.stringify(entry) + '\n', 'utf-8');
}

export function logWeightDecay(
  cycle: number,
  weightsBefore: Record<StrategyWeightKey, number>,
  weightsAfter: Record<StrategyWeightKey, number>,
): void {
  const changes: WeightChange[] = [];
  for (const key of Object.keys(weightsBefore) as StrategyWeightKey[]) {
    const before = weightsBefore[key];
    const after = weightsAfter[key];
    const delta = after - before;
    if (Math.abs(delta) > 0.0001) {
      changes.push({ category: key, before, after, delta });
    }
  }
  logWeightSnapshot(cycle, 'decay', changes, weightsAfter);
}

export function logWeightAdjustments(
  cycle: number,
  type: 'reflection' | 'prophecy',
  adjustmentResults: { category: StrategyWeightKey; before: number; after: number; reason: string; magnitude?: string; direction?: string }[],
  allWeights: Record<StrategyWeightKey, number>,
): void {
  const changes: WeightChange[] = adjustmentResults.map(a => ({
    category: a.category,
    before: a.before,
    after: a.after,
    delta: a.after - a.before,
    reason: a.reason,
    magnitude: a.magnitude,
    direction: a.direction,
  }));
  logWeightSnapshot(cycle, type, changes, allWeights);
}

export function loadWeightHistory(): WeightChangeEntry[] {
  try {
    const content = readFileSync(WEIGHT_HISTORY_FILE, 'utf-8');
    const lines = content.trimEnd().split('\n').filter(l => l.trim());
    const entries = lines.map(l => JSON.parse(l) as WeightChangeEntry);

    // Trim to last MAX_ENTRIES
    if (entries.length > MAX_ENTRIES) {
      const trimmed = entries.slice(-MAX_ENTRIES);
      ensureStateDir();
      atomicWriteFileSync(WEIGHT_HISTORY_FILE, trimmed.map(e => JSON.stringify(e)).join('\n') + '\n');
      return trimmed;
    }

    return entries;
  } catch {
    return [];
  }
}
