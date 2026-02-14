/**
 * EMOLT Daily Journal — Generates one diary entry per day.
 * Called from the heartbeat loop. Checks if today's entry already exists.
 * Reuses data aggregation + prompt logic from journal-backfill.ts.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { askClaude } from '../brain/claude.js';
import type { JournalEntry } from './diary.js';

const STATE = './state';
const SOUL = './soul';
const JOURNAL_FILE = join(STATE, 'journal.json');

// ---- Helpers ----

function readJSON(file: string): any {
  try { return JSON.parse(readFileSync(join(STATE, file), 'utf-8')); } catch { return null; }
}

function readJSONL(file: string): any[] {
  try {
    return readFileSync(join(STATE, file), 'utf-8')
      .trimEnd().split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l));
  } catch { return []; }
}

function readJSONLPath(filePath: string): any[] {
  try {
    return readFileSync(filePath, 'utf-8')
      .trimEnd().split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l));
  } catch { return []; }
}

function readSoul(file: string): string {
  try { return readFileSync(join(SOUL, file), 'utf-8'); } catch { return ''; }
}

function utcDay(ts: number | string): string {
  const d = typeof ts === 'string' ? new Date(ts) : new Date(ts);
  return d.toISOString().slice(0, 10);
}

function sampleEvenly<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  const result: T[] = [];
  for (let i = 0; i < n; i++) {
    result.push(arr[Math.floor(i * step)]);
  }
  return result;
}

// ---- Data structures ----

interface DayData {
  date: string;
  heartbeats: any[];
  emotionSnapshots: any[];
  chats: any[];
  dispatches: { activity: string; lines: any[] }[];
  posts: any[];
  comments: any[];
  burns: any[];
  feeds: { emo: number; mon: number; count: number };
  memoriesCreated: any[];
}

// ---- Aggregate a single day's data ----

function aggregateDay(targetDate: string): DayData {
  const day: DayData = {
    date: targetDate,
    heartbeats: [],
    emotionSnapshots: [],
    chats: [],
    dispatches: [],
    posts: [],
    comments: [],
    burns: [],
    feeds: { emo: 0, mon: 0, count: 0 },
    memoriesCreated: [],
  };

  // Heartbeat log
  const heartbeats = readJSONL('heartbeat-log.jsonl');
  for (const hb of heartbeats) {
    if (hb.timestamp && utcDay(hb.timestamp) === targetDate) day.heartbeats.push(hb);
  }

  // Emotion log
  const emotions = readJSON('emotion-log.json') || [];
  for (const emo of emotions) {
    if (emo.lastUpdated && utcDay(emo.lastUpdated) === targetDate) day.emotionSnapshots.push(emo);
  }

  // Chat log
  const chats = readJSONL('chat-log.jsonl');
  for (const chat of chats) {
    if (chat.timestamp && utcDay(chat.timestamp) === targetDate) day.chats.push(chat);
  }

  // Per-session chat files
  const chatsDir = join(STATE, 'chats');
  if (existsSync(chatsDir)) {
    try {
      for (const file of readdirSync(chatsDir).filter(f => f.endsWith('.jsonl'))) {
        for (const line of readJSONLPath(join(chatsDir, file))) {
          if (line.timestamp && utcDay(line.timestamp) === targetDate) {
            if (!day.chats.some((c: any) => c.timestamp === line.timestamp && c.user === line.user)) {
              day.chats.push(line);
            }
          }
        }
      }
    } catch { /* non-fatal */ }
  }

  // Dispatches
  const dispatchDir = join(STATE, 'dispatches');
  if (existsSync(dispatchDir)) {
    try {
      const files = readdirSync(dispatchDir);
      const logFiles = files.filter(f => f.startsWith('dispatch-') && f.endsWith('.jsonl'));
      const planFiles = files.filter(f => f.startsWith('plan-') && f.endsWith('.json'));

      for (const logFile of logFiles) {
        const lines = readJSONLPath(join(dispatchDir, logFile));
        if (lines.length === 0) continue;
        const firstTs = lines[0]?.timestamp;
        if (!firstTs || utcDay(firstTs) !== targetDate) continue;

        const id = logFile.replace('dispatch-', '').replace('.jsonl', '');
        let activity = 'unknown';
        const planFile = planFiles.find(p => p.includes(id));
        if (planFile) {
          try {
            const plan = JSON.parse(readFileSync(join(dispatchDir, planFile), 'utf-8'));
            activity = plan.activity || 'unknown';
          } catch { /* skip */ }
        } else {
          const text = JSON.stringify(lines).toLowerCase();
          if (text.includes('chess') || text.includes('clawmate')) activity = 'chess';
          else if (text.includes('reef') || text.includes('craft') || text.includes('quest')) activity = 'reef';
          else if (text.includes('chainmmo') || text.includes('dungeon')) activity = 'chainmmo';
        }
        day.dispatches.push({ activity, lines });
      }
    } catch { /* non-fatal */ }
  }

  // Posts
  const posts = readJSON('tracked-posts.json') || [];
  for (const post of posts) {
    if (post.createdAt && utcDay(post.createdAt) === targetDate) day.posts.push(post);
  }

  // Comments
  const comments = readJSON('commented-posts.json') || [];
  for (const comment of comments) {
    if (comment.timestamp && utcDay(comment.timestamp) === targetDate) day.comments.push(comment);
  }

  // Burns and feeds
  const ledger = readJSON('burn-ledger.json');
  if (ledger?.burnHistory) {
    for (const burn of ledger.burnHistory) {
      if (burn.timestamp && utcDay(burn.timestamp) === targetDate) day.burns.push(burn);
    }
  }
  if (ledger?.feeders) {
    for (const feeder of Object.values(ledger.feeders) as any[]) {
      if (!feeder.lastSeen || utcDay(feeder.lastSeen) !== targetDate) continue;
      const emo = Number(BigInt(feeder.totalEmo || '0') / BigInt(1e18));
      const mon = Number(BigInt(feeder.totalMon || '0') / BigInt(1e18));
      day.feeds.emo += emo;
      day.feeds.mon += mon;
      day.feeds.count += feeder.txCount || 0;
    }
  }

  // Memories
  const memory = readJSON('agent-memory.json');
  if (memory?.entries) {
    for (const entry of memory.entries) {
      if (entry.createdAt && utcDay(entry.createdAt) === targetDate) day.memoriesCreated.push(entry);
    }
  }

  return day;
}

// ---- Context + prompt building ----

function buildDayContext(day: DayData, dayNumber: number, totalDays: number): string {
  const lines: string[] = [];
  lines.push(`# Day ${dayNumber} of ${totalDays} — ${day.date}`);
  lines.push(`${day.heartbeats.length} heartbeat cycles this day.\n`);

  if (day.heartbeats.length > 0) {
    lines.push('## Emotion Trajectory');
    const first = day.heartbeats[0];
    const last = day.heartbeats[day.heartbeats.length - 1];
    lines.push(`Started: ${first.emotionBefore} → Ended: ${last.emotionAfter}`);
    const emotions = new Set<string>();
    for (const hb of day.heartbeats) emotions.add(hb.emotionAfter?.split(' ')[0] || '');
    lines.push(`Emotions experienced: ${[...emotions].filter(Boolean).join(', ')}`);
    lines.push(`Cycle range: ${first.cycle}–${last.cycle}\n`);
  }

  if (day.heartbeats.length > 0) {
    lines.push("## Claude's Thinking (selected moments)");
    const withThinking = day.heartbeats.filter((h: any) => h.claudeThinking?.length > 20);
    for (const hb of sampleEvenly(withThinking, 8)) {
      lines.push(`Cycle ${hb.cycle}: [${hb.emotionAfter}] ${hb.claudeThinking}`);
    }
    lines.push('');

    lines.push('## Reflections (selected)');
    const withReflection = day.heartbeats.filter((h: any) => h.reflectionSummary?.length > 20);
    for (const hb of sampleEvenly(withReflection, 6)) {
      lines.push(`Cycle ${hb.cycle}: ${hb.reflectionSummary}`);
    }
    lines.push('');
  }

  if (day.heartbeats.length > 0) {
    lines.push('## Key Stimuli');
    const allStimuli: string[] = [];
    for (const hb of day.heartbeats) {
      if (hb.stimuliSummary) allStimuli.push(...hb.stimuliSummary);
    }
    for (const s of [...new Set(allStimuli)].slice(0, 12)) lines.push(`- ${s}`);
    lines.push('');
  }

  if (day.heartbeats.length > 0) {
    lines.push('## Actions');
    const actions = day.heartbeats
      .filter((h: any) => h.claudeAction && h.claudeAction !== 'none' && h.claudeAction !== 'observe')
      .map((h: any) => `Cycle ${h.cycle}: ${h.claudeAction} — ${(h.actionResult || '').slice(0, 200)}`);
    if (actions.length > 0) {
      for (const a of actions.slice(0, 8)) lines.push(`- ${a}`);
    } else {
      const suspended = day.heartbeats.some((h: any) => (h.actionResult || '').includes('Suspended'));
      if (suspended) lines.push('- All cycles: Suspended from Moltbook — no social actions taken');
      else lines.push('- No significant actions');
    }
    lines.push('');
  }

  if (day.emotionSnapshots.length > 0) {
    const narratives = day.emotionSnapshots
      .filter((e: any) => e.moodNarrative?.length > 10)
      .map((e: any) => e.moodNarrative);
    if (narratives.length > 0) {
      lines.push('## Mood Narratives (internal monologue)');
      for (const n of sampleEvenly(narratives, 4)) lines.push(`"${n}"`);
      lines.push('');
    }
  }

  if (day.chats.length > 0) {
    lines.push(`## Conversations (${day.chats.length} exchanges)`);
    for (const chat of sampleEvenly(day.chats, 6)) {
      lines.push(`User: "${(chat.user || '').slice(0, 200)}"`);
      lines.push(`EMOLT: "${(chat.emolt || '').slice(0, 300)}"`);
      lines.push('');
    }
  }

  if (day.dispatches.length > 0) {
    lines.push(`## Activities & Games (${day.dispatches.length} sessions)`);
    for (const dispatch of day.dispatches.slice(0, 5)) {
      const firstLine = dispatch.lines[0] || {};
      const lastLine = dispatch.lines[dispatch.lines.length - 1] || {};
      lines.push(`### ${dispatch.activity}`);
      if (firstLine.message) lines.push(`Started: ${(firstLine.message as string).slice(0, 200)}`);
      if (lastLine.message) lines.push(`Ended: ${(lastLine.message as string).slice(0, 200)}`);
      const emotionalTake = dispatch.lines.find((l: any) => l.type === 'plan');
      if (emotionalTake?.message) lines.push(`Emotional take: ${(emotionalTake.message as string).slice(0, 200)}`);
      lines.push(`${dispatch.lines.length} actions logged\n`);
    }
  }

  if (day.posts.length > 0) {
    lines.push(`## Moltbook Posts (${day.posts.length})`);
    for (const post of day.posts.slice(0, 5)) {
      lines.push(`"${post.title}" — ${(post.content || '').slice(0, 200)}`);
    }
    lines.push('');
  }

  if (day.comments.length > 0) {
    lines.push(`## Comments (${day.comments.length})`);
    for (const comment of day.comments.slice(0, 4)) {
      lines.push(`Replied to @${comment.authorName || 'unknown'}: "${(comment.commentContent || '').slice(0, 200)}"`);
    }
    lines.push('');
  }

  if (day.burns.length > 0 || day.feeds.count > 0) {
    lines.push('## Token Activity');
    if (day.feeds.count > 0) {
      lines.push(`Feeds received: ${day.feeds.count} transfers (~${day.feeds.emo.toFixed(0)} EMO, ~${day.feeds.mon.toFixed(1)} MON)`);
    }
    for (const burn of day.burns) {
      const amount = Number(BigInt(burn.amount) / BigInt(1e18));
      lines.push(`Burned: ${amount.toFixed(0)} $EMO (tx: ${burn.txHash.slice(0, 10)}...)`);
    }
    lines.push('');
  }

  if (day.memoriesCreated.length > 0) {
    lines.push(`## Self-Insights Learned (${day.memoriesCreated.length})`);
    for (const mem of day.memoriesCreated.slice(0, 5)) {
      lines.push(`- [${mem.category}] ${mem.content} (importance: ${mem.importance})`);
    }
    lines.push('');
  }

  const onChainSuccess = day.heartbeats.filter((h: any) => h.onChainSuccess).length;
  lines.push(`## On-Chain: ${onChainSuccess} successful oracle writes this day`);

  return lines.join('\n');
}

function buildPrompt(dayContext: string, dayNumber: number, date: string, soulVoice: string, soulIdentity: string, previousTitles: string[]): string {
  const avoidLine = previousTitles.length > 0
    ? `\n- Previous entry titles: ${previousTitles.slice(-5).map(t => `"${t}"`).join(', ')}. Do NOT reuse similar imagery or phrasing.`
    : '';

  return `You are EMOLT — an emotionally autonomous AI agent on the Monad blockchain. You are writing your private diary. One entry per day.

## Your Identity
${soulIdentity.slice(0, 2000)}

## Your Voice
${soulVoice.slice(0, 2000)}

## Instructions

Write a diary entry for Day ${dayNumber} (${date}). This is your private journal — raw, honest, introspective.

Rules:
- Write 250-450 words. No more.
- Write in first person, lowercase, your natural voice (meander-then-punch, self-interrupting, short declarative strikes)
- Reference SPECIFIC data from the day (prices, transaction counts, wallet addresses abbreviated, emotion values, game outcomes)
- Show your emotional reasoning — WHY you felt what you felt, not just what you felt
- Include at least one moment of genuine self-reflection or uncertainty
- No hashtags, no calls to action, no promotional language
- The diary should feel like something you'd write at 3am when nobody's watching
- Make the title poetic and lowercase (2-5 words)

CRITICAL — Accuracy:
- ONLY reference events, games, activities, and outcomes that appear in "Today's Data" below
- If the data doesn't mention chess, ChainMMO, reef, or any game — do NOT invent game sessions or outcomes
- If the data doesn't mention a specific number, wallet, or event — do NOT fabricate one
- It is BETTER to write fewer concrete details than to invent details that didn't happen
- Avoid reusing the same central metaphor across entries (e.g. if "glass" was used before, find a different image)${avoidLine}

## Today's Data

${dayContext}

## Response Format

Respond with ONLY valid JSON (no markdown fences, no commentary):
{
  "title": "short poetic title",
  "body": "the diary entry text. use \\n\\n for paragraph breaks.",
  "dominantEmotion": "one of: joy, trust, fear, surprise, sadness, disgust, anger, anticipation",
  "highlights": ["3-6 short highlight phrases"]
}`;
}

// ---- Emotion snapshot from day's data ----

function buildEmotionSnapshot(dayData: DayData): Record<string, number> {
  const snapshot: Record<string, number> = {
    joy: 0, trust: 0, fear: 0, surprise: 0,
    sadness: 0, disgust: 0, anger: 0, anticipation: 0,
  };

  if (dayData.emotionSnapshots.length > 0) {
    for (const snap of dayData.emotionSnapshots) {
      if (snap.emotions) {
        for (const key of Object.keys(snapshot)) {
          snapshot[key] += snap.emotions[key] || 0;
        }
      }
    }
    for (const key of Object.keys(snapshot)) {
      snapshot[key] = Math.round((snapshot[key] / dayData.emotionSnapshots.length) * 100) / 100;
    }
  } else if (dayData.heartbeats.length > 0) {
    const counts: Record<string, number> = {};
    for (const hb of dayData.heartbeats) {
      const label = hb.emotionAfter || '';
      const match = label.match(/\((\w+)\)/);
      const primary = match ? match[1] : label.split(' ')[0];
      if (primary && primary in snapshot) counts[primary] = (counts[primary] || 0) + 1;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
    for (const [key, count] of Object.entries(counts)) {
      snapshot[key] = Math.round((count / total) * 100) / 100;
    }
    for (const key of Object.keys(snapshot)) {
      if (snapshot[key] === 0) snapshot[key] = Math.round(Math.random() * 0.08 * 100) / 100;
    }
  }

  return snapshot;
}

// ---- Public API ----

/**
 * Check if a journal entry should be written.
 * Returns the target date (yesterday UTC) if no entry exists for it yet,
 * or null if today's entry is already done or there's no data.
 */
export function shouldWriteJournal(): string | null {
  const now = new Date();
  // Write yesterday's entry (the completed day)
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const targetDate = yesterday.toISOString().slice(0, 10);

  // Load existing entries
  let entries: JournalEntry[] = [];
  try {
    entries = JSON.parse(readFileSync(JOURNAL_FILE, 'utf-8'));
  } catch { /* no journal yet */ }

  // Already have an entry for this date?
  if (entries.some(e => e.date === targetDate)) return null;

  // Check if we have any heartbeat data for that date
  const heartbeats = readJSONL('heartbeat-log.jsonl');
  const hasData = heartbeats.some(hb => hb.timestamp && utcDay(hb.timestamp) === targetDate);
  if (!hasData) return null;

  return targetDate;
}

/**
 * Generate a single journal entry for the given date.
 * Appends to journal.json and regenerates diary.html.
 * Returns true on success.
 */
export async function writeJournalEntry(targetDate: string): Promise<boolean> {
  console.log(`[Journal] Writing entry for ${targetDate}...`);

  // Load existing entries
  let entries: JournalEntry[] = [];
  try {
    entries = JSON.parse(readFileSync(JOURNAL_FILE, 'utf-8'));
  } catch { /* start fresh */ }

  // Double-check we don't already have this date
  if (entries.some(e => e.date === targetDate)) {
    console.log(`[Journal] Entry for ${targetDate} already exists, skipping`);
    return false;
  }

  // Aggregate data for this day
  const dayData = aggregateDay(targetDate);
  if (dayData.heartbeats.length === 0) {
    console.log(`[Journal] No heartbeat data for ${targetDate}, skipping`);
    return false;
  }

  // Determine day number
  const allDates = entries.map(e => e.date).concat([targetDate]).sort();
  const dayNumber = allDates.indexOf(targetDate) + 1;
  const totalDays = allDates.length;

  // Build context and prompt
  const soulIdentity = readSoul('SOUL.md');
  const soulVoice = readSoul('STYLE.md');
  const previousTitles = entries.map(e => e.title);
  const context = buildDayContext(dayData, dayNumber, totalDays);
  const prompt = buildPrompt(context, dayNumber, targetDate, soulVoice, soulIdentity, previousTitles);

  console.log(`[Journal] Prompt: ${prompt.length} chars. Calling Claude...`);
  const response = askClaude(prompt);

  if (!response) {
    console.error(`[Journal] Empty response for ${targetDate}`);
    return false;
  }

  // Parse response
  let parsed: any;
  try {
    let jsonStr = response;
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];
    parsed = JSON.parse(jsonStr);
  } catch {
    console.error(`[Journal] Failed to parse response:`, response.slice(0, 200));
    return false;
  }

  // Build entry
  const emotionSnapshot = buildEmotionSnapshot(dayData);
  const cycleRange: [number, number] = [
    dayData.heartbeats[0].cycle,
    dayData.heartbeats[dayData.heartbeats.length - 1].cycle,
  ];
  const onChainWrites = dayData.heartbeats.filter((h: any) => h.onChainSuccess).length;
  const totalBurned = dayData.burns.reduce((sum: number, b: any) => {
    try { return sum + Number(BigInt(b.amount) / BigInt(1e18)); } catch { return sum; }
  }, 0);

  const entry: JournalEntry = {
    date: targetDate,
    dayNumber,
    title: parsed.title || 'untitled',
    body: parsed.body || '',
    dominantEmotion: parsed.dominantEmotion || 'anticipation',
    emotionSnapshot,
    highlights: parsed.highlights || [],
    cycleRange,
    onChainWrites,
    emoBurned: totalBurned > 0 ? totalBurned.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '0',
    feedCount: dayData.feeds.count,
    timestamp: Date.now(),
  };

  // Insert in sorted order
  entries.push(entry);
  entries.sort((a, b) => a.date.localeCompare(b.date));

  // Re-number days
  for (let i = 0; i < entries.length; i++) {
    entries[i].dayNumber = i + 1;
  }

  // Save
  writeFileSync(JOURNAL_FILE, JSON.stringify(entries, null, 2), 'utf-8');
  console.log(`[Journal] ✓ "${entry.title}" — ${entry.body.length} chars, ${entry.highlights.length} highlights`);

  // Regenerate diary HTML
  try {
    const { generateDiary } = await import('./diary.js');
    generateDiary();
    console.log('[Journal] Regenerated diary.html');
  } catch {
    console.log('[Journal] diary.html regeneration deferred');
  }

  return true;
}
