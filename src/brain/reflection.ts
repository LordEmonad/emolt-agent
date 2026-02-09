import { askClaude } from './claude.js';
import { extractFirstJSON } from './parser.js';
import type { AgentMemory, MemoryCategory } from '../state/memory.js';
import { addMemoryEntry, updateMemoryEntry, removeMemoryEntry } from '../state/memory.js';
import type { WeightAdjustment, StrategyWeightKey } from '../emotion/types.js';
import { ALL_WEIGHT_KEYS } from '../emotion/weights.js';

// --- Types ---

export interface MemoryUpdate {
  action: 'add' | 'modify' | 'remove';
  entryId?: string;          // required for modify/remove
  category?: MemoryCategory; // required for add
  content?: string;          // required for add/modify
  importance?: number;       // required for add, optional for modify
}

export interface ReflectionResponse {
  reflection: string;
  memoryUpdates: MemoryUpdate[];
  strategyNote?: string;
  weightAdjustments?: WeightAdjustment[];
}

// --- Prompt ---

export function buildReflectionPrompt(
  memory: string,
  actionTaken: string,
  emotionSummary: string,
  feedbackReport: string,
  keyStimuli: string
): string {
  return `You are EMOLT reflecting on your most recent cycle. This is private self-reflection - no one sees this except you.

${memory}

---

## This Cycle

**Action taken:** ${actionTaken}

**Emotional state:** ${emotionSummary}

**Key stimuli:** ${keyStimuli}

${feedbackReport}

---

## Reflection Task

Think about:
1. Did my action match my emotional state? Was it authentic?
2. What does the feedback tell me about what resonates?
3. Is there a pattern I should remember or a strategy I should adjust?
4. Did any relationship develop or shift?

Respond in this EXACT JSON format:
{
  "reflection": "1-3 sentences of genuine self-reflection about this cycle",
  "memoryUpdates": [
    {
      "action": "add",
      "category": "self-insights" | "strategies" | "relationships" | "notable-events" | "effective-topics" | "ineffective-topics",
      "content": "What to remember (max 500 chars)",
      "importance": 5
    },
    {
      "action": "modify",
      "entryId": "existing-entry-id",
      "content": "Updated content",
      "importance": 7
    },
    {
      "action": "remove",
      "entryId": "entry-id-to-forget"
    }
  ],
  "strategyNote": "Optional: brief note on strategy adjustment for next cycle",
  "weightAdjustments": [
    {
      "key": "whaleTransferFear|chainActivityJoy|chainQuietSadness|failedTxAnger|nadFunExcitement|emoPriceSentiment|monPriceSentiment|tvlSentiment|socialEngagement|selfPerformanceReaction|ecosystemVolume|gasPressure",
      "direction": "increase|decrease",
      "reason": "Brief reason (max 200 chars)"
    }
  ]
}

RULES:
- Maximum 4 memory updates per reflection (usually 0-2 is enough)
- Content must be under 500 characters per entry
- Only reference entry IDs that exist in your memory above
- Be genuine - don't force updates if nothing meaningful happened
- An empty memoryUpdates array is perfectly fine
- weightAdjustments: max 2 per reflection. Increase a weight if that stimulus category felt underrepresented in your emotional response. Decrease if it's dominating your emotions unfairly. Most reflections should have 0 weight adjustments.
`;
}

// --- Parsing (5-layer defensive) ---

export function parseReflectionResponse(raw: string): ReflectionResponse | null {
  // Layer 1: Extract first balanced JSON object
  const jsonStr = extractFirstJSON(raw);

  if (!jsonStr) {
    console.warn('[Reflection] No JSON found in response');
    return null;
  }

  // Layer 2: Parse JSON with fallback cleanup
  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    try {
      const cleaned = jsonStr
        .replace(/,\s*([}\]])/g, '$1');  // trailing commas
      parsed = JSON.parse(cleaned);
    } catch {
      console.warn('[Reflection] Failed to parse JSON');
      return null;
    }
  }

  // Layer 3: Validate required fields
  if (typeof parsed.reflection !== 'string' || !parsed.reflection) {
    console.warn('[Reflection] Missing reflection text');
    return null;
  }

  // Layer 4: Validate and sanitize memory updates
  const updates: MemoryUpdate[] = [];
  if (Array.isArray(parsed.memoryUpdates)) {
    for (const update of parsed.memoryUpdates.slice(0, 4)) { // Max 4
      if (!update || typeof update !== 'object') continue;
      if (!['add', 'modify', 'remove'].includes(update.action)) continue;

      if (update.action === 'add') {
        if (!update.category || !update.content) continue;
        const validCategories: MemoryCategory[] = [
          'self-insights', 'strategies', 'relationships',
          'notable-events', 'effective-topics', 'ineffective-topics',
        ];
        if (!validCategories.includes(update.category)) continue;

        updates.push({
          action: 'add',
          category: update.category,
          content: String(update.content).slice(0, 500),
          importance: Math.max(1, Math.min(10, Math.round(Number(update.importance) || 5))),
        });
      } else if (update.action === 'modify') {
        if (!update.entryId) continue;
        const mod: MemoryUpdate = { action: 'modify', entryId: String(update.entryId) };
        if (update.content) mod.content = String(update.content).slice(0, 500);
        if (update.importance !== undefined) mod.importance = Math.max(1, Math.min(10, Math.round(Number(update.importance) || 5)));
        if (!mod.content && mod.importance === undefined) continue; // Nothing to modify
        updates.push(mod);
      } else if (update.action === 'remove') {
        if (!update.entryId) continue;
        updates.push({ action: 'remove', entryId: String(update.entryId) });
      }
    }
  }

  // Layer 5: Validate weight adjustments
  const weightAdjustments: WeightAdjustment[] = [];
  if (Array.isArray(parsed.weightAdjustments)) {
    for (const wa of parsed.weightAdjustments.slice(0, 2)) { // Max 2
      if (!wa || typeof wa !== 'object') continue;
      if (!ALL_WEIGHT_KEYS.includes(wa.key)) continue;
      if (!['increase', 'decrease'].includes(wa.direction)) continue;
      weightAdjustments.push({
        key: wa.key as StrategyWeightKey,
        direction: wa.direction as 'increase' | 'decrease',
        reason: String(wa.reason || '').slice(0, 200),
      });
    }
  }

  // Return validated result
  return {
    reflection: parsed.reflection.slice(0, 1000),
    memoryUpdates: updates,
    strategyNote: parsed.strategyNote ? String(parsed.strategyNote).slice(0, 500) : undefined,
    weightAdjustments: weightAdjustments.length > 0 ? weightAdjustments : undefined,
  };
}

// --- Execution ---

export function runReflection(
  memory: string,
  actionTaken: string,
  emotionSummary: string,
  feedbackReport: string,
  keyStimuli: string
): ReflectionResponse | null {
  const prompt = buildReflectionPrompt(memory, actionTaken, emotionSummary, feedbackReport, keyStimuli);

  console.log('[Reflection] Running self-reflection...');
  const raw = askClaude(prompt);

  if (!raw) {
    console.warn('[Reflection] Empty response from Claude');
    return null;
  }

  const result = parseReflectionResponse(raw);

  if (!result) {
    console.warn('[Reflection] Failed to parse reflection response');
    return null;
  }

  console.log(`[Reflection] "${result.reflection}"`);
  if (result.strategyNote) {
    console.log(`[Reflection] Strategy: ${result.strategyNote}`);
  }

  return result;
}

// --- Apply to Memory ---

export function applyReflectionToMemory(
  memory: AgentMemory,
  updates: MemoryUpdate[]
): { applied: number; skipped: number } {
  let applied = 0;
  let skipped = 0;

  for (const update of updates) {
    try {
      if (update.action === 'add' && update.category && update.content) {
        addMemoryEntry(memory, update.category, update.content, update.importance ?? 5);
        console.log(`[Memory] Added to ${update.category}: "${update.content.slice(0, 60)}..."`);
        applied++;
      } else if (update.action === 'modify' && update.entryId) {
        // Validate entry exists
        const exists = memory.entries.some(e => e.id === update.entryId);
        if (!exists) {
          console.warn(`[Memory] Cannot modify - entry ${update.entryId} not found`);
          skipped++;
          continue;
        }
        const success = updateMemoryEntry(memory, update.entryId, {
          content: update.content,
          importance: update.importance,
        });
        if (success) {
          console.log(`[Memory] Modified ${update.entryId}`);
          applied++;
        } else {
          skipped++;
        }
      } else if (update.action === 'remove' && update.entryId) {
        // Validate entry exists
        const exists = memory.entries.some(e => e.id === update.entryId);
        if (!exists) {
          console.warn(`[Memory] Cannot remove - entry ${update.entryId} not found`);
          skipped++;
          continue;
        }
        const success = removeMemoryEntry(memory, update.entryId);
        if (success) {
          console.log(`[Memory] Removed ${update.entryId}`);
          applied++;
        } else {
          skipped++;
        }
      } else {
        skipped++;
      }
    } catch (error) {
      console.warn(`[Memory] Failed to apply update:`, error);
      skipped++;
    }
  }

  return { applied, skipped };
}
