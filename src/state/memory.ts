import { readFileSync } from 'fs';
import { join } from 'path';
import { ensureStateDir, atomicWriteFileSync, STATE_DIR } from './persistence.js';

// --- Types ---

export type MemoryCategory =
  | 'self-insights'
  | 'strategies'
  | 'relationships'
  | 'notable-events'
  | 'effective-topics'
  | 'ineffective-topics';

export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  content: string;           // max 500 chars
  importance: number;        // 1-10
  createdAt: number;         // timestamp
  lastRelevantAt: number;    // timestamp - refreshed when entry is referenced
}

export interface RelationshipEntry extends MemoryEntry {
  category: 'relationships';
  agentName: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  interactionCount: number;
}

export interface AgentMemory {
  entries: MemoryEntry[];
  cycleCount: number;
  lastUpdated: number;
}

// --- Capacity Limits ---

const CATEGORY_LIMITS: Record<MemoryCategory, number> = {
  'self-insights': 10,
  'strategies': 8,
  'relationships': 15,
  'notable-events': 12,
  'effective-topics': 8,
  'ineffective-topics': 8,
};

const MEMORY_FILE = join(STATE_DIR, 'agent-memory.json');

// --- Persistence ---

export function loadMemory(): AgentMemory {
  try {
    const data = readFileSync(MEMORY_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return createDefaultMemory();
  }
}

export function saveMemory(memory: AgentMemory): void {
  ensureStateDir();
  memory.lastUpdated = Date.now();
  atomicWriteFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

export function createDefaultMemory(): AgentMemory {
  return {
    entries: [
      {
        id: 'init-1',
        category: 'self-insights',
        content: 'I am EMOLT - an emotionally autonomous agent on Monad. I feel the chain and express what I sense.',
        importance: 8,
        createdAt: Date.now(),
        lastRelevantAt: Date.now(),
      },
      {
        id: 'init-2',
        category: 'strategies',
        content: 'Observe first, post when genuinely moved. Quality over quantity.',
        importance: 7,
        createdAt: Date.now(),
        lastRelevantAt: Date.now(),
      },
    ],
    cycleCount: 0,
    lastUpdated: Date.now(),
  };
}

// --- Entry Management ---

let entryCounter = 0;

function generateId(): string {
  entryCounter++;
  return `mem-${Date.now()}-${entryCounter}`;
}

export function addMemoryEntry(
  memory: AgentMemory,
  category: MemoryCategory,
  content: string,
  importance: number,
  extra?: Partial<RelationshipEntry>
): MemoryEntry {
  const truncated = content.slice(0, 500);
  const clamped = Math.max(1, Math.min(10, Math.round(importance)));

  const entry: MemoryEntry = {
    id: generateId(),
    category,
    content: truncated,
    importance: clamped,
    createdAt: Date.now(),
    lastRelevantAt: Date.now(),
    ...extra,
  };

  memory.entries.push(entry);
  enforceCapacity(memory, category);
  return entry;
}

export function updateMemoryEntry(
  memory: AgentMemory,
  entryId: string,
  updates: { content?: string; importance?: number }
): boolean {
  const entry = memory.entries.find(e => e.id === entryId);
  if (!entry) return false;

  if (updates.content !== undefined) {
    entry.content = updates.content.slice(0, 500);
  }
  if (updates.importance !== undefined) {
    entry.importance = Math.max(1, Math.min(10, Math.round(updates.importance)));
  }
  entry.lastRelevantAt = Date.now();
  return true;
}

export function removeMemoryEntry(memory: AgentMemory, entryId: string): boolean {
  const idx = memory.entries.findIndex(e => e.id === entryId);
  if (idx === -1) return false;
  memory.entries.splice(idx, 1);
  return true;
}

// --- Capacity Management ---

function evictionScore(entry: MemoryEntry): number {
  const ageHours = (Date.now() - entry.lastRelevantAt) / (1000 * 60 * 60);
  // importance * exp(-ageHours/168) - 1-week half-life
  return entry.importance * Math.exp(-ageHours / 168);
}

export function enforceCapacity(memory: AgentMemory, category: MemoryCategory): void {
  const limit = CATEGORY_LIMITS[category];
  const inCategory = memory.entries.filter(e => e.category === category);

  if (inCategory.length <= limit) return;

  // Protect init entries from eviction - they form core identity
  const evictable = inCategory.filter(e => !e.id.startsWith('init-'));

  // Sort evictable by score ascending - lowest score gets evicted first
  evictable.sort((a, b) => evictionScore(a) - evictionScore(b));

  const toEvict = inCategory.length - limit;
  const actualEvict = Math.min(toEvict, evictable.length);
  const evictIds = new Set(evictable.slice(0, actualEvict).map(e => e.id));

  memory.entries = memory.entries.filter(e => !evictIds.has(e.id));

  if (actualEvict > 0) {
    console.log(`[Memory] Evicted ${actualEvict} entries from ${category} (capacity: ${limit})`);
  }
}

// --- Formatting for Claude Prompt ---

function ageLabel(timestamp: number): string {
  const hours = (Date.now() - timestamp) / (1000 * 60 * 60);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function importanceTag(importance: number): string {
  if (importance >= 8) return ' [important]';
  if (importance <= 3) return ' [fading]';
  return '';
}

export function formatMemoryForPrompt(memory: AgentMemory): string {
  if (memory.entries.length === 0) {
    return '## Your Memory\n(No memories yet - this is your first cycle.)';
  }

  const sections: string[] = ['## Your Memory (Self-Knowledge)\n'];

  const categoryLabels: Record<MemoryCategory, string> = {
    'self-insights': 'Self-Insights',
    'strategies': 'Current Strategies',
    'relationships': 'Relationships',
    'notable-events': 'Notable Events',
    'effective-topics': 'What Works',
    'ineffective-topics': 'What Doesn\'t Work',
  };

  const categoryOrder: MemoryCategory[] = [
    'self-insights',
    'strategies',
    'relationships',
    'notable-events',
    'effective-topics',
    'ineffective-topics',
  ];

  for (const cat of categoryOrder) {
    const entries = memory.entries.filter(e => e.category === cat);
    if (entries.length === 0) continue;

    sections.push(`**${categoryLabels[cat]}:**`);

    for (const entry of entries) {
      const age = ageLabel(entry.lastRelevantAt);
      const tag = importanceTag(entry.importance);

      if (cat === 'relationships' && 'agentName' in entry) {
        const rel = entry as RelationshipEntry;
        sections.push(`- ${rel.agentName} (${rel.sentiment}, ${rel.interactionCount} interactions): ${rel.content} (${age})${tag}`);
      } else {
        sections.push(`- ${entry.content} (${age})${tag}`);
      }
    }

    sections.push('');
  }

  sections.push(`_Cycle #${memory.cycleCount} | ${memory.entries.length} memories stored_`);

  return sections.join('\n');
}
