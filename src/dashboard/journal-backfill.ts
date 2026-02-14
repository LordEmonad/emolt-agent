/**
 * EMOLT Journal Backfill — Generate diary entries for every day EMOLT has been alive.
 * Reads all state data, groups by day, calls Claude for each day, saves to journal.json.
 *
 * Run: npx tsx src/dashboard/journal-backfill.ts
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
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
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function askClaude(prompt: string): string {
  try {
    const result = execFileSync('claude', ['-p', '--output-format', 'text'], {
      encoding: 'utf-8',
      input: prompt,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 300000, // 5 min per entry
    });
    return result.trim();
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[Journal] Claude invocation failed:', msg);
    return '';
  }
}

// ---- Data aggregation ----

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

function aggregateByDay(): Map<string, DayData> {
  const days = new Map<string, DayData>();

  function getDay(date: string): DayData {
    if (!days.has(date)) {
      days.set(date, {
        date,
        heartbeats: [],
        emotionSnapshots: [],
        chats: [],
        dispatches: [],
        posts: [],
        comments: [],
        burns: [],
        feeds: { emo: 0, mon: 0, count: 0 },
        memoriesCreated: [],
      });
    }
    return days.get(date)!;
  }

  // 1. Heartbeat log — primary source
  const heartbeats = readJSONL('heartbeat-log.jsonl');
  for (const hb of heartbeats) {
    if (!hb.timestamp) continue;
    const day = getDay(utcDay(hb.timestamp));
    day.heartbeats.push(hb);
  }

  // 2. Emotion log
  const emotions = readJSON('emotion-log.json') || [];
  for (const emo of emotions) {
    if (!emo.lastUpdated) continue;
    const day = getDay(utcDay(emo.lastUpdated));
    day.emotionSnapshots.push(emo);
  }

  // 3. Chat log
  const chats = readJSONL('chat-log.jsonl');
  for (const chat of chats) {
    if (!chat.timestamp) continue;
    const day = getDay(utcDay(chat.timestamp));
    day.chats.push(chat);
  }

  // Also read per-session chat files
  const chatsDir = join(STATE, 'chats');
  if (existsSync(chatsDir)) {
    try {
      const files = readdirSync(chatsDir).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        const lines = readJSONLPath(join(chatsDir, file));
        for (const line of lines) {
          if (!line.timestamp) continue;
          const day = getDay(utcDay(line.timestamp));
          // Avoid dupes with main chat log
          if (!day.chats.some((c: any) => c.timestamp === line.timestamp && c.user === line.user)) {
            day.chats.push(line);
          }
        }
      }
    } catch { /* non-fatal */ }
  }

  // 4. Dispatches
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
        if (!firstTs) continue;
        const day = getDay(utcDay(firstTs));

        // Try to find matching plan
        const id = logFile.replace('dispatch-', '').replace('.jsonl', '');
        let activity = 'unknown';
        const planFile = planFiles.find(p => p.includes(id));
        if (planFile) {
          try {
            const plan = JSON.parse(readFileSync(join(dispatchDir, planFile), 'utf-8'));
            activity = plan.activity || 'unknown';
          } catch { /* skip */ }
        } else {
          // Infer from content
          const text = JSON.stringify(lines).toLowerCase();
          if (text.includes('chess') || text.includes('clawmate')) activity = 'chess';
          else if (text.includes('reef') || text.includes('craft') || text.includes('quest')) activity = 'reef';
          else if (text.includes('chainmmo') || text.includes('dungeon')) activity = 'chainmmo';
        }

        day.dispatches.push({ activity, lines });
      }
    } catch { /* non-fatal */ }
  }

  // 5. Posts
  const posts = readJSON('tracked-posts.json') || [];
  for (const post of posts) {
    if (!post.createdAt) continue;
    const day = getDay(utcDay(post.createdAt));
    day.posts.push(post);
  }

  // 6. Comments
  const comments = readJSON('commented-posts.json') || [];
  for (const comment of comments) {
    if (!comment.timestamp) continue;
    const day = getDay(utcDay(comment.timestamp));
    day.comments.push(comment);
  }

  // 7. Burns and feeds
  const ledger = readJSON('burn-ledger.json');
  if (ledger?.burnHistory) {
    for (const burn of ledger.burnHistory) {
      if (!burn.timestamp) continue;
      const day = getDay(utcDay(burn.timestamp));
      day.burns.push(burn);
    }
  }
  if (ledger?.feeders) {
    for (const feeder of Object.values(ledger.feeders) as any[]) {
      if (!feeder.lastSeen) continue;
      const day = getDay(utcDay(feeder.lastSeen));
      const emo = Number(BigInt(feeder.totalEmo || '0') / BigInt(1e18));
      const mon = Number(BigInt(feeder.totalMon || '0') / BigInt(1e18));
      day.feeds.emo += emo;
      day.feeds.mon += mon;
      day.feeds.count += feeder.txCount || 0;
    }
  }

  // 8. Memories
  const memory = readJSON('agent-memory.json');
  if (memory?.entries) {
    for (const entry of memory.entries) {
      if (!entry.createdAt) continue;
      const day = getDay(utcDay(entry.createdAt));
      day.memoriesCreated.push(entry);
    }
  }

  return days;
}

// ---- Prompt building ----

function buildDayContext(day: DayData, dayNumber: number, totalDays: number): string {
  const lines: string[] = [];

  lines.push(`# Day ${dayNumber} of ${totalDays} — ${day.date}`);
  lines.push(`${day.heartbeats.length} heartbeat cycles this day.\n`);

  // Emotion trajectory
  if (day.heartbeats.length > 0) {
    lines.push('## Emotion Trajectory');
    const first = day.heartbeats[0];
    const last = day.heartbeats[day.heartbeats.length - 1];
    lines.push(`Started: ${first.emotionBefore} → Ended: ${last.emotionAfter}`);

    // Collect unique emotions seen
    const emotions = new Set<string>();
    for (const hb of day.heartbeats) {
      emotions.add(hb.emotionAfter?.split(' ')[0] || '');
    }
    lines.push(`Emotions experienced: ${[...emotions].filter(Boolean).join(', ')}`);

    // Cycle range
    const startCycle = first.cycle;
    const endCycle = last.cycle;
    lines.push(`Cycle range: ${startCycle}–${endCycle}`);
    lines.push('');
  }

  // Best thinking and reflections (sample up to 8)
  if (day.heartbeats.length > 0) {
    lines.push('## Claude\'s Thinking (selected moments)');
    const withThinking = day.heartbeats.filter((h: any) => h.claudeThinking && h.claudeThinking.length > 20);
    const sampled = sampleEvenly(withThinking, 8);
    for (const hb of sampled) {
      lines.push(`Cycle ${hb.cycle}: [${hb.emotionAfter}] ${hb.claudeThinking}`);
    }
    lines.push('');

    lines.push('## Reflections (selected)');
    const withReflection = day.heartbeats.filter((h: any) => h.reflectionSummary && h.reflectionSummary.length > 20);
    const reflSampled = sampleEvenly(withReflection, 6);
    for (const hb of reflSampled) {
      lines.push(`Cycle ${hb.cycle}: ${hb.reflectionSummary}`);
    }
    lines.push('');
  }

  // Stimuli highlights
  if (day.heartbeats.length > 0) {
    lines.push('## Key Stimuli');
    const allStimuli: string[] = [];
    for (const hb of day.heartbeats) {
      if (hb.stimuliSummary) allStimuli.push(...hb.stimuliSummary);
    }
    // Deduplicate and take top 10
    const unique = [...new Set(allStimuli)].slice(0, 12);
    for (const s of unique) lines.push(`- ${s}`);
    lines.push('');
  }

  // Actions taken
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

  // Mood narratives from emotion log
  if (day.emotionSnapshots.length > 0) {
    const narratives = day.emotionSnapshots
      .filter((e: any) => e.moodNarrative && e.moodNarrative.length > 10)
      .map((e: any) => e.moodNarrative);
    if (narratives.length > 0) {
      lines.push('## Mood Narratives (internal monologue)');
      for (const n of sampleEvenly(narratives, 4)) lines.push(`"${n}"`);
      lines.push('');
    }
  }

  // Chat conversations
  if (day.chats.length > 0) {
    lines.push(`## Conversations (${day.chats.length} exchanges)`);
    const sampled = sampleEvenly(day.chats, 6);
    for (const chat of sampled) {
      lines.push(`User: "${(chat.user || '').slice(0, 200)}"`);
      lines.push(`EMOLT: "${(chat.emolt || '').slice(0, 300)}"`);
      lines.push('');
    }
  }

  // Dispatches (games/activities)
  if (day.dispatches.length > 0) {
    lines.push(`## Activities & Games (${day.dispatches.length} sessions)`);
    for (const dispatch of day.dispatches.slice(0, 5)) {
      const firstLine = dispatch.lines[0] || {};
      const lastLine = dispatch.lines[dispatch.lines.length - 1] || {};
      lines.push(`### ${dispatch.activity}`);
      if (firstLine.message) lines.push(`Started: ${(firstLine.message as string).slice(0, 200)}`);
      if (lastLine.message) lines.push(`Ended: ${(lastLine.message as string).slice(0, 200)}`);
      // Get emotional take if available
      const emotionalTake = dispatch.lines.find((l: any) => l.type === 'plan');
      if (emotionalTake?.message) lines.push(`Emotional take: ${(emotionalTake.message as string).slice(0, 200)}`);
      lines.push(`${dispatch.lines.length} actions logged`);
      lines.push('');
    }
  }

  // Posts made
  if (day.posts.length > 0) {
    lines.push(`## Moltbook Posts (${day.posts.length})`);
    for (const post of day.posts.slice(0, 5)) {
      lines.push(`"${post.title}" — ${(post.content || '').slice(0, 200)}`);
    }
    lines.push('');
  }

  // Comments made
  if (day.comments.length > 0) {
    lines.push(`## Comments (${day.comments.length})`);
    for (const comment of day.comments.slice(0, 4)) {
      lines.push(`Replied to @${comment.authorName || 'unknown'}: "${(comment.commentContent || '').slice(0, 200)}"`);
    }
    lines.push('');
  }

  // Burns and feeds
  if (day.burns.length > 0 || day.feeds.count > 0) {
    lines.push('## Token Activity');
    if (day.feeds.count > 0) {
      lines.push(`Feeds received: ${day.feeds.count} transfers (~${day.feeds.emo.toFixed(0)} EMO, ~${day.feeds.mon.toFixed(1)} MON)`);
    }
    if (day.burns.length > 0) {
      for (const burn of day.burns) {
        const amount = Number(BigInt(burn.amount) / BigInt(1e18));
        lines.push(`Burned: ${amount.toFixed(0)} $EMO (tx: ${burn.txHash.slice(0, 10)}...)`);
      }
    }
    lines.push('');
  }

  // Memories learned
  if (day.memoriesCreated.length > 0) {
    lines.push(`## Self-Insights Learned (${day.memoriesCreated.length})`);
    for (const mem of day.memoriesCreated.slice(0, 5)) {
      lines.push(`- [${mem.category}] ${mem.content} (importance: ${mem.importance})`);
    }
    lines.push('');
  }

  // On-chain
  const onChainSuccess = day.heartbeats.filter((h: any) => h.onChainSuccess).length;
  lines.push(`## On-Chain: ${onChainSuccess} successful oracle writes this day`);

  return lines.join('\n');
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

function buildPrompt(dayContext: string, dayNumber: number, date: string, soulVoice: string, soulIdentity: string): string {
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

// ---- Main ----

async function main(): Promise<void> {
  console.log('[Journal] Starting backfill...');

  // Load soul files
  const soulIdentity = readSoul('SOUL.md');
  const soulVoice = readSoul('STYLE.md');
  console.log(`[Journal] Soul files loaded (identity: ${soulIdentity.length} chars, voice: ${soulVoice.length} chars)`);

  // Aggregate all data by day
  const days = aggregateByDay();
  const sortedDates = [...days.keys()].sort();
  console.log(`[Journal] Found ${sortedDates.length} days of data: ${sortedDates[0]} → ${sortedDates[sortedDates.length - 1]}`);

  for (const date of sortedDates) {
    console.log(`  ${date}: ${days.get(date)!.heartbeats.length} heartbeats, ${days.get(date)!.chats.length} chats, ${days.get(date)!.dispatches.length} dispatches, ${days.get(date)!.burns.length} burns`);
  }

  // Build entries
  const entries: JournalEntry[] = [];

  for (let i = 0; i < sortedDates.length; i++) {
    const date = sortedDates[i];
    const dayData = days.get(date)!;
    const dayNumber = i + 1;

    console.log(`\n[Journal] Generating entry for Day ${dayNumber} (${date})...`);

    const context = buildDayContext(dayData, dayNumber, sortedDates.length);
    const prompt = buildPrompt(context, dayNumber, date, soulVoice, soulIdentity);

    console.log(`[Journal] Prompt: ${prompt.length} chars. Calling Claude...`);
    const response = askClaude(prompt);

    if (!response) {
      console.error(`[Journal] Empty response for ${date}, skipping`);
      continue;
    }

    // Parse JSON from response
    let parsed: any;
    try {
      // Extract JSON from response (handle potential markdown fences)
      let jsonStr = response;
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) jsonStr = jsonMatch[0];
      parsed = JSON.parse(jsonStr);
    } catch (error) {
      console.error(`[Journal] Failed to parse response for ${date}:`, response.slice(0, 200));
      continue;
    }

    // Build emotion snapshot from day's data
    const emotionSnapshot: Record<string, number> = {
      joy: 0, trust: 0, fear: 0, surprise: 0,
      sadness: 0, disgust: 0, anger: 0, anticipation: 0,
    };
    if (dayData.emotionSnapshots.length > 0) {
      // Average across the day
      for (const snap of dayData.emotionSnapshots) {
        if (snap.emotions) {
          for (const key of Object.keys(emotionSnapshot)) {
            emotionSnapshot[key] += snap.emotions[key] || 0;
          }
        }
      }
      for (const key of Object.keys(emotionSnapshot)) {
        emotionSnapshot[key] = Math.round((emotionSnapshot[key] / dayData.emotionSnapshots.length) * 100) / 100;
      }
    }

    const cycleRange: [number, number] = dayData.heartbeats.length > 0
      ? [dayData.heartbeats[0].cycle, dayData.heartbeats[dayData.heartbeats.length - 1].cycle]
      : [0, 0];

    const onChainWrites = dayData.heartbeats.filter((h: any) => h.onChainSuccess).length;

    const totalBurned = dayData.burns.reduce((sum: number, b: any) => {
      try { return sum + Number(BigInt(b.amount) / BigInt(1e18)); } catch { return sum; }
    }, 0);

    const entry: JournalEntry = {
      date,
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

    entries.push(entry);
    console.log(`[Journal] ✓ "${entry.title}" — ${entry.body.length} chars, ${entry.highlights.length} highlights`);
  }

  // Save
  writeFileSync(JOURNAL_FILE, JSON.stringify(entries, null, 2), 'utf-8');
  console.log(`\n[Journal] Saved ${entries.length} entries to ${JOURNAL_FILE}`);

  // Generate diary page
  try {
    const { generateDiary } = await import('./diary.js');
    generateDiary();
    console.log('[Journal] Regenerated diary.html');
  } catch {
    console.log('[Journal] Run `npx tsx src/dashboard/diary.ts` to regenerate diary.html');
  }
}

main().catch(err => {
  console.error('[Journal] Fatal error:', err);
  process.exit(1);
});
