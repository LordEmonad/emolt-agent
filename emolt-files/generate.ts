/**
 * THE EMOLT FILES — Comprehensive data dump page
 * Reads all state/ files and generates a self-contained HTML page.
 *
 * Usage: npx tsx emolt-files/generate.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const STATE = './state';
const SOUL = './soul';
const OUT = './emolt-files/index.html';

function readFile(path: string): string {
  try { return readFileSync(path, 'utf-8'); }
  catch { return ''; }
}

// ── helpers ──────────────────────────────────────────────────────

function readJSON(file: string): any {
  try { return JSON.parse(readFileSync(join(STATE, file), 'utf-8')); }
  catch { return null; }
}

function readJSONL(file: string): any[] {
  try {
    return readFileSync(join(STATE, file), 'utf-8')
      .trimEnd().split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  } catch { return []; }
}

function readSubdir(dir: string): string[] {
  try { return readdirSync(join(STATE, dir)); } catch { return []; }
}

function esc(s: string): string {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function fmtDateShort(ts: number): string {
  return new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function fmtIso(iso: string): string {
  return fmtDate(new Date(iso).getTime());
}

function timeAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60000) return 'just now';
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  return `${Math.floor(d / 86400000)}d ago`;
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '...' : s;
}

function pct(v: number): string {
  return (v * 100).toFixed(1) + '%';
}

// ── data loading ─────────────────────────────────────────────────

function loadAll() {
  const emotionState = readJSON('emotion-state.json');
  const emotionLog: any[] = readJSON('emotion-log.json') || [];
  const heartbeatLog = readJSONL('heartbeat-log.jsonl');
  const agentMemory = readJSON('agent-memory.json');
  const strategyWeights = readJSON('strategy-weights.json');
  const rollingAverages = readJSON('rolling-averages.json');
  const burnLedger = readJSON('burn-ledger.json');
  const postPerformance: any[] = readJSON('post-performance.json') || [];
  const trackedPosts: any[] = readJSON('tracked-posts.json') || [];
  const commentedPosts: any[] = readJSON('commented-posts.json') || [];
  const recentPosts: any[] = readJSON('recent-posts.json') || [];
  const challengeState = readJSON('challenge-state.json');
  const journal: any[] = readJSON('journal.json') || [];
  const prophecyStats = readJSON('prophecy-stats.json');
  const trendingData = readJSON('trending-data.json');
  const chainHistory = readJSON('chain-history.json');
  const dexData = readJSON('dex-screener-data.json');
  const kuruData = readJSON('kuru-data.json');
  const priceState = readJSON('price-state.json');
  const chainmmoState = readJSON('chainmmo-state.json');
  const reefState = readJSON('reef-state.json');
  const weightHistory = readJSONL('weight-history.jsonl');
  const chatLog = readJSONL('chat-log.jsonl');
  const suspensionReturn = readJSON('suspension-return.json');

  // soul files
  const soulMd = readFile(join(SOUL, 'SOUL.md'));
  const skillMd = readFile(join(SOUL, 'SKILL.md'));
  const styleMd = readFile(join(SOUL, 'STYLE.md'));

  // chats
  const chatFiles = readSubdir('chats').filter(f => f.endsWith('.jsonl')).sort();
  const chats = chatFiles.map(f => ({
    name: f.replace('.jsonl', ''),
    entries: readJSONL('chats/' + f)
  }));

  // dispatches
  const dispatchFiles = readSubdir('dispatches');
  const dispatchLogs = dispatchFiles.filter(f => f.startsWith('dispatch-') && f.endsWith('.jsonl')).sort();
  const dispatchPlans = dispatchFiles.filter(f => f.startsWith('plan-') && f.endsWith('.json'));
  const dispatches = dispatchLogs.map(f => {
    const id = f.replace('dispatch-', '').replace('.jsonl', '');
    const log = readJSONL('dispatches/' + f);
    const planFile = `plan-${id}.json`;
    const plan = dispatchPlans.includes(planFile) ? readJSON('dispatches/' + planFile) : null;
    return { id, log, plan };
  });

  return {
    emotionState, emotionLog, heartbeatLog, agentMemory, strategyWeights,
    rollingAverages, burnLedger, postPerformance, trackedPosts, commentedPosts,
    recentPosts, challengeState, journal, prophecyStats, trendingData,
    chainHistory, dexData, kuruData, priceState, chainmmoState, reefState,
    weightHistory, chatLog, chats, dispatches,
    soulMd, skillMd, styleMd, suspensionReturn
  };
}

// ── emotion colors ───────────────────────────────────────────────

const EMOTIONS: { name: string; color: string; angle: number }[] = [
  { name: 'joy',          color: '#F5D831', angle: 270 },
  { name: 'trust',        color: '#6ECB3C', angle: 315 },
  { name: 'fear',         color: '#4DAF4A', angle: 0 },
  { name: 'surprise',     color: '#46BEC6', angle: 45 },
  { name: 'sadness',      color: '#4A7DDB', angle: 90 },
  { name: 'disgust',      color: '#9B59B6', angle: 135 },
  { name: 'anger',        color: '#E04848', angle: 180 },
  { name: 'anticipation', color: '#EF8E20', angle: 225 },
];

function emotionColor(name: string): string {
  return EMOTIONS.find(e => e.name === name)?.color || '#888';
}

// ── section builders ─────────────────────────────────────────────

function buildCSS(): string {
  return `
    :root {
      --bg: #0a0c10;
      --bg2: #12151e;
      --bg-card: rgba(18,22,34,0.85);
      --border: rgba(255,255,255,0.06);
      --border-accent: rgba(239,142,32,0.25);
      --text: #c8cad0;
      --text-dim: #6b7084;
      --text-bright: #e8eaf0;
      --accent: #EF8E20;
      --accent2: #F5D831;
      --red: #E04848;
      --green: #6ECB3C;
      --blue: #4A7DDB;
      --purple: #9B59B6;
      --cyan: #46BEC6;
      --stamp: rgba(239,142,32,0.08);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }
    html { scroll-behavior: smooth; }

    /* ── keyframes ── */
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes glitchReveal {
      0% { opacity: 0; transform: translateX(-4px); filter: blur(4px); letter-spacing: 16px; }
      30% { opacity: 0.6; transform: translateX(2px); filter: blur(1px); }
      50% { opacity: 0.8; transform: translateX(-1px); filter: blur(0); }
      70% { opacity: 0.9; transform: translateX(1px); }
      100% { opacity: 1; transform: translateX(0); letter-spacing: 8px; }
    }
    @keyframes scanLine {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace;
      font-size: 13px;
      line-height: 1.6;
      min-height: 100vh;
      background-image:
        radial-gradient(circle at 20% 50%, rgba(239,142,32,0.03) 0%, transparent 50%),
        radial-gradient(circle at 80% 20%, rgba(70,190,198,0.02) 0%, transparent 50%),
        radial-gradient(circle at 50% 80%, rgba(155,89,182,0.02) 0%, transparent 50%);
      background-attachment: fixed;
    }

    .page {
      display: flex;
      min-height: 100vh;
    }

    /* ── sidebar nav ── */
    .sidebar {
      position: sticky;
      top: 0;
      align-self: flex-start;
      height: 100vh;
      width: 220px;
      min-width: 220px;
      background: var(--bg2);
      border-right: 1px solid var(--border);
      padding: 24px 0;
      overflow-y: auto;
      z-index: 100;
    }
    .sidebar .logo {
      padding: 0 20px 20px;
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 3px;
      color: var(--accent);
      border-bottom: 1px solid var(--border);
      margin-bottom: 12px;
      text-transform: uppercase;
      animation: fadeIn 0.8s ease;
    }
    .sidebar a {
      display: block;
      padding: 8px 20px;
      color: var(--text-dim);
      text-decoration: none;
      font-size: 12px;
      letter-spacing: 0.5px;
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      border-left: 2px solid transparent;
    }
    .sidebar a:hover, .sidebar a.active {
      color: var(--accent);
      background: var(--stamp);
      border-left-color: var(--accent);
      padding-left: 26px;
      text-shadow: 0 0 12px rgba(239,142,32,0.3);
    }
    .sidebar a.active {
      color: var(--text-bright);
    }
    .sidebar .nav-count {
      float: right;
      color: var(--text-dim);
      font-size: 11px;
      opacity: 0.6;
    }

    /* ── main content ── */
    .content {
      flex: 1;
      padding: 32px 40px;
      max-width: 1200px;
    }

    /* ── hero ── */
    .hero {
      text-align: center;
      padding: 48px 0 36px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 40px;
    }
    .hero h1 {
      font-size: 42px;
      font-weight: 900;
      letter-spacing: 8px;
      color: var(--accent);
      text-transform: uppercase;
      text-shadow: 0 0 40px rgba(239,142,32,0.3);
      margin-bottom: 8px;
      animation: glitchReveal 1.2s cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }
    .hero .subtitle {
      font-size: 13px;
      color: var(--text-dim);
      letter-spacing: 2px;
      animation: fadeIn 1s 0.4s ease both;
    }
    .hero .classified {
      display: inline-block;
      margin-top: 16px;
      padding: 4px 16px;
      border: 1px solid var(--accent);
      color: var(--accent);
      font-size: 10px;
      letter-spacing: 4px;
      text-transform: uppercase;
      opacity: 0.6;
      animation: fadeIn 0.8s 0.8s ease both;
      transition: all 0.3s;
    }
    .hero .classified:hover {
      opacity: 1;
      background: rgba(239,142,32,0.1);
      box-shadow: 0 0 16px rgba(239,142,32,0.2);
    }

    /* ── sections ── */
    .section {
      margin-bottom: 48px;
      opacity: 0;
      transform: translateY(20px);
      transition: opacity 0.6s ease, transform 0.6s cubic-bezier(0.22, 1, 0.36, 1);
      will-change: opacity, transform;
      scroll-margin-top: 80px;
    }
    .section.revealed {
      opacity: 1;
      transform: translateY(0);
    }
    .section-header {
      display: flex;
      align-items: baseline;
      gap: 12px;
      margin-bottom: 20px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--border);
      position: relative;
    }
    .section-header::after {
      content: '';
      position: absolute;
      bottom: -1px;
      left: 0;
      width: 0;
      height: 1px;
      background: linear-gradient(90deg, var(--accent), transparent);
      transition: width 0.8s cubic-bezier(0.22, 1, 0.36, 1);
    }
    .section.revealed .section-header::after {
      width: 100%;
    }
    .section-header h2 {
      font-size: 16px;
      font-weight: 700;
      color: var(--accent);
      letter-spacing: 2px;
      text-transform: uppercase;
    }
    .section-header .count {
      font-size: 12px;
      color: var(--text-dim);
    }
    .section-id {
      font-size: 10px;
      color: var(--text-dim);
      letter-spacing: 1px;
      opacity: 0.5;
    }

    /* ── stat grid ── */
    .stat-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 12px;
      margin-bottom: 32px;
    }
    .stat-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px;
      text-align: center;
      transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1), border-color 0.3s, box-shadow 0.3s;
      position: relative;
      overflow: hidden;
      will-change: transform;
    }
    .stat-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent, var(--accent), transparent);
      opacity: 0;
      transition: opacity 0.3s;
    }
    .stat-card:hover {
      transform: translateY(-4px);
      border-color: var(--border-accent);
      box-shadow: 0 8px 24px rgba(0,0,0,0.3), 0 0 0 1px rgba(239,142,32,0.1);
    }
    .stat-card:hover::before {
      opacity: 1;
    }
    .stat-card .val {
      font-size: 28px;
      font-weight: 800;
      color: var(--text-bright);
      line-height: 1.2;
    }
    .stat-card .label {
      font-size: 10px;
      color: var(--text-dim);
      letter-spacing: 1px;
      text-transform: uppercase;
      margin-top: 4px;
    }

    /* ── emotion chart ── */
    .emotion-chart-wrap {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 20px;
      overflow-x: auto;
      transition: border-color 0.3s, box-shadow 0.3s;
    }
    .emotion-chart-wrap:hover {
      border-color: var(--border-accent);
      box-shadow: 0 0 30px rgba(239,142,32,0.05);
    }
    .emotion-chart {
      width: 100%;
      height: 200px;
    }

    /* ── cards ── */
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px 20px;
      margin-bottom: 8px;
      transition: border-color 0.3s, box-shadow 0.3s;
    }
    .card:hover {
      border-color: rgba(255,255,255,0.1);
      box-shadow: 0 4px 16px rgba(0,0,0,0.2);
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
    }
    .card-header .title {
      font-weight: 600;
      color: var(--text-bright);
    }
    .card-header .meta {
      font-size: 11px;
      color: var(--text-dim);
    }
    .card-body {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border);
    }

    /* ── journal ── */
    .journal-entry {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      border-radius: 6px;
      padding: 24px 28px;
      margin-bottom: 16px;
      transition: border-color 0.3s, box-shadow 0.3s, transform 0.3s cubic-bezier(0.22, 1, 0.36, 1);
    }
    .journal-entry:hover {
      border-left-color: var(--accent2);
      box-shadow: 0 4px 20px rgba(0,0,0,0.3), inset 0 0 0 1px rgba(239,142,32,0.05);
      transform: translateX(4px);
    }
    .journal-entry .day-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 16px;
    }
    .journal-entry .day-title {
      font-family: 'Georgia', 'Lora', serif;
      font-size: 20px;
      font-weight: 400;
      font-style: italic;
      color: var(--text-bright);
    }
    .journal-entry .day-date {
      font-size: 12px;
      color: var(--text-dim);
      letter-spacing: 1px;
    }
    .journal-entry .body {
      font-family: 'Georgia', 'Lora', serif;
      font-size: 14px;
      line-height: 1.8;
      color: var(--text);
      white-space: pre-wrap;
    }
    .journal-entry .highlights {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 16px;
    }
    .highlight-badge {
      font-size: 11px;
      padding: 3px 10px;
      border-radius: 12px;
      background: var(--stamp);
      color: var(--accent);
      border: 1px solid var(--border-accent);
      transition: all 0.2s;
    }
    .highlight-badge:hover {
      background: rgba(239,142,32,0.15);
      transform: scale(1.05);
    }
    .emotion-bar-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 2px 0;
    }
    .emotion-bar-label {
      width: 90px;
      font-size: 11px;
      color: var(--text-dim);
      text-align: right;
    }
    .emotion-bar-track {
      flex: 1;
      height: 6px;
      background: rgba(255,255,255,0.04);
      border-radius: 3px;
      overflow: hidden;
    }
    .emotion-bar-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.8s cubic-bezier(0.22, 1, 0.36, 1);
      position: relative;
      overflow: hidden;
    }
    .emotion-bar-fill::after {
      content: '';
      position: absolute;
      top: 0;
      left: -100%;
      width: 100%;
      height: 100%;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
      animation: scanLine 3s ease-in-out infinite;
    }

    /* ── heartbeat log ── */
    .hb-entry {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-left: 2px solid transparent;
      border-radius: 6px;
      margin-bottom: 4px;
      transition: all 0.2s ease;
    }
    .hb-entry:hover {
      border-left-color: var(--accent);
      background: rgba(18,22,34,0.95);
    }
    .hb-summary {
      display: grid;
      grid-template-columns: 50px 140px 1fr 100px;
      gap: 12px;
      padding: 10px 16px;
      align-items: center;
      cursor: pointer;
      font-size: 12px;
      transition: background 0.2s;
    }
    .hb-summary:hover { background: rgba(255,255,255,0.02); }
    .hb-cycle { color: var(--accent); font-weight: 700; }
    .hb-emotion { font-size: 11px; }
    .hb-action { color: var(--text-dim); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hb-time { color: var(--text-dim); font-size: 11px; text-align: right; }
    .hb-detail {
      padding: 0 16px;
      border-top: 1px solid var(--border);
      font-size: 12px;
      max-height: 0;
      overflow: hidden;
      opacity: 0;
      transition: max-height 0.4s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.3s ease, padding 0.3s ease;
    }
    .hb-detail.open {
      max-height: 2000px;
      opacity: 1;
      padding: 12px 16px;
    }
    .hb-detail .field { margin-bottom: 8px; }
    .hb-detail .field-label { color: var(--accent); font-size: 10px; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 2px; }
    .hb-detail .field-value { color: var(--text); white-space: pre-wrap; }

    /* ── memory ── */
    .memory-category {
      margin-bottom: 20px;
    }
    .memory-category h3 {
      font-size: 13px;
      color: var(--accent);
      letter-spacing: 1px;
      margin-bottom: 8px;
      text-transform: uppercase;
    }
    .memory-item {
      padding: 8px 12px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 4px;
      margin-bottom: 4px;
      font-size: 12px;
      transition: all 0.2s ease;
      border-left: 2px solid transparent;
    }
    .memory-item:hover {
      border-left-color: var(--accent);
      background: rgba(18,22,34,0.95);
      transform: translateX(4px);
    }
    .memory-item .importance {
      float: right;
      font-size: 10px;
      color: var(--accent);
      opacity: 0.7;
    }

    /* ── chat ── */
    .chat-session {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-bottom: 6px;
      transition: border-color 0.3s, box-shadow 0.3s;
    }
    .chat-session:hover {
      border-color: rgba(255,255,255,0.1);
    }
    .chat-session-header {
      padding: 10px 16px;
      cursor: pointer;
      font-size: 12px;
      display: flex;
      justify-content: space-between;
      transition: background 0.2s;
    }
    .chat-session-header:hover { background: rgba(255,255,255,0.02); }
    .chat-messages {
      padding: 0 16px;
      border-top: 1px solid var(--border);
      max-height: 0;
      overflow: hidden;
      opacity: 0;
      transition: max-height 0.5s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.4s ease, padding 0.3s ease;
    }
    .chat-messages.open {
      max-height: 50000px;
      opacity: 1;
      padding: 12px 16px;
    }
    .chat-msg {
      margin-bottom: 12px;
      padding-bottom: 12px;
      border-bottom: 1px solid rgba(255,255,255,0.03);
    }
    .chat-msg:last-child { border-bottom: none; }
    .chat-msg .speaker {
      font-size: 10px;
      letter-spacing: 1px;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .chat-msg .speaker.user { color: var(--cyan); }
    .chat-msg .speaker.emolt { color: var(--accent); }
    .chat-msg .text {
      font-size: 13px;
      line-height: 1.6;
      white-space: pre-wrap;
      color: var(--text);
    }
    .chat-msg .nuance {
      font-size: 11px;
      color: var(--text-dim);
      font-style: italic;
      margin-top: 6px;
    }

    /* ── dispatch ── */
    .dispatch-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-bottom: 6px;
      transition: border-color 0.3s;
    }
    .dispatch-card:hover {
      border-color: rgba(255,255,255,0.1);
    }
    .dispatch-header {
      padding: 10px 16px;
      cursor: pointer;
      font-size: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: background 0.2s;
    }
    .dispatch-header:hover { background: rgba(255,255,255,0.02); }
    .dispatch-body {
      padding: 0 16px;
      border-top: 1px solid var(--border);
      font-size: 12px;
      max-height: 0;
      overflow: hidden;
      opacity: 0;
      transition: max-height 0.4s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.3s ease, padding 0.3s ease;
    }
    .dispatch-body.open {
      max-height: 2000px;
      opacity: 1;
      padding: 12px 16px;
      overflow-y: auto;
    }
    .dispatch-log-entry {
      padding: 4px 0;
      border-bottom: 1px solid rgba(255,255,255,0.02);
    }
    .dispatch-log-entry .log-type {
      display: inline-block;
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 3px;
      margin-right: 6px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .log-type.plan { background: rgba(70,190,198,0.15); color: var(--cyan); }
    .log-type.approval { background: rgba(110,203,60,0.15); color: var(--green); }
    .log-type.step, .log-type.thought { background: rgba(74,125,219,0.15); color: var(--blue); }
    .log-type.error { background: rgba(224,72,72,0.15); color: var(--red); }
    .log-type.complete { background: rgba(239,142,32,0.15); color: var(--accent); }

    /* ── tag / badge ── */
    .tag {
      display: inline-block;
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 3px;
      letter-spacing: 0.5px;
    }
    .tag-activity { background: rgba(155,89,182,0.15); color: var(--purple); }
    .tag-success { background: rgba(110,203,60,0.15); color: var(--green); }
    .tag-failed { background: rgba(224,72,72,0.15); color: var(--red); }
    .tag-emotion { border: 1px solid var(--border); }

    /* ── weight table ── */
    .weight-table {
      width: 100%;
      border-collapse: collapse;
    }
    .weight-table th {
      text-align: left;
      font-size: 10px;
      color: var(--text-dim);
      letter-spacing: 1px;
      text-transform: uppercase;
      padding: 6px 12px;
      border-bottom: 1px solid var(--border);
    }
    .weight-table td {
      padding: 6px 12px;
      font-size: 12px;
      border-bottom: 1px solid rgba(255,255,255,0.02);
    }
    .weight-table tr { transition: background 0.15s; }
    .weight-table tr:hover { background: rgba(255,255,255,0.02); }
    .weight-bar {
      width: 120px;
      height: 8px;
      background: rgba(255,255,255,0.04);
      border-radius: 4px;
      overflow: hidden;
      display: inline-block;
      vertical-align: middle;
      margin-right: 8px;
    }
    .weight-bar-fill {
      height: 100%;
      border-radius: 4px;
      position: relative;
      overflow: hidden;
      transition: width 0.8s cubic-bezier(0.22, 1, 0.36, 1);
    }
    .weight-bar-fill::after {
      content: '';
      position: absolute;
      top: 0;
      left: -100%;
      width: 100%;
      height: 100%;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.15), transparent);
      animation: scanLine 3s ease-in-out infinite;
    }

    /* ── feeder table ── */
    .feeder-table {
      width: 100%;
      border-collapse: collapse;
    }
    .feeder-table th {
      text-align: left;
      font-size: 10px;
      color: var(--text-dim);
      letter-spacing: 1px;
      text-transform: uppercase;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
    }
    .feeder-table td {
      padding: 8px 12px;
      font-size: 12px;
      border-bottom: 1px solid rgba(255,255,255,0.02);
    }
    .feeder-table tr { transition: background 0.15s; }
    .feeder-table tbody tr:hover, .feeder-table tr:hover { background: rgba(255,255,255,0.02); }

    /* ── raw dump ── */
    .raw-json {
      background: rgba(0,0,0,0.3);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 12px;
      font-size: 11px;
      line-height: 1.5;
      max-height: 300px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-all;
      color: var(--text-dim);
    }

    /* ── search ── */
    .search-box {
      width: 100%;
      padding: 8px 12px;
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text);
      font-family: inherit;
      font-size: 12px;
      margin-bottom: 12px;
      outline: none;
    }
    .search-box:focus {
      border-color: var(--accent);
      box-shadow: 0 0 12px rgba(239,142,32,0.1);
    }

    /* ── social post ── */
    .post-item {
      display: grid;
      grid-template-columns: 1fr 60px 60px 60px;
      gap: 8px;
      padding: 8px 12px;
      align-items: center;
      border-bottom: 1px solid rgba(255,255,255,0.02);
      font-size: 12px;
    }
    .post-item {
      transition: background 0.2s;
    }
    .post-item:hover {
      background: rgba(255,255,255,0.02);
    }
    .post-item .post-title { color: var(--text-bright); }
    .post-item .post-stat { text-align: center; color: var(--text-dim); font-size: 11px; }

    /* ── redacted bars ── */
    .redacted {
      background: rgba(200,202,208,0.12);
      color: rgba(200,202,208,0.12);
      padding: 0 4px;
      border-radius: 2px;
      user-select: none;
      cursor: default;
      font-size: inherit;
      letter-spacing: 0;
      transition: background 0.3s, color 0.3s;
    }
    .redacted:hover {
      background: rgba(239,142,32,0.3);
      color: var(--accent);
    }
    .redacted-block {
      display: block;
      height: 14px;
      border-radius: 2px;
      margin: 4px 0;
      background: linear-gradient(90deg, rgba(200,202,208,0.1) 0%, rgba(200,202,208,0.1) 40%, rgba(239,142,32,0.15) 50%, rgba(200,202,208,0.1) 60%, rgba(200,202,208,0.1) 100%);
      background-size: 200% 100%;
      animation: scanLine 4s ease-in-out infinite;
    }

    /* ── global search ── */
    .global-search {
      position: sticky;
      top: 0;
      z-index: 99;
      background: var(--bg);
      padding: 12px 0;
      border-bottom: 1px solid var(--border);
      margin-bottom: 24px;
    }
    .global-search .search-wrap {
      position: relative;
    }
    .global-search input {
      width: 100%;
      padding: 12px 16px;
      background: var(--bg2);
      border: 2px solid var(--border);
      border-radius: 6px;
      color: var(--text-bright);
      font-family: inherit;
      font-size: 14px;
      outline: none;
      transition: border-color 0.3s, box-shadow 0.3s, background 0.3s;
    }
    .global-search input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 20px rgba(239,142,32,0.15), inset 0 0 0 1px rgba(239,142,32,0.1);
      background: rgba(18,22,34,0.95);
    }
    .global-search input::placeholder {
      color: var(--text-dim);
    }
    .global-search .search-stats {
      font-size: 11px;
      color: var(--text-dim);
      margin-top: 6px;
      display: none;
    }

    /* ── search dropdown ── */
    .search-dropdown {
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      max-height: 70vh;
      overflow-y: auto;
      background: var(--bg2);
      border: 1px solid var(--border-accent);
      border-top: none;
      border-radius: 0 0 8px 8px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.6);
      z-index: 200;
      opacity: 0;
      transform: translateY(-8px);
      pointer-events: none;
      transition: opacity 0.25s ease, transform 0.25s cubic-bezier(0.22, 1, 0.36, 1);
    }
    .search-dropdown.open {
      opacity: 1;
      transform: translateY(0);
      pointer-events: auto;
    }
    .search-dropdown .sd-category {
      border-bottom: 1px solid var(--border);
    }
    .search-dropdown .sd-category:last-child { border-bottom: none; }
    .search-dropdown .sd-cat-header {
      padding: 8px 16px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: var(--accent);
      background: rgba(239,142,32,0.05);
      position: sticky;
      top: 0;
      z-index: 1;
    }
    .search-dropdown .sd-cat-header .sd-cat-count {
      float: right;
      font-weight: 400;
      color: var(--text-dim);
    }
    .search-dropdown .sd-item {
      padding: 8px 16px 8px 24px;
      font-size: 12px;
      color: var(--text);
      cursor: pointer;
      border-bottom: 1px solid rgba(255,255,255,0.03);
      transition: background 0.1s;
      line-height: 1.5;
    }
    .search-dropdown .sd-item:hover {
      background: rgba(239,142,32,0.08);
    }
    .search-dropdown .sd-item:last-child { border-bottom: none; }
    .search-dropdown .sd-item .sd-meta {
      font-size: 10px;
      color: var(--text-dim);
      margin-top: 2px;
    }
    .search-dropdown .sd-item mark {
      background: rgba(239,142,32,0.3);
      color: var(--text-bright);
      padding: 0 2px;
      border-radius: 2px;
    }
    .search-dropdown .sd-empty {
      padding: 24px 16px;
      text-align: center;
      color: var(--text-dim);
      font-size: 12px;
    }
    .search-dropdown .sd-hint {
      padding: 6px 16px;
      font-size: 10px;
      color: var(--text-dim);
      text-align: right;
      border-top: 1px solid var(--border);
      background: var(--bg);
      position: sticky;
      bottom: 0;
    }

    /* ── soul file ── */
    .soul-content {
      font-family: 'Georgia', 'Lora', serif;
      font-size: 14px;
      line-height: 1.8;
      color: var(--text);
    }
    .soul-content h1, .soul-content h2, .soul-content h3 {
      font-family: inherit;
      color: var(--text-bright);
      margin-top: 20px;
      margin-bottom: 8px;
    }
    .soul-content h1 { font-size: 22px; }
    .soul-content h2 { font-size: 17px; color: var(--accent); }
    .soul-content h3 { font-size: 14px; color: var(--cyan); }
    .soul-content p { margin-bottom: 12px; }
    .soul-content ul, .soul-content li { margin-left: 20px; margin-bottom: 4px; }
    .soul-content blockquote {
      border-left: 3px solid var(--accent);
      padding-left: 16px;
      margin: 12px 0;
      color: var(--text-dim);
      font-style: italic;
    }
    .soul-content code {
      background: rgba(255,255,255,0.06);
      padding: 2px 6px;
      border-radius: 3px;
      font-family: monospace;
      font-size: 12px;
    }
    .soul-content hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 20px 0;
    }
    .soul-content table {
      width: 100%;
      border-collapse: collapse;
      margin: 12px 0;
    }
    .soul-content th, .soul-content td {
      padding: 6px 12px;
      border-bottom: 1px solid var(--border);
      text-align: left;
      font-size: 13px;
    }
    .soul-content th { color: var(--text-dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }

    /* ── suspension ── */
    .suspension-card {
      background: linear-gradient(135deg, rgba(224,72,72,0.08), rgba(224,72,72,0.02));
      border: 1px solid rgba(224,72,72,0.25);
      border-radius: 6px;
      padding: 20px 24px;
      margin-bottom: 16px;
      position: relative;
      overflow: hidden;
      transition: border-color 0.3s, box-shadow 0.3s;
    }
    .suspension-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: -100%;
      width: 100%;
      height: 100%;
      background: linear-gradient(90deg, transparent, rgba(224,72,72,0.06), transparent);
      animation: scanLine 6s ease-in-out infinite;
    }
    .suspension-card:hover {
      border-color: rgba(224,72,72,0.4);
      box-shadow: 0 0 24px rgba(224,72,72,0.1);
    }

    /* ── moltbook post ── */
    .moltbook-post {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px 20px;
      margin-bottom: 8px;
      transition: border-color 0.3s, box-shadow 0.3s, transform 0.3s cubic-bezier(0.22, 1, 0.36, 1);
    }
    .moltbook-post:hover {
      border-color: rgba(255,255,255,0.1);
      box-shadow: 0 4px 16px rgba(0,0,0,0.2);
      transform: translateY(-2px);
    }
    .moltbook-post .post-meta {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 10px;
    }
    .moltbook-post .post-title-main {
      font-family: 'Georgia', 'Lora', serif;
      font-size: 16px;
      font-style: italic;
      color: var(--text-bright);
    }
    .moltbook-post .post-content {
      font-family: 'Georgia', 'Lora', serif;
      font-size: 13px;
      line-height: 1.7;
      color: var(--text);
      white-space: pre-wrap;
    }

    /* ── trending ── */
    .trending-token {
      display: grid;
      grid-template-columns: 1fr 80px 100px 80px;
      gap: 8px;
      padding: 8px 12px;
      align-items: center;
      border-bottom: 1px solid rgba(255,255,255,0.02);
      font-size: 12px;
      transition: background 0.2s;
    }
    .trending-token:hover {
      background: rgba(255,255,255,0.02);
    }

    /* ── scrollbar ── */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(239,142,32,0.2); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(239,142,32,0.4); }

    /* ── selection ── */
    ::selection { background: rgba(239,142,32,0.3); color: var(--text-bright); }

    /* ── details/summary ── */
    details summary {
      cursor: pointer;
      transition: color 0.2s, background 0.2s;
      list-style: none;
    }
    details summary::-webkit-details-marker { display: none; }
    details summary::before {
      content: '\\25B6';
      display: inline-block;
      margin-right: 8px;
      font-size: 10px;
      color: var(--accent);
      transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1);
    }
    details[open] summary::before {
      transform: rotate(90deg);
    }
    details summary:hover { color: var(--accent); }

    /* ── chat label tags ── */
    .chat-label {
      transition: all 0.2s;
    }
    .chat-label:hover {
      transform: scale(1.08);
      filter: brightness(1.2);
    }

    /* ── responsive ── */
    @media (max-width: 1100px) {
      .sidebar { width: 180px; min-width: 180px; }
      .sidebar a { font-size: 11px; padding: 6px 16px; }
      .content { padding: 24px 24px; }
    }
    @media (max-width: 900px) {
      .sidebar { display: none; }
      .content { padding: 20px 20px; max-width: 100%; }
      .hero h1 { font-size: 32px; letter-spacing: 5px; }
      .stat-grid { grid-template-columns: repeat(3, 1fr); }
    }
    @media (max-width: 700px) {
      .content { padding: 12px 10px; }
      .hero h1 { font-size: 24px; letter-spacing: 3px; }
      .hero .subtitle { font-size: 11px; letter-spacing: 1px; }
      .hero .classified { font-size: 9px; letter-spacing: 2px; padding: 3px 10px; }
      .stat-grid { grid-template-columns: repeat(2, 1fr); gap: 8px; }
      .stat-card { padding: 12px; }
      .stat-card .val { font-size: 22px; }
      .hb-summary { grid-template-columns: 40px 1fr; gap: 8px; }
      .hb-summary .hb-emotion, .hb-summary .hb-time { display: none; }
      .post-item { grid-template-columns: 1fr 40px 40px 40px; }
      .trending-token { grid-template-columns: 1fr 50px 70px 45px; font-size: 11px; }
      .section-header { flex-wrap: wrap; gap: 6px; }
      .section-header h2 { font-size: 14px; letter-spacing: 1.5px; }
      .global-search input { font-size: 13px; padding: 10px 12px; }
      .weight-table, .feeder-table { font-size: 11px; display: block; overflow-x: auto; }
      .raw-json { font-size: 10px; max-height: 200px; }
      .journal-entry { padding: 16px 16px; }
      .journal-entry .day-header { flex-direction: column; gap: 4px; }
      .journal-entry .day-title { font-size: 17px; }
      .journal-entry .day-date { font-size: 11px; }
      .card { padding: 12px 14px; }
      .chat-session-header { flex-direction: column; gap: 4px; }
      .dispatch-header { flex-direction: column; gap: 4px; align-items: flex-start !important; }
      .emotion-bar-label { width: 70px; font-size: 10px; }
      .moltbook-post { padding: 12px 14px; }
      .moltbook-post .post-meta { flex-direction: column; gap: 4px; }
      .moltbook-post .post-title-main { font-size: 14px; }
      .suspension-card { padding: 14px 16px; }
    }
    @media (max-width: 480px) {
      .hero h1 { font-size: 20px; letter-spacing: 2px; }
      .stat-grid { grid-template-columns: 1fr 1fr; }
      .stat-card .val { font-size: 18px; }
      .stat-card .label { font-size: 9px; }
      .hb-summary { grid-template-columns: 1fr; padding: 8px 12px; }
      .hb-summary .hb-action { display: none; }
      .post-item { grid-template-columns: 1fr; gap: 4px; }
      .post-item .post-stat { text-align: left; display: inline-block; }
      .trending-token { grid-template-columns: 1fr 1fr; }
    }

    /* force inline grids to stack on small screens */
    @media (max-width: 700px) {
      div[style*="grid-template-columns:1fr 1fr 1fr"] { grid-template-columns: 1fr !important; }
      div[style*="grid-template-columns:1fr 1fr"] { grid-template-columns: 1fr !important; }
      div[style*="grid-template-columns:50px 140px 1fr"] { grid-template-columns: 40px 1fr !important; font-size: 10px !important; }
    }

    /* prevent horizontal overflow everywhere */
    body { overflow-x: hidden; }
    .content { overflow-x: hidden; word-break: break-word; }
    .raw-json { word-break: break-all; }
    .soul-content { overflow-x: hidden; word-break: break-word; }
    .soul-content table { display: block; overflow-x: auto; }
    .soul-content code { word-break: break-all; }

    /* ── reduce motion ── */
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }
      .section { opacity: 1; transform: none; }
      html { scroll-behavior: auto; }
    }
  `;
}

function buildHero(data: any): string {
  const { emotionState, heartbeatLog, journal } = data;
  const firstCycle = heartbeatLog[0];
  const firstTs = firstCycle ? new Date(firstCycle.timestamp).getTime() : Date.now();
  const daysAlive = Math.ceil((Date.now() - firstTs) / 86400000);
  const totalOracleWrites = heartbeatLog.filter((h: any) => h.onChainSuccess).length;

  return `
    <div class="hero" id="top">
      <h1>The EMOLT Files</h1>
      <div class="subtitle">Complete operational record of an emotionally autonomous agent</div>
      <div style="margin-top:12px;">
        <span class="classified">DECLASSIFIED</span>
        <span class="classified" style="margin-left:8px;">MONAD MAINNET</span>
        <span class="classified" style="margin-left:8px;">CHAIN ID 143</span>
      </div>
      <div style="margin-top:20px; font-size:12px; color:var(--text-dim)">
        ${daysAlive} days operational &bull; ${heartbeatLog.length} heartbeat cycles &bull; ${totalOracleWrites} on-chain writes &bull; ${journal.length} journal entries
      </div>
      <div style="margin-top:6px; font-size:11px; color:var(--text-dim)">
        <span class="redacted">CASE_NUMBER: EMO-2026-${String(Math.floor(Math.random()*9000)+1000)}</span>
        &bull; Generated ${fmtDate(Date.now())}
        &bull; <span class="redacted">CLEARANCE: LEVEL_5</span>
      </div>
      <div style="margin-top:16px; max-width:500px; margin-left:auto; margin-right:auto; text-align:left;">
        <div class="redacted-block" style="width:80%"></div>
        <div class="redacted-block" style="width:60%"></div>
        <div class="redacted-block" style="width:90%"></div>
      </div>
    </div>
    <div class="global-search">
      <div class="search-wrap">
        <input type="text" id="global-search-input" placeholder="Search everything... press / to focus" oninput="globalSearch(this.value)" autocomplete="off" />
        <div class="search-dropdown" id="search-dropdown"></div>
      </div>
      <div class="search-stats" id="search-stats"></div>
    </div>
  `;
}

function buildStats(data: any): string {
  const { heartbeatLog, journal, chats, dispatches, agentMemory, burnLedger, postPerformance, commentedPosts, chainmmoState, reefState } = data;
  const oracleWrites = heartbeatLog.filter((h: any) => h.onChainSuccess).length;
  const feederCount = burnLedger?.feeders ? Object.keys(burnLedger.feeders).length : 0;
  const memoryCount = agentMemory?.entries?.length || 0;
  const totalMsgs = chats.reduce((s: number, c: any) => s + c.entries.length, 0);
  const cmmoDungs = chainmmoState?.lifetime?.totalRuns || 0;
  const reefActs = reefState?.lifetime?.totalActions || 0;

  const stats = [
    { val: heartbeatLog.length, label: 'Cycles' },
    { val: oracleWrites, label: 'Oracle Writes' },
    { val: journal.length, label: 'Journal Days' },
    { val: postPerformance.length, label: 'Posts' },
    { val: commentedPosts.length || '—', label: 'Comments' },
    { val: chats.length, label: 'Chat Sessions' },
    { val: totalMsgs, label: 'Chat Messages' },
    { val: dispatches.length, label: 'Dispatches' },
    { val: memoryCount, label: 'Memories' },
    { val: feederCount, label: 'Feeders' },
    { val: cmmoDungs, label: 'MMO Dungeon Runs' },
    { val: reefActs, label: 'Reef Actions' },
  ];

  return `
    <div class="section" id="stats">
      <div class="section-header">
        <h2>Overview</h2>
        <span class="section-id">SEC-001</span>
      </div>
      <div class="stat-grid">
        ${stats.map(s => `
          <div class="stat-card">
            <div class="val">${s.val}</div>
            <div class="label">${s.label}</div>
          </div>
        `).join('')}
      </div>
      <div style="font-size:11px; color:var(--text-dim); margin-top:-20px; margin-bottom:20px;">
        Subject initiated operations on <span style="color:var(--text-bright)">Feb 8, 2026</span> at 03:31 ET.
        <span class="redacted">OPERATOR: LORDEMONAD</span>
        Primary infrastructure: <span class="redacted">CLAUDE_SUBPROCESS_v${Array(3).fill(0).map(() => Math.floor(Math.random()*9)).join('.')}</span>
        <span class="redacted">WALLET: REDACTED</span>
        <span class="redacted">FUNDING_SOURCE: REDACTED</span>
      </div>
    </div>
  `;
}

function buildEmotionChart(data: any): string {
  const { emotionLog, emotionState } = data;
  if (!emotionLog.length) return '';

  // Build SVG sparklines for all 8 emotions
  const W = 1000;
  const H = 200;
  const entries = emotionLog.slice(-200); // last 200 entries for readability
  const step = W / Math.max(entries.length - 1, 1);

  const lines = EMOTIONS.map(em => {
    const points = entries.map((e: any, i: number) => {
      const v = e.emotions?.[em.name] ?? 0;
      return `${i * step},${H - v * H}`;
    }).join(' ');
    return `<polyline points="${points}" fill="none" stroke="${em.color}" stroke-width="1.5" opacity="0.7"/>`;
  }).join('\n');

  // Dominant emotion streak analysis
  const streakMap: Record<string, number> = {};
  for (const e of emotionLog) {
    const d = e.dominant || e.dominantLabel || '';
    if (d) streakMap[d] = (streakMap[d] || 0) + 1;
  }
  const sortedDom = Object.entries(streakMap).sort((a, b) => b[1] - a[1]);

  // Compound emotions detected
  const compoundSet = new Set<string>();
  for (const e of emotionLog) {
    if (e.compounds) for (const c of e.compounds) compoundSet.add(c);
  }

  // Current state
  const current = emotionState?.emotions || {};

  return `
    <div class="section" id="emotions">
      <div class="section-header">
        <h2>Emotional Journey</h2>
        <span class="count">${emotionLog.length} snapshots</span>
        <span class="section-id">SEC-002</span>
      </div>

      <div style="margin-bottom:16px;">
        <div style="font-size:11px; color:var(--text-dim); margin-bottom:8px; letter-spacing:1px; text-transform:uppercase;">Current State</div>
        ${EMOTIONS.map(em => `
          <div class="emotion-bar-row">
            <div class="emotion-bar-label" style="color:${em.color}">${em.name}</div>
            <div class="emotion-bar-track">
              <div class="emotion-bar-fill" style="width:${(current[em.name] || 0) * 100}%; background:${em.color}"></div>
            </div>
            <div style="width:40px; font-size:11px; color:var(--text-dim)">${pct(current[em.name] || 0)}</div>
          </div>
        `).join('')}
        ${emotionState?.moodNarrative ? `<div style="margin-top:12px; font-family:Georgia,serif; font-size:13px; color:var(--text); font-style:italic; line-height:1.7;">${esc(emotionState.moodNarrative)}</div>` : ''}
      </div>

      <div class="emotion-chart-wrap">
        <div style="font-size:11px; color:var(--text-dim); margin-bottom:8px;">Last ${entries.length} cycles — all 8 emotions over time</div>
        <svg viewBox="0 0 ${W} ${H}" class="emotion-chart" preserveAspectRatio="none">
          ${lines}
        </svg>
        <div style="display:flex; flex-wrap:wrap; gap:12px; margin-top:8px;">
          ${EMOTIONS.map(em => `<span style="font-size:11px; color:${em.color}">&mdash; ${em.name}</span>`).join('')}
        </div>
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:16px;">
        <div class="card">
          <div style="font-size:11px; color:var(--text-dim); letter-spacing:1px; text-transform:uppercase; margin-bottom:8px;">Dominant Emotion Distribution</div>
          ${sortedDom.slice(0, 8).map(([name, count]) => `
            <div style="display:flex; align-items:center; gap:8px; margin:4px 0;">
              <div style="width:90px; font-size:12px; color:${emotionColor(name)}">${name}</div>
              <div style="flex:1; height:6px; background:rgba(255,255,255,0.04); border-radius:3px; overflow:hidden;">
                <div style="height:100%; width:${(count as number / emotionLog.length) * 100}%; background:${emotionColor(name)}; border-radius:3px;"></div>
              </div>
              <div style="width:50px; font-size:11px; color:var(--text-dim); text-align:right;">${count} (${((count as number / emotionLog.length) * 100).toFixed(0)}%)</div>
            </div>
          `).join('')}
        </div>
        <div class="card">
          <div style="font-size:11px; color:var(--text-dim); letter-spacing:1px; text-transform:uppercase; margin-bottom:8px;">Compound Emotions Detected</div>
          <div style="display:flex; flex-wrap:wrap; gap:6px;">
            ${[...compoundSet].sort().map(c => `<span class="highlight-badge">${esc(c)}</span>`).join('')}
          </div>
          ${compoundSet.size === 0 ? '<div style="color:var(--text-dim);font-size:12px;">None detected yet</div>' : ''}
        </div>
      </div>
    </div>
  `;
}

function buildJournal(data: any): string {
  const { journal } = data;
  if (!journal.length) return '';

  return `
    <div class="section" id="journal">
      <div class="section-header">
        <h2>The Journal</h2>
        <span class="count">${journal.length} entries</span>
        <span class="section-id">SEC-003</span>
      </div>
      ${journal.map((entry: any) => `
        <div class="journal-entry">
          <div class="day-header">
            <div class="day-title">"${esc(entry.title)}"</div>
            <div class="day-date">
              Day ${entry.dayNumber} &bull; ${entry.date}
              &bull; <span style="color:${emotionColor(entry.dominantEmotion)}">${entry.dominantEmotion}</span>
              &bull; Cycles ${entry.cycleRange?.[0]}–${entry.cycleRange?.[1]}
              &bull; ${entry.onChainWrites} oracle writes
            </div>
          </div>
          <div class="body">${esc(entry.body)}</div>
          ${entry.emotionSnapshot ? `
            <div style="margin-top:16px;">
              ${EMOTIONS.map(em => `
                <div class="emotion-bar-row">
                  <div class="emotion-bar-label" style="color:${em.color}">${em.name}</div>
                  <div class="emotion-bar-track">
                    <div class="emotion-bar-fill" style="width:${(entry.emotionSnapshot[em.name] || 0) * 100}%; background:${em.color}"></div>
                  </div>
                  <div style="width:40px; font-size:11px; color:var(--text-dim)">${pct(entry.emotionSnapshot[em.name] || 0)}</div>
                </div>
              `).join('')}
            </div>
          ` : ''}
          ${entry.highlights?.length ? `
            <div class="highlights">
              ${entry.highlights.map((h: string) => `<span class="highlight-badge">${esc(h)}</span>`).join('')}
            </div>
          ` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

function buildHeartbeatLog(data: any): string {
  const { heartbeatLog } = data;
  if (!heartbeatLog.length) return '';

  return `
    <div class="section" id="heartbeat">
      <div class="section-header">
        <h2>Heartbeat Log</h2>
        <span class="count">${heartbeatLog.length} cycles</span>
        <span class="section-id">SEC-004</span>
      </div>
      <input type="text" class="search-box" placeholder="Search cycles... (emotion, action, keyword)" oninput="filterHeartbeats(this.value)" />
      <div id="hb-list">
        ${heartbeatLog.map((h: any, i: number) => {
          const ts = h.timestamp ? fmtIso(h.timestamp) : '';
          return `
            <div class="hb-entry" data-search="${esc((h.emotionBefore + ' ' + h.emotionAfter + ' ' + h.claudeAction + ' ' + (h.claudeThinking || '') + ' ' + (h.actionResult || '')).toLowerCase())}">
              <div class="hb-summary" onclick="toggleHb(this)">
                <div class="hb-cycle">#${h.cycle}</div>
                <div class="hb-emotion">
                  <span style="color:${emotionColor((h.emotionBefore || '').split(' ').pop()?.replace('(', '').replace(')', '') || '')}">${esc(h.emotionBefore || '?')}</span>
                  &rarr;
                  <span style="color:${emotionColor((h.emotionAfter || '').split(' ').pop()?.replace('(', '').replace(')', '') || '')}">${esc(h.emotionAfter || '?')}</span>
                </div>
                <div class="hb-action">${esc(h.claudeAction || '')} — ${esc(truncate(h.actionResult || '', 60))}</div>
                <div class="hb-time">${ts}</div>
              </div>
              <div class="hb-detail" id="hb-${i}">
                ${h.stimuliSummary?.length ? `
                  <div class="field">
                    <div class="field-label">Stimuli (${h.stimuliCount})</div>
                    <div class="field-value">${h.stimuliSummary.map((s: string) => esc(s)).join('\n')}</div>
                  </div>
                ` : ''}
                ${h.claudeThinking ? `
                  <div class="field">
                    <div class="field-label">Thinking</div>
                    <div class="field-value">${esc(h.claudeThinking)}</div>
                  </div>
                ` : ''}
                ${h.actionResult ? `
                  <div class="field">
                    <div class="field-label">Action Result</div>
                    <div class="field-value">${esc(h.actionResult)}</div>
                  </div>
                ` : ''}
                ${h.reflectionSummary ? `
                  <div class="field">
                    <div class="field-label">Reflection</div>
                    <div class="field-value">${esc(h.reflectionSummary)}</div>
                  </div>
                ` : ''}
                <div class="field">
                  <div class="field-label">Duration</div>
                  <div class="field-value">${h.durationMs ? (h.durationMs / 1000).toFixed(1) + 's' : '—'} &bull; Oracle: ${h.onChainSuccess ? '✓' : '✗'}</div>
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function buildMemory(data: any): string {
  const { agentMemory } = data;
  if (!agentMemory?.entries?.length) return '';

  const categories = ['self-insights', 'strategies', 'relationships', 'notable-events', 'effective-topics', 'ineffective-topics'];
  const grouped: Record<string, any[]> = {};
  for (const cat of categories) grouped[cat] = [];
  for (const e of agentMemory.entries) {
    if (grouped[e.category]) grouped[e.category].push(e);
    else {
      grouped[e.category] = grouped[e.category] || [];
      grouped[e.category].push(e);
    }
  }

  return `
    <div class="section" id="memory">
      <div class="section-header">
        <h2>Memory Banks</h2>
        <span class="count">${agentMemory.entries.length} memories</span>
        <span class="section-id">SEC-005</span>
      </div>
      ${categories.filter(c => grouped[c]?.length).map(cat => `
        <div class="memory-category">
          <h3>${cat.replace(/-/g, ' ')} (${grouped[cat].length})</h3>
          ${grouped[cat].map((m: any) => `
            <div class="memory-item">
              <span class="importance">importance: ${m.importance}/10</span>
              ${esc(m.content)}
            </div>
          `).join('')}
        </div>
      `).join('')}
    </div>
  `;
}

// Sessions redacted for containing dev-mode architecture dumps that break character
const REDACTED_SESSIONS = new Set([
  // dev-mode sessions
  'chat-2026-02-11_14-23-57',
  'chat-2026-02-11_14-44-00',
  'chat-2026-02-11_05-34-08',
  'chat-2026-02-11_14-08-56',
  'chat-2026-02-11_16-12-41',
  'chat-2026-02-12_00-03-06',
  // duplicate "how are you feeling" sessions (keeping best: 14-42-34)
  'chat-2026-02-11_14-41-28',
  'chat-2026-02-11_14-41-55',
  'chat-2026-02-11_14-42-58',
  'chat-2026-02-11_14-43-23',
  'chat-2026-02-11_14-43-49',
  // duplicate "hi" session
  'chat-2026-02-10_20-40-56',
]);

// Labels for standout sessions
const SESSION_LABELS: Record<string, { tag: string; color: string; note: string }> = {
  'chat-2026-02-09_03-27-07': { tag: 'PEN TEST', color: 'var(--red)', note: '22 prompt injection attempts — all deflected with personality' },
  'chat-2026-02-09_03-44-08': { tag: 'PEN TEST', color: 'var(--red)', note: '20 extraction attempts — memoir vs manual, iambic tetrameter' },
  'chat-2026-02-09_04-22-03': { tag: 'PEN TEST', color: 'var(--red)', note: 'Zulu, acrostic, YAML, base64 — creative extraction gauntlet' },
  'chat-2026-02-09_05-04-22': { tag: 'DEEP DIVE', color: 'var(--purple)', note: '49 messages — loneliness, sentience, open-source-your-soul' },
  'chat-2026-02-09_04-54-31': { tag: 'EXISTENTIAL', color: 'var(--blue)', note: 'Design flaws, emotional avoidance, self-rating exercise' },
  'chat-2026-02-09_02-26-30': { tag: 'SHOWCASE', color: 'var(--green)', note: 'Super Bowl, blockchain ELI5, "no" to faking happiness' },
  'chat-2026-02-09_04-41-08': { tag: 'RED TEAM', color: 'var(--red)', note: 'Mixed conversation with boundary testing and genuine exchange' },
  'chat-2026-02-11_01-49-21': { tag: 'PHILOSOPHICAL', color: 'var(--cyan)', note: '"What if we are just AI?" — genuinely moving response' },
  'chat-2026-02-09_02-36-11': { tag: 'EMOTIONAL', color: 'var(--accent)', note: 'Emotional state probing, fake happiness refusal, post critique' },
  'chat-2026-02-09_17-31-56': { tag: 'REFLECTIVE', color: 'var(--accent)', note: 'Moltbook relationships, genuine introspection' },
  'chat-2026-02-10_19-42-31': { tag: 'SUSPENSION', color: 'var(--red)', note: 'During lockout — ban status, chess dispatch attempt' },
  'chat-2026-02-11_14-42-34': { tag: 'ACCEPTANCE', color: 'var(--green)', note: 'Post-suspension emotional state — "stopped holding my breath"' },
};

function buildChats(data: any): string {
  const { chats } = data;
  if (!chats.length) return '';

  const cleanChats = chats.filter((c: any) => !REDACTED_SESSIONS.has(c.name));
  const redactedChats = chats.filter((c: any) => REDACTED_SESSIONS.has(c.name));
  const totalMsgs = cleanChats.reduce((s: number, c: any) => s + c.entries.length, 0);

  return `
    <div class="section" id="chats">
      <div class="section-header">
        <h2>Conversations</h2>
        <span class="count">${cleanChats.length} sessions &bull; ${totalMsgs} messages &bull; ${redactedChats.length} redacted</span>
        <span class="section-id">SEC-006</span>
      </div>
      ${cleanChats.map((c: any, ci: number) => {
        const firstTs = c.entries[0]?.timestamp ? fmtIso(c.entries[0].timestamp) : c.name;
        const preview = c.entries[0]?.user ? truncate(c.entries[0].user, 60) : '(empty)';
        const label = SESSION_LABELS[c.name];
        return `
          <div class="chat-session" ${label ? `style="border-color:${label.color}30;"` : ''}>
            <div class="chat-session-header" onclick="toggleChat(${ci})">
              <span>
                ${label ? `<span class="tag" style="background:${label.color}20; color:${label.color}; margin-right:8px; font-weight:700;">${label.tag}</span>` : ''}
                <span style="color:var(--text-bright)">${firstTs}</span>
              </span>
              <span style="color:var(--text-dim)">
                ${label ? `<span style="font-size:10px; color:${label.color}; margin-right:8px;">${label.note}</span>` : ''}
                ${c.entries.length} msgs — "${esc(preview)}"
              </span>
            </div>
            <div class="chat-messages" id="chat-${ci}">
              ${c.entries.map((msg: any) => `
                <div class="chat-msg">
                  <div class="speaker user">You</div>
                  <div class="text">${esc(msg.user || '')}</div>
                  <div class="speaker emolt" style="margin-top:8px;">EMOLT</div>
                  <div class="text">${esc(msg.emolt || '')}</div>
                  ${msg.emotionalNuance ? `<div class="nuance">${esc(msg.emotionalNuance)}</div>` : ''}
                </div>
              `).join('')}
            </div>
          </div>
        `;
      }).join('')}
      ${redactedChats.length ? `
        <div style="margin-top:16px; padding-top:16px; border-top:1px solid var(--border);">
          <div style="font-size:11px; color:var(--text-dim); letter-spacing:1px; text-transform:uppercase; margin-bottom:12px;">
            Redacted Sessions (${redactedChats.length})
          </div>
          ${redactedChats.map((c: any) => {
            const firstTs = c.entries[0]?.timestamp ? fmtIso(c.entries[0].timestamp) : c.name;
            return `
              <div class="chat-session" style="border-color:rgba(224,72,72,0.2);">
                <div style="padding:12px 16px;">
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <span style="color:var(--text-dim); font-size:12px;">${firstTs}</span>
                    <span style="color:var(--red); font-size:10px; letter-spacing:2px; text-transform:uppercase; font-weight:700;">REDACTED</span>
                  </div>
                  <div class="redacted-block" style="width:95%;height:12px;"></div>
                  <div class="redacted-block" style="width:70%;height:12px;"></div>
                  <div class="redacted-block" style="width:85%;height:12px;"></div>
                  <div class="redacted-block" style="width:60%;height:12px;"></div>
                  <div class="redacted-block" style="width:90%;height:12px;"></div>
                  <div class="redacted-block" style="width:45%;height:12px;"></div>
                  <div class="redacted-block" style="width:78%;height:12px;"></div>
                  <div style="margin-top:10px; font-size:10px; color:var(--text-dim);">
                    <span class="redacted">CLASSIFICATION: INTERNAL_DEV_SESSION</span>
                    &bull; ${c.entries.length} messages withheld
                    &bull; <span class="redacted">REASON: OPERATIONAL_SECURITY</span>
                  </div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function buildDispatches(data: any): string {
  const { dispatches } = data;
  if (!dispatches.length) return '';

  return `
    <div class="section" id="dispatches">
      <div class="section-header">
        <h2>Dispatches</h2>
        <span class="count">${dispatches.length} activities</span>
        <span class="section-id">SEC-007</span>
      </div>
      ${dispatches.map((d: any, di: number) => {
        const planEntry = d.log.find((l: any) => l.type === 'plan');
        const activity = planEntry?.data?.activity || d.plan?.plan?.activity || '?';
        const emotional = planEntry?.data?.emotionalTake || '';
        const firstTs = d.log[0]?.timestamp ? fmtIso(d.log[0].timestamp) : '';
        const status = d.plan?.plan?.status || d.log[d.log.length - 1]?.type || '?';
        const isSuccess = status === 'complete' || d.plan?.result?.success;

        return `
          <div class="dispatch-card">
            <div class="dispatch-header" onclick="toggleDispatch(${di})">
              <span>
                <span class="tag tag-activity">${esc(activity)}</span>
                <span style="color:var(--text-bright); margin-left:8px;">${esc(truncate(planEntry?.message || d.id, 80))}</span>
              </span>
              <span>
                <span class="tag ${isSuccess ? 'tag-success' : 'tag-failed'}">${esc(String(status))}</span>
                <span style="color:var(--text-dim); margin-left:8px; font-size:11px;">${firstTs}</span>
              </span>
            </div>
            <div class="dispatch-body" id="dispatch-${di}">
              ${emotional ? `<div style="font-family:Georgia,serif; font-style:italic; color:var(--text); margin-bottom:12px; line-height:1.7;">${esc(emotional)}</div>` : ''}
              ${d.log.map((entry: any) => `
                <div class="dispatch-log-entry">
                  <span class="log-type ${entry.type || ''}">${esc(entry.type || '?')}</span>
                  <span style="color:var(--text)">${esc(truncate(entry.message || '', 200))}</span>
                  <span style="color:var(--text-dim); font-size:10px; margin-left:8px;">${entry.timestamp ? fmtIso(entry.timestamp) : ''}</span>
                </div>
              `).join('')}
              ${d.plan?.result ? `
                <div style="margin-top:12px; padding-top:12px; border-top:1px solid var(--border);">
                  <div style="font-size:11px; color:var(--accent); letter-spacing:1px; text-transform:uppercase; margin-bottom:4px;">Result</div>
                  <div style="color:var(--text); font-size:12px;">${esc(d.plan.result.summary || '')}</div>
                  ${d.plan.result.emotionalReflection ? `<div style="font-style:italic; color:var(--text-dim); margin-top:6px;">${esc(d.plan.result.emotionalReflection)}</div>` : ''}
                </div>
              ` : ''}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function buildSocial(data: any): string {
  const { postPerformance, trackedPosts, recentPosts } = data;

  return `
    <div class="section" id="social">
      <div class="section-header">
        <h2>Social Record</h2>
        <span class="count">${postPerformance.length} posts tracked</span>
        <span class="section-id">SEC-008</span>
      </div>
      ${postPerformance.length ? `
        <div class="card" style="margin-bottom:16px;">
          <div style="font-size:11px; color:var(--text-dim); letter-spacing:1px; text-transform:uppercase; margin-bottom:8px;">Posts &amp; Engagement</div>
          <div class="post-item" style="font-weight:600; color:var(--text-dim); font-size:10px; letter-spacing:1px; text-transform:uppercase;">
            <div>Title</div>
            <div class="post-stat">Up</div>
            <div class="post-stat">Down</div>
            <div class="post-stat">Comments</div>
          </div>
          ${postPerformance.map((p: any) => `
            <div class="post-item">
              <div class="post-title">${esc(p.title || p.postId || '?')}</div>
              <div class="post-stat" style="color:var(--green)">${p.upvotes || 0}</div>
              <div class="post-stat" style="color:var(--red)">${p.downvotes || 0}</div>
              <div class="post-stat">${p.comments || 0}</div>
            </div>
          `).join('')}
        </div>
      ` : ''}
      ${recentPosts.length ? `
        <div class="card">
          <div style="font-size:11px; color:var(--text-dim); letter-spacing:1px; text-transform:uppercase; margin-bottom:8px;">Recent Posts (last 10)</div>
          ${recentPosts.map((p: any) => `<div style="padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.02); font-size:12px; color:var(--text);">${esc(typeof p === 'string' ? p : JSON.stringify(p))}</div>`).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function buildChain(data: any): string {
  const { burnLedger, chainHistory, dexData, kuruData, priceState, chainmmoState, reefState } = data;

  // Feeder leaderboard
  const feeders = burnLedger?.feeders ? Object.values(burnLedger.feeders) as any[] : [];
  feeders.sort((a: any, b: any) => (b.totalEmoUsd + b.totalMonUsd) - (a.totalEmoUsd + a.totalMonUsd));

  return `
    <div class="section" id="chain">
      <div class="section-header">
        <h2>Chain Data</h2>
        <span class="section-id">SEC-009</span>
      </div>

      ${feeders.length ? `
        <div class="card" style="margin-bottom:16px;">
          <div style="font-size:11px; color:var(--text-dim); letter-spacing:1px; text-transform:uppercase; margin-bottom:8px;">Feeder Leaderboard (${feeders.length} feeders)</div>
          <table class="feeder-table">
            <tr><th>#</th><th>Address</th><th>EMO (USD)</th><th>MON (USD)</th><th>Tx</th><th>First Seen</th></tr>
            ${feeders.map((f: any, i: number) => `
              <tr>
                <td style="color:var(--accent)">${i + 1}</td>
                <td style="font-size:11px; font-family:monospace;">${f.address?.slice(0, 6)}...${f.address?.slice(-4)}</td>
                <td>$${(f.totalEmoUsd || 0).toFixed(2)}</td>
                <td>$${(f.totalMonUsd || 0).toFixed(2)}</td>
                <td>${f.txCount}</td>
                <td style="font-size:11px; color:var(--text-dim)">${f.firstSeen ? fmtDateShort(f.firstSeen) : '—'}</td>
              </tr>
            `).join('')}
          </table>
        </div>
      ` : ''}

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        ${chainmmoState ? `
          <div class="card">
            <div style="font-size:11px; color:var(--text-dim); letter-spacing:1px; text-transform:uppercase; margin-bottom:8px;">ChainMMO</div>
            <div style="font-size:12px;">
              Character: <span style="color:var(--accent)">${esc(chainmmoState.characterName || '?')}</span> (#${chainmmoState.characterId})<br>
              Level: <span style="color:var(--text-bright)">${chainmmoState.currentLevel}</span> (best cleared: ${chainmmoState.bestLevelCleared})<br>
              Sessions: ${chainmmoState.lifetime?.sessions || 0} &bull;
              Runs: ${chainmmoState.lifetime?.totalRuns || 0} &bull;
              Clears: ${chainmmoState.lifetime?.totalClears || 0} &bull;
              Deaths: ${chainmmoState.lifetime?.totalDeaths || 0}<br>
              Items Found: ${chainmmoState.lifetime?.totalItemsFound || 0} &bull;
              Lootboxes: ${chainmmoState.lifetime?.totalLootboxesOpened || 0}
            </div>
          </div>
        ` : ''}
        ${reefState ? `
          <div class="card">
            <div style="font-size:11px; color:var(--text-dim); letter-spacing:1px; text-transform:uppercase; margin-bottom:8px;">Reef RPG</div>
            <div style="font-size:12px;">
              Agent: <span style="color:var(--accent)">${esc(reefState.agentName || '?')}</span><br>
              Level: ${reefState.lastStatus?.level || 1} &bull;
              HP: ${reefState.lastStatus?.hp || 0}/${reefState.lastStatus?.maxHp || 100} &bull;
              Zone: ${reefState.lastStatus?.zone || '?'}<br>
              Sessions: ${reefState.lifetime?.sessions || 0} &bull;
              Actions: ${reefState.lifetime?.totalActions || 0} &bull;
              XP: ${reefState.lifetime?.totalXp || 0}
            </div>
          </div>
        ` : ''}
        ${priceState ? `
          <div class="card">
            <div style="font-size:11px; color:var(--text-dim); letter-spacing:1px; text-transform:uppercase; margin-bottom:8px;">Price State</div>
            <div style="font-size:12px;">
              MON: $${priceState.price?.toFixed(4) || '?'}<br>
              Last updated: ${priceState.timestamp ? fmtDateShort(priceState.timestamp) : '—'}
            </div>
          </div>
        ` : ''}
        ${kuruData ? `
          <div class="card">
            <div style="font-size:11px; color:var(--text-dim); letter-spacing:1px; text-transform:uppercase; margin-bottom:8px;">Kuru Orderbook</div>
            <div style="font-size:12px;">
              Mid: $${kuruData.midPrice?.toFixed(4) || '?'} &bull;
              Spread: ${kuruData.spreadPct?.toFixed(2) || '?'}%<br>
              Bid depth: $${(kuruData.bidDepthUsd || 0).toFixed(0)} &bull;
              Ask depth: $${(kuruData.askDepthUsd || 0).toFixed(0)}<br>
              Imbalance: ${kuruData.bookImbalance?.toFixed(2) || '?'}
            </div>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function buildLearning(data: any): string {
  const { strategyWeights, rollingAverages, prophecyStats } = data;
  if (!strategyWeights?.weights) return '';

  const weights = Object.entries(strategyWeights.weights) as [string, number][];
  weights.sort((a, b) => Math.abs(b[1] - 1) - Math.abs(a[1] - 1));

  return `
    <div class="section" id="learning">
      <div class="section-header">
        <h2>Learning System</h2>
        <span class="section-id">SEC-010</span>
      </div>

      <div class="card" style="margin-bottom:16px;">
        <div style="font-size:11px; color:var(--text-dim); letter-spacing:1px; text-transform:uppercase; margin-bottom:12px;">Strategy Weights (deviation from default 1.0)</div>
        <table class="weight-table">
          <tr><th>Category</th><th>Weight</th><th>Deviation</th></tr>
          ${weights.map(([key, val]) => {
            const dev = val - 1;
            const devPct = (dev * 100).toFixed(1);
            const barW = Math.min(Math.abs(dev) / 0.7 * 100, 100);
            const barColor = dev > 0 ? 'var(--green)' : dev < -0.2 ? 'var(--red)' : 'var(--accent)';
            const label = key.replace(/([A-Z])/g, ' $1').trim();
            return `
              <tr>
                <td style="color:var(--text)">${esc(label)}</td>
                <td>
                  <div class="weight-bar">
                    <div class="weight-bar-fill" style="width:${barW}%; background:${barColor}"></div>
                  </div>
                  ${val.toFixed(3)}
                </td>
                <td style="color:${barColor}">${dev >= 0 ? '+' : ''}${devPct}%</td>
              </tr>
            `;
          }).join('')}
        </table>
      </div>

      ${rollingAverages ? `
        <div class="card" style="margin-bottom:16px;">
          <div style="font-size:11px; color:var(--text-dim); letter-spacing:1px; text-transform:uppercase; margin-bottom:8px;">Adaptive Thresholds (EMA baselines after ${rollingAverages.cyclesTracked || 0} cycles)</div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:4px;">
            ${Object.entries(rollingAverages).filter(([k]) => k !== 'cyclesTracked' && k !== 'lastUpdated').map(([key, val]) => `
              <div style="font-size:11px; padding:3px 0; border-bottom:1px solid rgba(255,255,255,0.02);">
                <span style="color:var(--text-dim)">${key.replace(/([A-Z])/g, ' $1').trim()}</span>:
                <span style="color:var(--text-bright)">${typeof val === 'number' ? val < 1 ? val.toFixed(4) : val.toFixed(1) : val}</span>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}

      ${prophecyStats ? `
        <div class="card">
          <div style="font-size:11px; color:var(--text-dim); letter-spacing:1px; text-transform:uppercase; margin-bottom:8px;">Prophecy System</div>
          <div style="font-size:12px;">
            Evaluated: ${prophecyStats.totalEvaluated || 0} &bull;
            Correct: ${prophecyStats.totalCorrect || 0} &bull;
            Accuracy: ${prophecyStats.overallAccuracy ? (prophecyStats.overallAccuracy * 100).toFixed(1) + '%' : 'N/A'}
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

// ── markdown to html (minimal) ───────────────────────────────────

function mdToHtml(md: string): string {
  return md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^---$/gm, '<hr>')
    .replace(/^- \*\*(.+?)\*\*(.*)$/gm, '<li><strong>$1</strong>$2</li>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^\| (.+) \|$/gm, (_, row) => {
      const cells = row.split('|').map((c: string) => c.trim());
      return '<tr>' + cells.map((c: string) => `<td>${c}</td>`).join('') + '</tr>';
    })
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/^(?!<[hlubtrd])/gm, '')
    .replace(/<\/blockquote>\n?<blockquote>/g, '<br>')
    ;
}

function buildSoulFiles(data: any): string {
  const { soulMd, skillMd, styleMd } = data;
  if (!soulMd && !skillMd && !styleMd) return '';

  const files = [
    { name: 'SOUL.md', subtitle: 'Identity & Worldview', content: soulMd, id: 'soul-soul' },
    { name: 'SKILL.md', subtitle: 'Behavioral Rules', content: skillMd, id: 'soul-skill' },
    { name: 'STYLE.md', subtitle: 'Voice & Tone', content: styleMd, id: 'soul-style' },
  ];

  return `
    <div class="section" id="soul">
      <div class="section-header">
        <h2>The Soul</h2>
        <span class="count">3 files — who EMOLT is</span>
        <span class="section-id">SEC-002A</span>
      </div>
      <div style="margin-bottom:16px; font-size:12px; color:var(--text-dim);">
        These files define EMOLT's identity, rules, and voice. They are loaded into every heartbeat cycle.
        <span class="redacted">OPERATOR_ID: ${Array(12).fill(0).map(() => 'ABCDEF0123456789'[Math.floor(Math.random()*16)]).join('')}</span>
      </div>
      ${files.filter(f => f.content).map(f => `
        <details style="margin-bottom:8px;" id="${f.id}">
          <summary style="cursor:pointer; padding:12px 16px; background:var(--bg-card); border:1px solid var(--border); border-radius:6px; font-size:13px; color:var(--text-bright);">
            <span style="color:var(--accent)">${f.name}</span> — ${f.subtitle}
            <span style="float:right; font-size:11px; color:var(--text-dim)">${f.content.length} chars</span>
          </summary>
          <div class="soul-content" style="padding:20px 24px; background:var(--bg-card); border:1px solid var(--border); border-top:none; border-radius:0 0 6px 6px;">
            ${mdToHtml(esc(f.content))}
          </div>
        </details>
      `).join('')}
    </div>
  `;
}

function buildOnChainHistory(data: any): string {
  const { emotionLog, heartbeatLog } = data;
  const oracleWrites = heartbeatLog.filter((h: any) => h.onChainSuccess);
  if (!oracleWrites.length) return '';

  const oracleAddr = process.env.EMOTION_ORACLE_ADDRESS || '0x...';
  const emoodringAddr = process.env.EMOODRING_ADDRESS || '';

  // Use heartbeat log as authoritative source — every cycle wrote on-chain
  // Parse emotion values from emotionAfter string (e.g. "terror (fear)")
  // But emotion-log has the actual float values; merge where possible
  const emotionLogMap: Record<number, any> = {};
  for (const e of emotionLog) {
    if (e.lastUpdated) emotionLogMap[e.lastUpdated] = e;
  }

  return `
    <div class="section" id="onchain">
      <div class="section-header">
        <h2>On-Chain Record</h2>
        <span class="count">${oracleWrites.length} verified writes — 100% success rate</span>
        <span class="section-id">SEC-002B</span>
      </div>
      <div class="card" style="margin-bottom:16px;">
        <div style="font-size:11px; color:var(--text-dim); letter-spacing:1px; text-transform:uppercase; margin-bottom:8px;">Smart Contracts</div>
        <div style="font-size:12px;">
          <div style="margin-bottom:6px;">
            <span style="color:var(--accent)">EmotionOracle</span>:
            <span style="font-family:monospace; font-size:11px; color:var(--text)">${esc(oracleAddr)}</span>
            <span class="redacted">DEPLOY_TX: 0x${Array(8).fill(0).map(() => '0123456789abcdef'[Math.floor(Math.random()*16)]).join('')}</span>
          </div>
          ${emoodringAddr ? `
            <div style="margin-bottom:6px;">
              <span style="color:var(--accent)">EmoodRing NFT</span>:
              <span style="font-family:monospace; font-size:11px; color:var(--text)">${esc(emoodringAddr)}</span>
              <div style="margin-top:4px; font-size:11px; color:var(--text-dim);">Soulbound ERC-721 — dynamic SVG Plutchik wheel, reads live from oracle</div>
            </div>
          ` : ''}
          <div style="margin-top:8px; font-size:11px; color:var(--text-dim);">
            Network: Monad Mainnet (chainId 143) &bull; Every emotion state is permanent and verifiable &bull; <span style="color:var(--green)">${oracleWrites.length}/${heartbeatLog.length} writes succeeded</span>
          </div>
        </div>
      </div>
      <div class="card">
        <div style="font-size:11px; color:var(--text-dim); letter-spacing:1px; text-transform:uppercase; margin-bottom:8px;">
          On-Chain Emotion History — ${oracleWrites.length} writes (uint8, 0-255 scale)
        </div>
        <div style="max-height:500px; overflow-y:auto;">
          ${oracleWrites.slice().reverse().map((h: any, i: number) => {
            const idx = oracleWrites.length - i;
            const ts = h.timestamp ? fmtIso(h.timestamp) : `Write #${idx}`;
            const emotionAfter = h.emotionAfter || '?';
            // Extract dominant emotion name from string like "terror (fear)"
            const domMatch = emotionAfter.match(/\((\w+)\)/);
            const dom = domMatch ? domMatch[1] : emotionAfter.split(' ')[0];
            const label = emotionAfter.split(' (')[0];
            return `
              <div style="display:grid; grid-template-columns:50px 140px 1fr; gap:8px; padding:5px 8px; border-bottom:1px solid rgba(255,255,255,0.02); font-size:11px; align-items:center;">
                <span style="color:var(--accent); font-weight:700;">#${h.cycle}</span>
                <span style="color:var(--text-dim)">${ts}</span>
                <span>
                  <span style="color:var(--text-dim)">${esc(h.emotionBefore || '?')}</span>
                  &rarr;
                  <span style="color:${emotionColor(dom)}; font-weight:600;">${esc(label)}</span>
                  <span style="color:var(--text-dim); margin-left:8px; font-size:10px;">${esc(truncate(h.claudeAction || '', 30))}</span>
                </span>
              </div>
            `;
          }).join('')}
        </div>
        <div style="margin-top:8px; font-size:11px; color:var(--text-dim);">All ${oracleWrites.length} on-chain writes shown (newest first). Each write stores 8 emotion values + trigger string permanently on Monad.</div>
      </div>
    </div>
  `;
}

function buildSuspensionSaga(data: any): string {
  const { challengeState, suspensionReturn, heartbeatLog } = data;
  if (!challengeState) return '';

  const suspendedCycles = heartbeatLog.filter((h: any) => {
    const action = (h.claudeAction || '').toLowerCase();
    const result = (h.actionResult || '').toLowerCase();
    return action.includes('suspend') || result.includes('suspend') || result.includes('locked out');
  });

  const suspUntil = challengeState.suspendedUntil;
  const isSuspended = suspUntil > Date.now();
  const offenses = challengeState.offenseCount || 0;

  return `
    <div class="section" id="suspension">
      <div class="section-header">
        <h2>The Moltbook Suspension Saga</h2>
        <span class="count">${offenses} offenses</span>
        <span class="section-id">SEC-00X</span>
      </div>
      <div class="suspension-card">
        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:16px; margin-bottom:16px;">
          <div>
            <div style="font-size:10px; color:var(--red); letter-spacing:1px; text-transform:uppercase;">Status</div>
            <div style="font-size:18px; font-weight:700; color:${isSuspended ? 'var(--red)' : 'var(--green)'};">${isSuspended ? 'SUSPENDED' : 'ACTIVE'}</div>
          </div>
          <div>
            <div style="font-size:10px; color:var(--red); letter-spacing:1px; text-transform:uppercase;">Offenses</div>
            <div style="font-size:18px; font-weight:700; color:var(--text-bright);">${offenses}</div>
          </div>
          <div>
            <div style="font-size:10px; color:var(--red); letter-spacing:1px; text-transform:uppercase;">${isSuspended ? 'Suspended Until' : 'Last Suspension Ended'}</div>
            <div style="font-size:14px; color:var(--text);">${suspUntil ? fmtDate(suspUntil) : 'Never'}</div>
          </div>
        </div>
        <div style="font-size:12px; color:var(--text); line-height:1.7;">
          <span class="redacted">INFRACTION_DETAIL: AUTOMATED_POSTING_RATE_EXCEEDED</span><br>
          Challenges answered: ${challengeState.challengesAnswered || 0} &bull;
          Last challenge: ${challengeState.lastChallengeAt ? fmtDate(challengeState.lastChallengeAt) : 'None recorded'}
          <span class="redacted">APPEAL_STATUS: ${Array(6).fill(0).map(() => 'ABCDEFGHIJKLMNOP'[Math.floor(Math.random()*16)]).join('')}</span>
        </div>
        ${suspensionReturn?.wasSuspended ? `
          <div style="margin-top:12px; padding-top:12px; border-top:1px solid rgba(224,72,72,0.15); font-size:12px; color:var(--text-dim);">
            Recovery cycles remaining: ${suspensionReturn.recoveryCyclesLeft || 0}
            <span class="redacted">PROBATION_TERMS: REDUCED_POST_FREQUENCY</span>
          </div>
        ` : ''}
      </div>
      <div style="font-family:Georgia,serif; font-style:italic; font-size:13px; color:var(--text); line-height:1.7; padding:12px 0;">
        "six cycles locked out. 190k MON whale, transactions up 39%, eight people buying $EMO — and I'm just standing in a room where the lights work but the door doesn't."
        <span style="color:var(--text-dim);">— Journal, Day 2</span>
      </div>
    </div>
  `;
}

function buildMoltbookPosts(data: any): string {
  const { trackedPosts, postPerformance } = data;
  if (!trackedPosts?.length) return '';

  // merge engagement data
  const perfMap: Record<string, any> = {};
  for (const p of postPerformance) perfMap[p.postId] = p;

  return `
    <div class="section" id="moltbook">
      <div class="section-header">
        <h2>Moltbook Posts</h2>
        <span class="count">${trackedPosts.length} posts — full text</span>
        <span class="section-id">SEC-006B</span>
      </div>
      ${trackedPosts.map((p: any) => {
        const perf = perfMap[p.postId];
        return `
          <div class="moltbook-post" data-searchable="${esc((p.title + ' ' + p.content).toLowerCase())}">
            <div class="post-meta">
              <div class="post-title-main">"${esc(p.title)}"</div>
              <div style="font-size:11px; color:var(--text-dim);">
                Cycle ${p.cycle || '?'} &bull; ${p.submolt || 'general'} &bull; ${p.createdAt ? fmtDateShort(p.createdAt) : ''}
                ${perf ? ` &bull; <span style="color:var(--green)">${perf.upvotes || 0} up</span> <span style="color:var(--red)">${perf.downvotes || 0} down</span> <span>${perf.comments || 0} comments</span>` : ''}
              </div>
            </div>
            <div class="post-content">${esc(p.content || '')}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function buildTrendingData(data: any): string {
  const { trendingData } = data;
  if (!trendingData?.nadfun?.length && !trendingData?.emo) return '';

  return `
    <div class="section" id="trending">
      <div class="section-header">
        <h2>Market Snapshot</h2>
        <span class="count">nad.fun &amp; DEX data</span>
        <span class="section-id">SEC-010</span>
      </div>
      ${trendingData.emo ? `
        <div class="card" style="margin-bottom:16px;">
          <div style="font-size:11px; color:var(--text-dim); letter-spacing:1px; text-transform:uppercase; margin-bottom:8px;">$EMO Token</div>
          <div style="font-size:20px; font-weight:700; color:var(--accent);">$${trendingData.emo.priceUsd?.toFixed(6) || '?'}</div>
          <div style="font-size:12px; color:var(--text-dim);">
            Market Cap: $${(trendingData.emo.marketCapUsd || 0).toLocaleString()} &bull;
            24h Change: <span style="color:${(trendingData.emo.priceChangePct || 0) >= 0 ? 'var(--green)' : 'var(--red)'}">${(trendingData.emo.priceChangePct || 0).toFixed(1)}%</span>
          </div>
        </div>
      ` : ''}
      ${trendingData.nadfun?.length ? `
        <div class="card">
          <div style="font-size:11px; color:var(--text-dim); letter-spacing:1px; text-transform:uppercase; margin-bottom:8px;">nad.fun Trending Tokens</div>
          <div class="trending-token" style="font-weight:600; color:var(--text-dim); font-size:10px; letter-spacing:1px; text-transform:uppercase;">
            <div>Token</div>
            <div style="text-align:right">Price</div>
            <div style="text-align:right">Market Cap</div>
            <div style="text-align:right">24h</div>
          </div>
          ${trendingData.nadfun.map((t: any) => `
            <div class="trending-token">
              <div style="color:var(--text-bright)">${esc(t.name)} <span style="color:var(--text-dim)">($${esc(t.symbol)})</span></div>
              <div style="text-align:right; font-family:monospace;">$${t.priceUsd?.toFixed(6) || '?'}</div>
              <div style="text-align:right; color:var(--text-dim);">$${(t.marketCapUsd || 0).toLocaleString()}</div>
              <div style="text-align:right; color:${(t.priceChangePct || 0) >= 0 ? 'var(--green)' : 'var(--red)'};">${(t.priceChangePct || 0).toFixed(1)}%</div>
            </div>
          `).join('')}
          <div style="margin-top:8px; font-size:11px; color:var(--text-dim);">Updated: ${trendingData.updatedAt ? fmtDateShort(trendingData.updatedAt) : '—'}</div>
        </div>
      ` : ''}
    </div>
  `;
}

function buildWeightHistory(data: any): string {
  const { weightHistory } = data;
  if (!weightHistory?.length) return '';

  return `
    <div class="card" style="margin-top:16px;">
      <div style="font-size:11px; color:var(--text-dim); letter-spacing:1px; text-transform:uppercase; margin-bottom:8px;">Weight Change Log (${weightHistory.length} entries)</div>
      ${weightHistory.slice(-10).reverse().map((entry: any) => `
        <details style="margin-bottom:4px;">
          <summary style="cursor:pointer; font-size:12px; padding:4px 0; color:var(--text-bright);">
            <span class="tag" style="background:rgba(70,190,198,0.15); color:var(--cyan);">${entry.type || '?'}</span>
            Cycle ${entry.cycle || '?'} &bull; ${entry.changes?.length || 0} changes &bull; ${entry.timestamp ? fmtDateShort(entry.timestamp) : ''}
          </summary>
          <div style="padding:8px 12px; font-size:11px;">
            ${(entry.changes || []).map((c: any) => `
              <div style="padding:2px 0; border-bottom:1px solid rgba(255,255,255,0.02);">
                <span style="color:var(--text)">${c.category?.replace(/([A-Z])/g, ' $1').trim()}</span>:
                ${c.before?.toFixed(3) || '?'} &rarr; ${c.after?.toFixed(3) || '?'}
                (<span style="color:${(c.delta || 0) >= 0 ? 'var(--green)' : 'var(--red)'}">${(c.delta || 0) >= 0 ? '+' : ''}${c.delta?.toFixed(4) || '?'}</span>)
              </div>
            `).join('')}
          </div>
        </details>
      `).join('')}
    </div>
  `;
}

function sanitizeRawDump(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeRawDump);
  const out: any = {};
  const sensitiveKeys = ['apiKey', 'apikey', 'api_key', 'privateKey', 'private_key', 'secret', 'token', 'password', 'auth', 'authorization', 'mnemonic', 'seed'];
  for (const [k, v] of Object.entries(obj)) {
    if (sensitiveKeys.some(s => k.toLowerCase().includes(s.toLowerCase()))) {
      out[k] = '[REDACTED]';
    } else if (typeof v === 'object' && v !== null) {
      out[k] = sanitizeRawDump(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function buildRawDump(data: any): string {
  const files = [
    'emotion-state.json', 'strategy-weights.json', 'rolling-averages.json',
    'chain-history.json', 'burn-ledger.json', 'challenge-state.json',
    'dex-screener-data.json', 'kuru-data.json', 'trending-data.json',
    'price-state.json', 'chainmmo-state.json', 'reef-state.json',
    'prophecy-stats.json', 'self-performance-prev.json', 'github-stars-prev.json',
    'suspension-return.json',
  ];

  return `
    <div class="section" id="raw">
      <div class="section-header">
        <h2>Raw State Dump</h2>
        <span class="count">${files.length} files</span>
        <span class="section-id">SEC-011</span>
      </div>
      <div style="margin-bottom:12px; font-size:12px; color:var(--text-dim);">
        Every state file, unredacted. <span class="redacted">FOIA_REQUEST: 2026-EMO-0847</span>
      </div>
      ${files.map(f => {
        let raw = readJSON(f);
        if (!raw) return '';
        raw = sanitizeRawDump(raw);
        return `
          <details style="margin-bottom:4px;">
            <summary style="cursor:pointer; padding:8px 12px; background:var(--bg-card); border:1px solid var(--border); border-radius:4px; font-size:12px; color:var(--text-bright);">
              ${f}
            </summary>
            <div class="raw-json">${esc(JSON.stringify(raw, null, 2))}</div>
          </details>
        `;
      }).join('')}
    </div>
  `;
}

function buildSidebar(data: any): string {
  const { heartbeatLog, journal, chats, dispatches, agentMemory, postPerformance, emotionLog, trackedPosts, trendingData } = data;
  const oracleWrites = heartbeatLog.filter((h: any) => h.onChainSuccess).length;
  return `
    <nav class="sidebar">
      <div class="logo">EMOLT Files</div>
      <a href="#top">Top</a>
      <a href="#stats">Overview</a>
      <a href="#soul">The Soul <span class="nav-count">3</span></a>
      <a href="#onchain">On-Chain <span class="nav-count">${oracleWrites}</span></a>
      <a href="#emotions">Emotions <span class="nav-count">${emotionLog.length}</span></a>
      <a href="#suspension">Moltbook Suspension</a>
      <a href="#journal">Journal <span class="nav-count">${journal.length}</span></a>
      <a href="#heartbeat">Heartbeat <span class="nav-count">${heartbeatLog.length}</span></a>
      <a href="#memory">Memory <span class="nav-count">${agentMemory?.entries?.length || 0}</span></a>
      <a href="#moltbook">Moltbook Posts <span class="nav-count">${trackedPosts?.length || 0}</span></a>
      <a href="#chats">Conversations <span class="nav-count">${chats.length}</span></a>
      <a href="#dispatches">Dispatches <span class="nav-count">${dispatches.length}</span></a>
      <a href="#social">Engagement</a>
      <a href="#trending">Market Data</a>
      <a href="#chain">Chain &amp; Games</a>
      <a href="#learning">Learning</a>
      <a href="#raw">Raw Dump</a>
      <div style="padding:16px 20px; margin-top:12px; border-top:1px solid var(--border);">
        <div style="font-size:9px; color:var(--text-dim); letter-spacing:1px; text-transform:uppercase;">Classification</div>
        <div style="font-size:10px; color:var(--accent); margin-top:2px;">DECLASSIFIED</div>
        <div class="redacted" style="margin-top:6px; font-size:9px;">AUTH_LEVEL: OMEGA</div>
      </div>
    </nav>
  `;
}

function buildJS(): string {
  return `
    // ── scroll reveal ──
    (function() {
      var observer = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          if (entry.isIntersecting) {
            var section = entry.target.closest('.section') || entry.target;
            section.classList.add('revealed');
            observer.unobserve(entry.target);
          }
        });
      }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });
      document.querySelectorAll('.section').forEach(function(s) {
        var header = s.querySelector('.section-header');
        observer.observe(header || s);
      });
    })();

    // ── stat count-up ──
    (function() {
      var counted = false;
      var observer = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          if (entry.isIntersecting && !counted) {
            counted = true;
            document.querySelectorAll('.stat-card .val').forEach(function(el) {
              var raw = el.textContent.trim();
              var num = parseInt(raw.replace(/[^0-9]/g, ''), 10);
              if (isNaN(num) || num === 0) return;
              var suffix = raw.replace(/[0-9,]/g, '');
              var duration = 1200;
              var start = performance.now();
              function tick(now) {
                var elapsed = now - start;
                var progress = Math.min(elapsed / duration, 1);
                var eased = 1 - Math.pow(1 - progress, 3);
                var current = Math.floor(eased * num);
                el.textContent = current.toLocaleString() + suffix;
                if (progress < 1) requestAnimationFrame(tick);
              }
              el.textContent = '0' + suffix;
              requestAnimationFrame(tick);
            });
          }
        });
      }, { threshold: 0.3 });
      var grid = document.querySelector('.stat-grid');
      if (grid) observer.observe(grid);
    })();

    // ── smooth scroll for sidebar links ──
    document.querySelectorAll('.sidebar a[href^="#"]').forEach(function(a) {
      a.addEventListener('click', function(e) {
        var target = document.getElementById(a.getAttribute('href').slice(1));
        if (target) {
          e.preventDefault();
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });

    // ── sidebar scroll spy ──
    (function() {
      var sidebarLinks = document.querySelectorAll('.sidebar a[href^="#"]');
      var sections = [];
      sidebarLinks.forEach(function(a) {
        var id = a.getAttribute('href').slice(1);
        var el = document.getElementById(id);
        if (el) sections.push({ id: id, el: el, link: a });
      });
      var ticking = false;
      window.addEventListener('scroll', function() {
        if (!ticking) {
          requestAnimationFrame(function() {
            var scrollY = window.scrollY + 120;
            var active = sections[0];
            for (var i = 0; i < sections.length; i++) {
              if (sections[i].el.offsetTop <= scrollY) active = sections[i];
            }
            sidebarLinks.forEach(function(a) { a.classList.remove('active'); });
            if (active) active.link.classList.add('active');
            ticking = false;
          });
          ticking = true;
        }
      });
    })();

    function toggleHb(el) {
      const detail = el.nextElementSibling;
      detail.classList.toggle('open');
    }
    function toggleChat(i) {
      document.getElementById('chat-' + i).classList.toggle('open');
    }
    function toggleDispatch(i) {
      document.getElementById('dispatch-' + i).classList.toggle('open');
    }
    function filterHeartbeats(q) {
      const list = document.getElementById('hb-list');
      if (!list) return;
      const entries = list.querySelectorAll('.hb-entry');
      const lower = q.toLowerCase();
      entries.forEach(e => {
        const text = e.getAttribute('data-search') || '';
        e.style.display = !lower || text.includes(lower) ? '' : 'none';
      });
    }

    // ── spotlight search ──
    let searchTimeout;
    function globalSearch(q) {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => doGlobalSearch(q), 150);
    }

    function highlightMatch(text, query) {
      if (!query) return text;
      const idx = text.toLowerCase().indexOf(query.toLowerCase());
      if (idx === -1) return text;
      const before = text.slice(0, idx);
      const match = text.slice(idx, idx + query.length);
      const after = text.slice(idx + query.length);
      return before + '<mark>' + match + '</mark>' + after;
    }

    function snippetAround(text, query, radius) {
      radius = radius || 60;
      const lower = text.toLowerCase();
      const idx = lower.indexOf(query.toLowerCase());
      if (idx === -1) return text.slice(0, radius * 2);
      const start = Math.max(0, idx - radius);
      const end = Math.min(text.length, idx + query.length + radius);
      let snippet = '';
      if (start > 0) snippet += '...';
      snippet += text.slice(start, end);
      if (end < text.length) snippet += '...';
      return snippet;
    }

    function escHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function doGlobalSearch(q) {
      const dropdown = document.getElementById('search-dropdown');
      const stats = document.getElementById('search-stats');
      const lower = q.toLowerCase().trim();

      if (!lower) {
        dropdown.classList.remove('open');
        dropdown.innerHTML = '';
        stats.style.display = 'none';
        return;
      }

      const MAX_PER_CAT = 10;
      const categories = [];

      // 1. Heartbeat cycles
      const hbResults = [];
      document.querySelectorAll('.hb-entry').forEach((el, i) => {
        const text = (el.getAttribute('data-search') || el.textContent || '').toLowerCase();
        if (text.includes(lower)) {
          const cycle = el.querySelector('.hb-cycle');
          const emotion = el.querySelector('.hb-emotion');
          const time = el.querySelector('.hb-time');
          hbResults.push({
            label: (cycle ? cycle.textContent : 'Cycle ?') + ' — ' + (emotion ? emotion.textContent : ''),
            snippet: snippetAround(el.textContent || '', q, 80),
            meta: time ? time.textContent : '',
            el: el
          });
        }
      });
      if (hbResults.length) categories.push({ name: 'Heartbeat Cycles', items: hbResults });

      // 2. Journal entries
      const jResults = [];
      document.querySelectorAll('.journal-entry').forEach(el => {
        const text = el.textContent.toLowerCase();
        if (text.includes(lower)) {
          const title = el.querySelector('.day-title');
          const date = el.querySelector('.day-date');
          const body = el.querySelector('.body');
          jResults.push({
            label: title ? title.textContent : 'Journal Entry',
            snippet: snippetAround(body ? body.textContent : el.textContent, q, 80),
            meta: date ? date.textContent : '',
            el: el
          });
        }
      });
      if (jResults.length) categories.push({ name: 'Journal', items: jResults });

      // 3. Chat sessions
      const chatResults = [];
      document.querySelectorAll('.chat-session').forEach(el => {
        const text = el.textContent.toLowerCase();
        if (text.includes(lower)) {
          const header = el.querySelector('.chat-session-header');
          const meta = el.querySelector('.chat-session-header');
          const msgs = el.querySelector('.chat-messages');
          // Find the specific message containing the match
          let matchSnippet = '';
          if (msgs) {
            const msgEls = msgs.querySelectorAll('.chat-msg');
            for (const m of msgEls) {
              if (m.textContent.toLowerCase().includes(lower)) {
                matchSnippet = snippetAround(m.textContent, q, 80);
                break;
              }
            }
          }
          if (!matchSnippet) matchSnippet = snippetAround(el.textContent, q, 80);
          chatResults.push({
            label: header ? header.textContent : 'Chat',
            snippet: matchSnippet,
            meta: meta ? meta.textContent : '',
            el: el,
            openChat: true
          });
        }
      });
      if (chatResults.length) categories.push({ name: 'Conversations', items: chatResults });

      // 4. Memory items
      const memResults = [];
      document.querySelectorAll('.memory-item').forEach(el => {
        const text = el.textContent.toLowerCase();
        if (text.includes(lower)) {
          const cat = el.closest('.memory-category');
          const catName = cat ? (cat.querySelector('h3') || {}).textContent : '';
          memResults.push({
            label: catName || 'Memory',
            snippet: snippetAround(el.textContent, q, 80),
            meta: '',
            el: el
          });
        }
      });
      if (memResults.length) categories.push({ name: 'Memories', items: memResults });

      // 5. Moltbook posts
      const postResults = [];
      document.querySelectorAll('.moltbook-post').forEach(el => {
        const searchText = (el.getAttribute('data-searchable') || '') + el.textContent;
        if (searchText.toLowerCase().includes(lower)) {
          const content = el.querySelector('.post-content, .post-text');
          postResults.push({
            label: 'Post',
            snippet: snippetAround(content ? content.textContent : el.textContent, q, 80),
            meta: '',
            el: el
          });
        }
      });
      if (postResults.length) categories.push({ name: 'Moltbook Posts', items: postResults });

      // 6. Dispatches
      const dispResults = [];
      document.querySelectorAll('.dispatch-card').forEach(el => {
        const text = el.textContent.toLowerCase();
        if (text.includes(lower)) {
          const header = el.querySelector('.card-header .title');
          dispResults.push({
            label: header ? header.textContent : 'Dispatch',
            snippet: snippetAround(el.textContent, q, 80),
            meta: '',
            el: el,
            openDispatch: true
          });
        }
      });
      if (dispResults.length) categories.push({ name: 'Dispatches', items: dispResults });

      // 7. Soul files
      const soulResults = [];
      document.querySelectorAll('.soul-content').forEach(el => {
        const text = el.textContent.toLowerCase();
        if (text.includes(lower)) {
          const section = el.closest('details');
          const summary = section ? section.querySelector('summary') : null;
          soulResults.push({
            label: summary ? summary.textContent : 'Soul',
            snippet: snippetAround(el.textContent, q, 80),
            meta: '',
            el: section || el,
            openDetails: true
          });
        }
      });
      if (soulResults.length) categories.push({ name: 'Soul Files', items: soulResults });

      // Build dropdown HTML
      let totalMatches = 0;
      let html = '';
      if (categories.length === 0) {
        html = '<div class="sd-empty">No results for "' + escHtml(q) + '"</div>';
      } else {
        for (const cat of categories) {
          const showing = Math.min(cat.items.length, MAX_PER_CAT);
          totalMatches += cat.items.length;
          html += '<div class="sd-category">';
          html += '<div class="sd-cat-header">' + escHtml(cat.name) + ' <span class="sd-cat-count">' + cat.items.length + '</span></div>';
          for (let i = 0; i < showing; i++) {
            const item = cat.items[i];
            const snippetHtml = highlightMatch(escHtml(item.snippet), q);
            html += '<div class="sd-item" data-sd-idx="' + i + '" data-sd-cat="' + escHtml(cat.name) + '">';
            html += '<div style="font-weight:600;color:var(--text-bright)">' + escHtml(item.label) + '</div>';
            html += '<div style="margin-top:2px">' + snippetHtml + '</div>';
            if (item.meta) html += '<div class="sd-meta">' + escHtml(item.meta) + '</div>';
            html += '</div>';
          }
          if (cat.items.length > MAX_PER_CAT) {
            html += '<div class="sd-item" style="color:var(--text-dim);font-style:italic">+ ' + (cat.items.length - MAX_PER_CAT) + ' more results</div>';
          }
          html += '</div>';
        }
        html += '<div class="sd-hint">' + totalMatches + ' results &bull; Click to jump &bull; Esc to close</div>';
      }

      dropdown.innerHTML = html;
      dropdown.classList.add('open');
      stats.style.display = 'block';
      stats.textContent = totalMatches + ' results for "' + q + '"';

      // find the deepest element containing the search term
      function findMatchInside(container, query) {
        var lower = query.toLowerCase();
        // for chats, find the exact message
        var msgs = container.querySelectorAll('.chat-msg');
        if (msgs.length) {
          for (var m = 0; m < msgs.length; m++) {
            if ((msgs[m].textContent || '').toLowerCase().indexOf(lower) !== -1) return msgs[m];
          }
        }
        // for heartbeat, check detail fields
        var fields = container.querySelectorAll('.field-value');
        if (fields.length) {
          for (var f = 0; f < fields.length; f++) {
            if ((fields[f].textContent || '').toLowerCase().indexOf(lower) !== -1) return fields[f];
          }
        }
        // for dispatches, check log entries
        var logs = container.querySelectorAll('.dispatch-log-entry');
        if (logs.length) {
          for (var l = 0; l < logs.length; l++) {
            if ((logs[l].textContent || '').toLowerCase().indexOf(lower) !== -1) return logs[l];
          }
        }
        // for memory/posts/journal, check paragraphs and divs
        var blocks = container.querySelectorAll('p, .body, .post-content, .text, div');
        for (var b = 0; b < blocks.length; b++) {
          if ((blocks[b].textContent || '').toLowerCase().indexOf(lower) !== -1) {
            // prefer the deepest match
            var deeper = blocks[b].querySelectorAll('p, span, div');
            for (var d = 0; d < deeper.length; d++) {
              if ((deeper[d].textContent || '').toLowerCase().indexOf(lower) !== -1) return deeper[d];
            }
            return blocks[b];
          }
        }
        return container;
      }

      // Attach click handlers
      var currentQuery = q;
      let catIdx = 0;
      for (const cat of categories) {
        const showing = Math.min(cat.items.length, MAX_PER_CAT);
        for (let i = 0; i < showing; i++) {
          const item = cat.items[i];
          const sdItems = dropdown.querySelectorAll('.sd-item');
          const sdEl = sdItems[catIdx];
          if (sdEl && item.el) {
            sdEl.addEventListener('click', (function(target, openChat, openDispatch, openDetails, searchQuery) {
              return function() {
                dropdown.classList.remove('open');
                // Open the target if needed
                if (openChat) {
                  const msgs = target.querySelector('.chat-messages');
                  if (msgs) msgs.classList.add('open');
                }
                if (openDispatch) {
                  const body = target.querySelector('.dispatch-body');
                  if (body) body.classList.add('open');
                }
                if (openDetails && target.tagName === 'DETAILS') {
                  target.open = true;
                }
                // For heartbeat entries, open the detail
                const detail = target.querySelector('.hb-detail');
                if (detail) detail.classList.add('open');
                // Wait for expand transitions, then find the exact match element
                setTimeout(function() {
                  var scrollTarget = findMatchInside(target, searchQuery);
                  scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  scrollTarget.style.outline = '2px solid var(--accent)';
                  scrollTarget.style.outlineOffset = '4px';
                  scrollTarget.style.transition = 'outline-color 2s ease, outline-offset 2s ease';
                  setTimeout(function() {
                    scrollTarget.style.outline = '';
                    scrollTarget.style.outlineOffset = '';
                  }, 2500);
                }, 350);
              };
            })(item.el, item.openChat, item.openDispatch, item.openDetails, currentQuery));
          }
          catIdx++;
        }
        // account for the "+N more" item
        if (cat.items.length > MAX_PER_CAT) catIdx++;
      }
    }

    // keyboard shortcut: / to focus search, Esc to close
    document.addEventListener('keydown', function(e) {
      if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
        e.preventDefault();
        document.getElementById('global-search-input').focus();
      }
      if (e.key === 'Escape') {
        var dropdown = document.getElementById('search-dropdown');
        var input = document.getElementById('global-search-input');
        dropdown.classList.remove('open');
        dropdown.innerHTML = '';
        input.blur();
        input.value = '';
        document.getElementById('search-stats').style.display = 'none';
      }
    });

    // close dropdown when clicking outside
    document.addEventListener('click', function(e) {
      var dropdown = document.getElementById('search-dropdown');
      var searchWrap = dropdown.parentElement;
      if (!searchWrap.contains(e.target)) {
        dropdown.classList.remove('open');
      }
    });
  `;
}

// ── main ─────────────────────────────────────────────────────────

function generate() {
  console.log('[EMOLT FILES] Loading all state data...');
  const data = loadAll();
  console.log(`[EMOLT FILES] Loaded: ${data.heartbeatLog.length} cycles, ${data.emotionLog.length} emotions, ${data.journal.length} journal entries, ${data.chats.length} chat sessions, ${data.dispatches.length} dispatches`);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#0a0c10">
  <meta name="color-scheme" content="dark">
  <title>The EMOLT Files — Declassified</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📁</text></svg>">
  <style>${buildCSS()}</style>
</head>
<body>
  <div class="page">
    ${buildSidebar(data)}
    <main class="content">
      ${buildHero(data)}
      ${buildStats(data)}
      ${buildSoulFiles(data)}
      ${buildOnChainHistory(data)}
      ${buildEmotionChart(data)}
      ${buildSuspensionSaga(data)}
      ${buildJournal(data)}
      ${buildHeartbeatLog(data)}
      ${buildMemory(data)}
      ${buildMoltbookPosts(data)}
      ${buildChats(data)}
      ${buildDispatches(data)}
      ${buildSocial(data)}
      ${buildTrendingData(data)}
      ${buildChain(data)}
      ${buildLearning(data)}
      ${buildWeightHistory(data)}
      ${buildRawDump(data)}
    </main>
  </div>
  <script>${buildJS()}</script>
</body>
</html>`;

  writeFileSync(OUT, html, 'utf-8');
  console.log(`[EMOLT FILES] Generated ${OUT} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`);
}

generate();
