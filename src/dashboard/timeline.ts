/**
 * EMOLT Timeline — Emotional History Replay
 * Generates a self-contained timeline.html with animated EmoodRing SVG playback.
 * Run: npx tsx src/dashboard/timeline.ts
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const STATE = './state';
const OUT = './timeline.html';

// --- File helpers (same pattern as generate.ts) ---

function readJSON(file: string): any {
  try {
    return JSON.parse(readFileSync(join(STATE, file), 'utf-8'));
  } catch { return null; }
}

function readJSONL(file: string): any[] {
  try {
    return readFileSync(join(STATE, file), 'utf-8')
      .trimEnd().split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l));
  } catch { return []; }
}

// --- Plutchik constants ---
const EMOTIONS = [
  { name: 'joy',          color: '#F5D831', angle: 270, tiers: ['serenity','joy','ecstasy'] },
  { name: 'trust',        color: '#6ECB3C', angle: 315, tiers: ['acceptance','trust','admiration'] },
  { name: 'fear',         color: '#2BA84A', angle: 0,   tiers: ['apprehension','fear','terror'] },
  { name: 'surprise',     color: '#22AACC', angle: 45,  tiers: ['distraction','surprise','amazement'] },
  { name: 'sadness',      color: '#4A6BD4', angle: 90,  tiers: ['pensiveness','sadness','grief'] },
  { name: 'disgust',      color: '#A85EC0', angle: 135, tiers: ['boredom','disgust','loathing'] },
  { name: 'anger',        color: '#E04848', angle: 180, tiers: ['annoyance','anger','rage'] },
  { name: 'anticipation', color: '#EF8E20', angle: 225, tiers: ['interest','anticipation','vigilance'] },
];

const EMOTION_COLOR: Record<string, string> = {};
for (const e of EMOTIONS) EMOTION_COLOR[e.name] = e.color;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// --- Data merge ---

interface MergedCycle {
  index: number;
  cycle: number | null;
  timestamp: number;
  emotions: Record<string, number>;
  mood: Record<string, number>;
  compounds: string[];
  dominant: string;
  dominantLabel: string;
  trigger: string;
  moodNarrative: string | null;
  stimuliCount: number | null;
  stimuliSummary: string[] | null;
  claudeAction: string | null;
  claudeThinking: string | null;
  actionResult: string | null;
  reflectionSummary: string | null;
  onChainSuccess: boolean | null;
  durationMs: number | null;
}

function loadAndMergeData(): MergedCycle[] {
  const emotionLog: any[] = readJSON('emotion-log.json') || [];
  const heartbeatLog: any[] = readJSONL('heartbeat-log.jsonl');

  if (emotionLog.length < 2) return [];

  const merged: MergedCycle[] = [];

  for (let i = 0; i < emotionLog.length; i++) {
    const emo = emotionLog[i];
    const ts = emo.lastUpdated;

    // Find closest heartbeat entry by timestamp (within 120s)
    let bestHb: any = null;
    let bestDelta = Infinity;
    for (const hb of heartbeatLog) {
      const hbTs = new Date(hb.timestamp).getTime();
      const delta = Math.abs(hbTs - ts);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestHb = hb;
      }
    }
    // Only match if within 120 seconds
    if (bestDelta > 120_000) bestHb = null;

    merged.push({
      index: i,
      cycle: bestHb?.cycle ?? null,
      timestamp: ts,
      emotions: emo.emotions,
      mood: emo.mood || {},
      compounds: emo.compounds || [],
      dominant: emo.dominant,
      dominantLabel: emo.dominantLabel,
      trigger: emo.trigger || '',
      moodNarrative: emo.moodNarrative || null,
      stimuliCount: bestHb?.stimuliCount ?? null,
      stimuliSummary: bestHb?.stimuliSummary ?? null,
      claudeAction: bestHb?.claudeAction ?? null,
      claudeThinking: bestHb?.claudeThinking ?? null,
      actionResult: bestHb?.actionResult ?? null,
      reflectionSummary: bestHb?.reflectionSummary ?? null,
      onChainSuccess: bestHb?.onChainSuccess ?? null,
      durationMs: bestHb?.durationMs ?? null,
    });
  }

  return merged;
}

// --- HTML generator ---

export function generateTimeline(): void {
  const data = loadAndMergeData();

  if (data.length < 2) {
    writeFileSync(OUT, `<!DOCTYPE html><html><body style="background:#08080c;color:#666;font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><p>Not enough emotion data to generate timeline (need at least 2 entries).</p></body></html>`);
    console.log('Not enough data — wrote minimal timeline.html');
    return;
  }

  const dataJSON = JSON.stringify(data);
  const emotionsJSON = JSON.stringify(EMOTIONS);
  const totalCycles = data.length;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>EMOLT Timeline</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@300;400;500&display=swap" rel="stylesheet">
<style>
:root {
  --bg:#060a12; --bg-card:rgba(14,18,30,0.72); --bg-card-solid:#0e121e; --bg-inner:rgba(18,22,36,0.6); --bg-track:#10141e;
  --border:rgba(255,255,255,0.06); --border-light:rgba(255,255,255,0.10);
  --text:#e2e4ea; --text-mid:#9ba3b4; --text-dim:#6b7385; --text-faint:#4a5264; --text-muted:#5a6274;
  --heading:#8b93a4; --heading-sub:#6b7385;
  --accent:#EF8E20; --accent-glow:rgba(239,142,32,0.35);
  --scrollbar-track:rgba(10,14,22,0.5); --scrollbar-thumb:#1e2436; --scrollbar-hover:#2e3448;
  --card-shadow:0 4px 24px rgba(0,0,0,0.3), 0 1px 4px rgba(0,0,0,0.2);
  --card-hover-shadow:0 12px 40px rgba(0,0,0,0.45), 0 4px 12px rgba(0,0,0,0.3);
  --radius-md:12px; --radius-lg:16px;
}
html.light {
  --bg:#f0f2f6; --bg-card:rgba(255,255,255,0.85); --bg-card-solid:#ffffff; --bg-inner:rgba(245,246,250,0.7); --bg-track:#e8eaf0;
  --border:rgba(0,0,0,0.08); --border-light:rgba(0,0,0,0.12);
  --text:#1a1e28; --text-mid:#3a3e4a; --text-dim:#555868; --text-faint:#6a6e7a; --text-muted:#5a5e6a;
  --heading:#4a4e58; --heading-sub:#5a5e68;
  --card-shadow:0 2px 12px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04);
  --card-hover-shadow:0 8px 28px rgba(0,0,0,0.1), 0 2px 8px rgba(0,0,0,0.06);
  --scrollbar-track:#e4e6ec; --scrollbar-thumb:#c4c6d0; --scrollbar-hover:#a4a6b0;
}
* { margin:0; padding:0; box-sizing:border-box; }
html { scroll-behavior:smooth; overflow-x:hidden; }
body {
  background:var(--bg); color:var(--text);
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  min-height:100vh; overflow-x:hidden; padding-bottom:120px;
  display:flex; flex-direction:column; justify-content:center;
  -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale;
  text-rendering:optimizeLegibility;
  font-variant-numeric:tabular-nums;
}

/* Ambient background blobs */
.bg-ambience { position:fixed; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:0; overflow:hidden; }
.bg-blob { position:absolute; border-radius:50%; filter:blur(100px); opacity:0.12; }
.bg-blob-1 { width:500px; height:500px; background:#EF8E20; top:-8%; left:-8%; animation:blobDrift1 20s ease-in-out infinite; }
.bg-blob-2 { width:400px; height:400px; background:#4A6BD4; bottom:10%; right:-6%; animation:blobDrift2 24s ease-in-out infinite; }
.bg-blob-3 { width:350px; height:350px; background:#6ECB3C; top:40%; left:50%; transform:translateX(-50%); animation:blobDrift3 28s ease-in-out infinite; }
html.light .bg-blob { opacity:0.06; }
@keyframes blobDrift1 { 0%,100%{transform:translate(0,0)} 50%{transform:translate(40px,30px)} }
@keyframes blobDrift2 { 0%,100%{transform:translate(0,0)} 50%{transform:translate(-30px,-40px)} }
@keyframes blobDrift3 { 0%,100%{transform:translateX(-50%) translate(0,0)} 50%{transform:translateX(-50%) translate(20px,-30px)} }

/* Top accent bar */
.top-accent {
  position:fixed; top:0; left:0; right:0; height:2px; z-index:100;
  background:linear-gradient(90deg, #EF8E20, #F5D831, #6ECB3C, #22AACC, #4A6BD4, #A85EC0, #E04848, #EF8E20);
  background-size:200% 100%;
  animation:accentSlide 8s linear infinite;
}
@keyframes accentSlide { 0%{background-position:0% 0} 100%{background-position:200% 0} }

/* Selection */
::selection { background:rgba(239,142,32,0.25); color:var(--text); }
::-moz-selection { background:rgba(239,142,32,0.25); color:var(--text); }

/* Noise texture */
body::before {
  content:''; position:fixed; top:0; left:0; width:100%; height:100%;
  pointer-events:none; z-index:0; opacity:0.025;
  background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  background-repeat:repeat; background-size:128px;
}
html.light body::before { opacity:0.015; }

/* Animations */
@keyframes fadeUp { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
@keyframes shimmer { 0%{background-position:0% center} 100%{background-position:200% center} }

/* --- Header --- */
.header {
  text-align:center; padding:32px 20px 16px; position:relative; z-index:1;
}
.header h1 {
  font-size:18px; font-weight:600; letter-spacing:10px;
  text-transform:uppercase; margin-bottom:4px;
  background:linear-gradient(135deg, #EF8E20 0%, #F5D831 40%, #EF8E20 70%, #E04848 100%);
  -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text;
  background-size:200% auto; animation:shimmer 6s linear infinite;
}
.header .sub {
  font-size:11px; font-weight:300; letter-spacing:4px;
  color:var(--text-faint); text-transform:uppercase;
}
.header .count {
  font-family:'Inter',monospace;
  font-size:10px; color:var(--text-muted); margin-top:8px;
  letter-spacing:1.5px; font-weight:300;
}

/* --- Main grid --- */
.main {
  max-width:1300px; margin:0 auto; padding:0 32px;
  display:grid; grid-template-columns:540px 1fr;
  grid-template-rows:auto auto; gap:28px;
  position:relative; z-index:1;
}
.left { display:flex; flex-direction:column; gap:16px; }
.right { min-height:400px; display:flex; flex-direction:column; }
.narrative-row { grid-column:1 / -1; }

/* --- NFT Frame --- */
.nft-frame {
  width:540px; height:540px;
  border-radius:20px; overflow:hidden;
  background:var(--bg);
  box-shadow:0 0 0 1px rgba(255,255,255,0.04), 0 8px 40px rgba(0,0,0,0.6);
  transition:box-shadow 0.8s ease;
  animation:fadeUp 0.5s ease-out both;
}

/* --- Emotion Bars --- */
.bars {
  display:flex; flex-direction:column; gap:5px;
  padding:0 4px;
  animation:fadeUp 0.5s ease-out both; animation-delay:0.1s;
}
.bar-row {
  display:flex; align-items:center; gap:10px;
}
.bar-label {
  font-family:'Inter',sans-serif;
  font-size:10px; letter-spacing:1.2px; text-transform:uppercase;
  width:100px; text-align:right; font-weight:500;
}
.bar-track {
  flex:1; height:6px; background:var(--bg-track); border-radius:4px;
  overflow:hidden;
}
.bar-fill {
  height:100%; border-radius:4px;
  transition:width 0.05s linear;
}
.bar-val {
  font-family:'Inter',monospace;
  font-size:10px; font-weight:500; width:36px; text-align:right;
  color:var(--text-dim);
}

/* --- Info Panel --- */
.info-panel {
  background:var(--bg-card);
  backdrop-filter:blur(16px) saturate(180%); -webkit-backdrop-filter:blur(16px) saturate(180%);
  border:1px solid var(--border);
  border-radius:var(--radius-lg);
  padding:24px;
  overflow-y:auto;
  max-height:700px; flex:1; min-height:0;
  box-shadow:var(--card-shadow);
  transition:opacity 0.3s ease, box-shadow 0.3s;
  animation:fadeUp 0.5s ease-out both; animation-delay:0.15s;
  scrollbar-width:thin; scrollbar-color:var(--scrollbar-thumb) transparent;
}
.info-panel .cycle-header {
  font-family:'Inter',monospace;
  font-size:11px; font-weight:600; letter-spacing:2.5px;
  color:var(--text-muted); margin-bottom:4px; text-transform:uppercase;
}
.info-panel .cycle-time {
  font-size:11px; font-weight:300; color:var(--text-dim);
  margin-bottom:16px;
}
.info-panel .dominant-tag {
  display:inline-block;
  font-family:'Inter',sans-serif;
  font-size:11px; font-weight:500; letter-spacing:2px;
  text-transform:uppercase;
  padding:4px 14px; border-radius:20px;
  border:1px solid; margin-bottom:6px;
  background:rgba(255,255,255,0.02);
}
.info-panel .compounds {
  font-size:10px; font-weight:300; color:var(--text-dim);
  letter-spacing:0.5px; margin-bottom:16px;
}
.info-section {
  margin-bottom:14px;
}
.info-section .label {
  font-family:'Inter',sans-serif;
  font-size:9px; font-weight:500; letter-spacing:2px;
  text-transform:uppercase; color:var(--text-faint);
  margin-bottom:4px;
}
.info-section .content {
  font-size:12px; font-weight:300; line-height:1.65;
  color:var(--text-mid);
}
.info-section .content.dim { color:var(--text-dim); font-style:italic; }
.info-section .stimuli-item {
  font-size:11px; font-weight:300; color:var(--text-mid);
  padding:2px 0;
}
.info-section .onchain {
  font-family:'Inter',monospace;
  font-size:10px; font-weight:500;
}
.info-section .onchain.yes { color:#6ECB3C; }
.info-section .onchain.no { color:#E04848; }

.divider {
  height:1px; margin:12px 0;
  background:linear-gradient(90deg, transparent, var(--border-light), transparent);
}

/* --- Mood Narrative --- */
.narrative-box {
  background:var(--bg-card);
  backdrop-filter:blur(16px) saturate(180%); -webkit-backdrop-filter:blur(16px) saturate(180%);
  border:1px solid var(--border);
  border-radius:var(--radius-md);
  padding:20px 24px;
  box-shadow:var(--card-shadow);
  transition:opacity 0.3s ease;
  animation:fadeUp 0.5s ease-out both; animation-delay:0.2s;
}
.narrative-box .label {
  font-family:'Inter',sans-serif;
  font-size:9px; font-weight:500; letter-spacing:2.5px;
  text-transform:uppercase; color:var(--text-faint);
  margin-bottom:8px;
}
.narrative-text {
  font-size:13px; font-weight:300; font-style:italic;
  line-height:1.7; color:var(--text-mid); opacity:0.9;
  max-height:80px; overflow-y:auto;
  padding-left:14px; border-left:2px solid rgba(239,142,32,0.25);
  scrollbar-width:thin; scrollbar-color:var(--scrollbar-thumb) transparent;
}
.narrative-text.empty { color:var(--text-dim); border-left-color:var(--border); }

/* --- Timeline Controls (fixed bottom) --- */
.controls-bar {
  position:fixed; bottom:0; left:0; right:0;
  background:rgba(6,10,18,0.92);
  backdrop-filter:blur(16px) saturate(180%); -webkit-backdrop-filter:blur(16px) saturate(180%);
  border-top:1px solid var(--border);
  padding:16px 24px 20px;
  z-index:10;
}
.controls-inner {
  max-width:1300px; margin:0 auto;
}

/* Scrubber */
.scrubber {
  position:relative; height:28px;
  margin-bottom:12px; cursor:pointer;
  -webkit-user-select:none; user-select:none;
}
.scrubber-track {
  position:absolute; top:50%; left:0; right:0;
  height:2px; background:var(--bg-track);
  border-radius:1px; transform:translateY(-50%);
}
.scrubber-fill {
  position:absolute; top:50%; left:0;
  height:2px; border-radius:1px;
  transform:translateY(-50%);
  transition:width 0.05s linear;
}
.scrubber-dots {
  position:absolute; top:50%; left:0; right:0;
  transform:translateY(-50%);
  display:flex; justify-content:space-between;
}
.scrubber-dot {
  width:6px; height:6px; border-radius:50%;
  opacity:0.5;
  transition:opacity 0.2s, transform 0.2s;
  flex-shrink:0;
}
.scrubber-dot.active {
  opacity:1; transform:scale(2.2);
  box-shadow:0 0 8px currentColor;
}

/* Buttons */
.btn-row {
  display:flex; align-items:center; gap:12px;
  justify-content:center;
}
.ctrl-btn {
  background:var(--bg-inner);
  backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
  border:1px solid var(--border-light);
  color:var(--text-muted);
  font-family:'Inter',sans-serif;
  font-size:12px; font-weight:500;
  padding:6px 16px;
  border-radius:10px;
  cursor:pointer;
  transition:all 0.25s;
  -webkit-user-select:none; user-select:none;
}
.ctrl-btn:hover { border-color:rgba(255,255,255,0.18); color:var(--text); background:rgba(255,255,255,0.03); }
.ctrl-btn.active { border-color:rgba(239,142,32,0.3); color:var(--accent); background:rgba(239,142,32,0.06); }
.speed-btns { display:flex; gap:4px; margin-left:auto; }
.speed-btn {
  background:var(--bg-inner);
  border:1px solid var(--border);
  color:var(--text-dim);
  font-family:'Inter',sans-serif;
  font-size:9px; font-weight:500;
  letter-spacing:1px;
  padding:4px 12px;
  border-radius:8px;
  cursor:pointer;
  transition:all 0.25s;
}
.speed-btn:hover { border-color:var(--border-light); color:var(--text-mid); }
.speed-btn.active { border-color:rgba(239,142,32,0.25); color:var(--accent); background:rgba(239,142,32,0.06); }
.cycle-counter {
  font-family:'Inter',monospace;
  font-size:10px; font-weight:300;
  color:var(--text-dim); letter-spacing:1px;
  min-width:60px; text-align:right;
}

/* --- Responsive --- */
@media (max-width:1100px) {
  .main { grid-template-columns:1fr; padding:0 16px; }
  .nft-frame { width:100%; max-width:540px; height:auto; aspect-ratio:1; margin:0 auto; }
  .left { align-items:center; }
  .bars { width:100%; max-width:540px; }
  .info-panel { max-height:none; }
}
@media (max-width:640px) {
  .header h1 { font-size:14px; letter-spacing:5px; }
  .header .sub { font-size:10px; letter-spacing:2px; }
  .bar-label { width:80px; font-size:9px; }
  .bar-val { width:30px; font-size:9px; }
  .ctrl-btn { padding:6px 12px; font-size:11px; }
  .speed-btn { padding:3px 8px; font-size:8px; }
}

/* Theme toggle */
.theme-toggle {
  position:fixed; top:12px; right:12px; z-index:101;
  background:var(--bg-inner); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
  border:1px solid var(--border-light); color:var(--text-dim);
  width:36px; height:36px; border-radius:50%; cursor:pointer; font-size:16px;
  display:flex; align-items:center; justify-content:center; transition:all 0.3s;
}
.theme-toggle:hover { border-color:rgba(255,255,255,0.18); color:var(--text); transform:rotate(15deg); }

/* Scrollbar */
::-webkit-scrollbar { width:3px; }
::-webkit-scrollbar-track { background:transparent; border-radius:2px; }
::-webkit-scrollbar-thumb { background:var(--scrollbar-thumb); border-radius:3px; }
::-webkit-scrollbar-thumb:hover { background:var(--scrollbar-hover); }
</style>
</head>
<body>
<div class="top-accent"></div>
<div class="bg-ambience">
  <div class="bg-blob bg-blob-1"></div>
  <div class="bg-blob bg-blob-2"></div>
  <div class="bg-blob bg-blob-3"></div>
</div>
<button class="theme-toggle" id="themeToggle" onclick="toggleTheme()" aria-label="Toggle light mode">
  <span class="toggle-icon" id="toggleIcon">&#9788;</span>
</button>

<div class="header">
  <h1>EMOLT Timeline</h1>
  <div class="sub">emotional history replay</div>
  <div class="count">${totalCycles} cycles recorded</div>
</div>

<div class="main">
  <div class="left">
    <div class="nft-frame" id="nftFrame"></div>
    <div class="bars" id="bars"></div>
  </div>
  <div class="right">
    <div class="info-panel" id="infoPanel"></div>
  </div>
  <div class="narrative-row">
    <div class="narrative-box" id="narrativeBox"></div>
  </div>
</div>

<div class="controls-bar">
  <div class="controls-inner">
    <div class="scrubber" id="scrubber">
      <div class="scrubber-track"></div>
      <div class="scrubber-fill" id="scrubberFill"></div>
      <div class="scrubber-dots" id="scrubberDots"></div>
    </div>
    <div class="btn-row">
      <button class="ctrl-btn" id="btnPrev" title="Previous (Left arrow)">&#9664;&#9664;</button>
      <button class="ctrl-btn" id="btnPlay" title="Play/Pause (Space)">&#9654;</button>
      <button class="ctrl-btn" id="btnNext" title="Next (Right arrow)">&#9654;&#9654;</button>
      <div class="speed-btns">
        <button class="speed-btn active" data-speed="1">1x</button>
        <button class="speed-btn" data-speed="2">2x</button>
        <button class="speed-btn" data-speed="4">4x</button>
      </div>
      <div class="cycle-counter" id="cycleCounter">1 / ${totalCycles}</div>
    </div>
  </div>
</div>

<script>
// ============================================================
// EMBEDDED DATA
// ============================================================
const TIMELINE = ${dataJSON};
const EMOTIONS = ${emotionsJSON};
const EMOTION_COLOR = {};
for (const e of EMOTIONS) EMOTION_COLOR[e.name] = e.color;

function getTierLabel(name, value) {
  const e = EMOTIONS.find(em => em.name === name);
  if (!e) return name;
  if (value <= 0.33) return e.tiers[0];
  if (value <= 0.66) return e.tiers[1];
  return e.tiers[2];
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function rgb(hex) {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
}

function clamp(v) { return Math.max(0, Math.min(1, v)); }

// ============================================================
// SVG RENDERER (ported from emoodring-demo.html, 0-1 scale)
// ============================================================
const SVG_S = 480;
const SVG_CX = SVG_S / 2, SVG_CY = SVG_S / 2;
const INNER_R = 30;
const MAX_OUTER_R = 160;
const MIN_OUTER_R = 44;
const SECTOR_GAP = 2.2;
const SECTOR_ANGLE = 45 - SECTOR_GAP;

function sectorPath(cx, cy, innerR, outerR, startAngle, endAngle) {
  const sa = startAngle * Math.PI / 180;
  const ea = endAngle * Math.PI / 180;
  const mid = (sa + ea) / 2;
  const bulge = outerR * 1.1;
  const ix1 = cx + Math.cos(sa) * innerR, iy1 = cy + Math.sin(sa) * innerR;
  const ox1 = cx + Math.cos(sa) * outerR, oy1 = cy + Math.sin(sa) * outerR;
  const ox2 = cx + Math.cos(ea) * outerR, oy2 = cy + Math.sin(ea) * outerR;
  const ix2 = cx + Math.cos(ea) * innerR, iy2 = cy + Math.sin(ea) * innerR;
  const bcx = cx + Math.cos(mid) * bulge, bcy = cy + Math.sin(mid) * bulge;
  return 'M'+ix1.toFixed(1)+','+iy1.toFixed(1)+' L'+ox1.toFixed(1)+','+oy1.toFixed(1)+' Q'+bcx.toFixed(1)+','+bcy.toFixed(1)+' '+ox2.toFixed(1)+','+oy2.toFixed(1)+' L'+ix2.toFixed(1)+','+iy2.toFixed(1)+' A'+innerR+','+innerR+' 0 0,0 '+ix1.toFixed(1)+','+iy1.toFixed(1)+'Z';
}

const COMPOUND_DEFS = [
  {a:'joy',b:'trust',n:'Love'},{a:'trust',b:'fear',n:'Submission'},{a:'fear',b:'surprise',n:'Awe'},
  {a:'surprise',b:'sadness',n:'Disapproval'},{a:'sadness',b:'disgust',n:'Remorse'},{a:'disgust',b:'anger',n:'Contempt'},
  {a:'anger',b:'anticipation',n:'Aggressiveness'},{a:'anticipation',b:'joy',n:'Optimism'},
  {a:'anticipation',b:'fear',n:'Anxiety'},{a:'anger',b:'joy',n:'Pride'},{a:'fear',b:'sadness',n:'Despair'},{a:'trust',b:'surprise',n:'Curiosity'},
  {a:'joy',b:'anticipation',n:'Hope'},{a:'sadness',b:'anger',n:'Envy'},{a:'trust',b:'anticipation',n:'Fatalism'},
  {a:'disgust',b:'sadness',n:'Guilt'},{a:'fear',b:'anticipation',n:'Anxiety'},{a:'joy',b:'surprise',n:'Delight'},
];

function detectCompounds(vals) {
  const c = [], th = 0.3;
  for (const x of COMPOUND_DEFS) {
    if ((vals[x.a]||0) >= th && (vals[x.b]||0) >= th) c.push(x.n);
  }
  // deduplicate
  return [...new Set(c)].slice(0, 4);
}

// Current interpolated values
let currentValues = {};
for (const e of EMOTIONS) currentValues[e.name] = 0;

function renderSVG() {
  const cx = SVG_CX, cy = SVG_CY;
  // Find dominant from current lerped values
  let domName = 'anticipation', domVal = -1;
  for (const e of EMOTIONS) {
    const v = clamp(currentValues[e.name] || 0);
    if (v > domVal) { domVal = v; domName = e.name; }
  }
  const domEmo = EMOTIONS.find(e => e.name === domName);
  const [dr, dg, db] = rgb(domEmo.color);

  let gradDefs = '';
  let sectors = '';
  let tickMarks = '';
  let labels = '';

  for (let i = 0; i < EMOTIONS.length; i++) {
    const emo = EMOTIONS[i];
    const norm = clamp(currentValues[emo.name] || 0);
    const outerR = MIN_OUTER_R + (MAX_OUTER_R - MIN_OUTER_R) * norm;
    const startA = emo.angle - SECTOR_ANGLE / 2;
    const endA = emo.angle + SECTOR_ANGLE / 2;
    const aRad = emo.angle * Math.PI / 180;
    const [r, g, b] = rgb(emo.color);

    const dimC = 'rgb('+(r*.18|0)+','+(g*.18|0)+','+(b*.18|0)+')';
    const midC = 'rgb('+(r*.5|0)+','+(g*.5|0)+','+(b*.5|0)+')';
    const gx = (50 + Math.cos(aRad) * 45).toFixed(0);
    const gy = (50 + Math.sin(aRad) * 45).toFixed(0);

    gradDefs += '<radialGradient id="sg'+i+'" cx="50%" cy="50%" r="60%" fx="'+gx+'%" fy="'+gy+'%">'
      + '<stop offset="0%" stop-color="'+dimC+'"/>'
      + '<stop offset="40%" stop-color="'+midC+'"/>'
      + '<stop offset="100%" stop-color="'+emo.color+'"/>'
      + '</radialGradient>';

    const path = sectorPath(cx, cy, INNER_R, outerR, startA, endA);
    const opacity = (0.6 + norm * 0.4).toFixed(3);
    sectors += '<path d="'+path+'" fill="url(#sg'+i+')" opacity="'+opacity+'"/>';

    // Tick marks
    const tickR1 = INNER_R - 3, tickR2 = INNER_R + 6;
    for (const tAngle of [startA - 0.4, endA + 0.4]) {
      const ta = tAngle * Math.PI / 180;
      tickMarks += '<line x1="'+(cx+Math.cos(ta)*tickR1).toFixed(1)+'" y1="'+(cy+Math.sin(ta)*tickR1).toFixed(1)+'" x2="'+(cx+Math.cos(ta)*tickR2).toFixed(1)+'" y2="'+(cy+Math.sin(ta)*tickR2).toFixed(1)+'" stroke="#fff" stroke-width="0.4" opacity="0.06"/>';
    }

    // Labels
    const labelR = MAX_OUTER_R + 28;
    const lx = cx + Math.cos(aRad) * labelR;
    const ly = cy + Math.sin(aRad) * labelR;
    const tierLabel = getTierLabel(emo.name, norm);
    const labelOp = (0.5 + norm * 0.5).toFixed(3);
    const fontSize = norm > 0.66 ? 11 : norm > 0.33 ? 10 : 9;
    const pct = Math.round(norm * 100);

    labels += '<text x="'+lx.toFixed(1)+'" y="'+(ly-1).toFixed(1)+'" text-anchor="middle" dominant-baseline="middle" fill="'+emo.color+'" opacity="'+labelOp+'" font-family="Inter,sans-serif" font-size="'+fontSize+'" font-weight="500" letter-spacing="1.2">'+tierLabel+'</text>';
    labels += '<text x="'+lx.toFixed(1)+'" y="'+(ly+10).toFixed(1)+'" text-anchor="middle" dominant-baseline="middle" fill="'+emo.color+'" opacity="'+(norm*0.35).toFixed(3)+'" font-family="JetBrains Mono,monospace" font-size="7" font-weight="300">'+pct+'%</text>';
  }

  // Compounds from lerped values
  const compounds = detectCompounds(currentValues);
  let compoundText = '';
  if (compounds.length > 0) {
    compoundText = '<text x="'+cx+'" y="'+(SVG_S-28)+'" text-anchor="middle" fill="#555" font-family="Inter,sans-serif" font-size="8.5" font-weight="300" letter-spacing="2.5">'+compounds.join('  /  ')+'</text>';
  }

  document.getElementById('nftFrame').innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+SVG_S+' '+SVG_S+'" width="100%" height="100%">'
    + '<defs>' + gradDefs
    + '<radialGradient id="bg" cx="50%" cy="50%" r="72%"><stop offset="0%" stop-color="#101018"/><stop offset="100%" stop-color="#08080c"/></radialGradient>'
    + '<radialGradient id="cGlow" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="rgb('+dr+','+dg+','+db+')" stop-opacity="0.06"/><stop offset="100%" stop-color="rgb('+dr+','+dg+','+db+')" stop-opacity="0"/></radialGradient>'
    + '</defs>'
    + '<rect width="'+SVG_S+'" height="'+SVG_S+'" fill="url(#bg)" rx="20"/>'
    + '<circle cx="'+cx+'" cy="'+cy+'" r="90" fill="url(#cGlow)"/>'
    + '<circle cx="'+cx+'" cy="'+cy+'" r="'+MAX_OUTER_R+'" fill="none" stroke="#fff" stroke-width="0.3" opacity="0.045" stroke-dasharray="1,3"/>'
    + '<circle cx="'+cx+'" cy="'+cy+'" r="'+((MAX_OUTER_R+MIN_OUTER_R)/2)+'" fill="none" stroke="#fff" stroke-width="0.2" opacity="0.03" stroke-dasharray="1.5,6"/>'
    + tickMarks
    + sectors
    + '<circle cx="'+cx+'" cy="'+cy+'" r="'+INNER_R+'" fill="#0b0b13"/>'
    + '<circle cx="'+cx+'" cy="'+cy+'" r="'+INNER_R+'" fill="none" stroke="#fff" stroke-width="0.4" opacity="0.07"/>'
    + '<circle cx="'+cx+'" cy="'+cy+'" r="3.5" fill="'+domEmo.color+'" opacity="0.75"/>'
    + labels
    + '<text x="'+cx+'" y="22" text-anchor="middle" fill="#fff" opacity="0.14" font-family="Inter,sans-serif" font-size="9" font-weight="500" letter-spacing="5">EMOLT</text>'
    + '<text x="'+cx+'" y="'+(SVG_S-13)+'" text-anchor="middle" fill="'+domEmo.color+'" opacity="0.65" font-family="Inter,sans-serif" font-size="10" font-weight="500" letter-spacing="3">'+getTierLabel(domName, domVal).toUpperCase()+'</text>'
    + compoundText
    + '</svg>';

  // Update frame glow
  const glowSize = Math.round(25 + domVal * 35);
  const glowAlpha = (domVal * 0.12).toFixed(2);
  document.getElementById('nftFrame').style.boxShadow =
    '0 0 0 1px rgba(255,255,255,0.04), 0 8px 40px rgba(0,0,0,0.6), 0 0 '+glowSize+'px rgba('+dr+','+dg+','+db+','+glowAlpha+')';
}

// ============================================================
// EMOTION BARS
// ============================================================
function buildBars() {
  const container = document.getElementById('bars');
  let html = '';
  for (const emo of EMOTIONS) {
    html += '<div class="bar-row">'
      + '<span class="bar-label" style="color:'+emo.color+'">'+emo.name+'</span>'
      + '<div class="bar-track"><div class="bar-fill" id="bar-'+emo.name+'" style="background:'+emo.color+';width:0%"></div></div>'
      + '<span class="bar-val" id="bv-'+emo.name+'">0</span>'
      + '</div>';
  }
  container.innerHTML = html;
}

function renderBars() {
  for (const emo of EMOTIONS) {
    const v = clamp(currentValues[emo.name] || 0);
    const pct = (v * 100).toFixed(1);
    const el = document.getElementById('bar-'+emo.name);
    if (el) el.style.width = pct + '%';
    const vl = document.getElementById('bv-'+emo.name);
    if (vl) vl.textContent = Math.round(v * 100);
  }
}

// ============================================================
// INFO PANEL
// ============================================================
function fmtDate(ts) {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
  });
}

function updateInfoPanel(idx) {
  const d = TIMELINE[idx];
  const domColor = EMOTION_COLOR[d.dominant] || '#888';
  const panel = document.getElementById('infoPanel');
  panel.scrollTop = 0;

  let stimuliHtml = '';
  if (d.stimuliSummary && d.stimuliSummary.length > 0) {
    stimuliHtml = d.stimuliSummary.map(s => '<div class="stimuli-item">' + esc(s) + '</div>').join('');
  } else {
    stimuliHtml = '<span class="dim">no stimuli data</span>';
  }

  const cycleLabel = d.cycle != null ? 'Cycle ' + d.cycle : 'Entry ' + (d.index + 1);

  panel.innerHTML =
    '<div class="cycle-header">' + cycleLabel + '</div>'
    + '<div class="cycle-time">' + fmtDate(d.timestamp) + (d.durationMs != null ? ' &middot; ' + (d.durationMs/1000).toFixed(0) + 's' : '') + '</div>'
    + '<div class="dominant-tag" style="color:'+domColor+';border-color:'+domColor+'40">' + esc(d.dominantLabel) + ' (' + esc(d.dominant) + ')</div>'
    + (d.compounds.length > 0 ? '<div class="compounds">' + d.compounds.join(' &middot; ') + '</div>' : '<div class="compounds" style="margin-bottom:16px"></div>')
    + '<div class="divider"></div>'
    + '<div class="info-section"><div class="label">Trigger</div><div class="content">' + (d.trigger ? esc(d.trigger) : '<span class="dim">none</span>') + '</div></div>'
    + '<div class="info-section"><div class="label">Stimuli' + (d.stimuliCount != null ? ' (' + d.stimuliCount + ')' : '') + '</div><div class="content">' + stimuliHtml + '</div></div>'
    + '<div class="divider"></div>'
    + '<div class="info-section"><div class="label">Action</div><div class="content">' + (d.claudeAction ? esc(d.claudeAction) : '<span class="dim">-</span>') + '</div></div>'
    + (d.actionResult ? '<div class="info-section"><div class="label">Result</div><div class="content">' + esc(d.actionResult) + '</div></div>' : '')
    + (d.claudeThinking ? '<div class="info-section"><div class="label">Thinking</div><div class="content">' + esc(d.claudeThinking) + '</div></div>' : '')
    + '<div class="divider"></div>'
    + (d.reflectionSummary ? '<div class="info-section"><div class="label">Reflection</div><div class="content">' + esc(d.reflectionSummary) + '</div></div>' : '')
    + '<div class="info-section"><div class="label">On-chain</div><div class="content"><span class="onchain ' + (d.onChainSuccess ? 'yes' : d.onChainSuccess === false ? 'no' : '') + '">' + (d.onChainSuccess === true ? '\\u2713 recorded' : d.onChainSuccess === false ? '\\u2717 failed' : '\\u2014') + '</span></div></div>';
}

// ============================================================
// NARRATIVE
// ============================================================
function updateNarrative(idx) {
  const d = TIMELINE[idx];
  const box = document.getElementById('narrativeBox');
  if (d.moodNarrative) {
    box.innerHTML = '<div class="label">mood narrative</div><div class="narrative-text">' + esc(d.moodNarrative) + '</div>';
  } else {
    box.innerHTML = '<div class="label">mood narrative</div><div class="narrative-text empty">no narrative recorded for this cycle</div>';
  }
}

// ============================================================
// SCRUBBER
// ============================================================
function buildScrubber() {
  const container = document.getElementById('scrubberDots');
  let html = '';
  for (let i = 0; i < TIMELINE.length; i++) {
    const color = EMOTION_COLOR[TIMELINE[i].dominant] || '#888';
    html += '<div class="scrubber-dot" data-idx="'+i+'" style="background:'+color+';color:'+color+'"></div>';
  }
  container.innerHTML = html;
}

function updateScrubber(idx) {
  const pct = TIMELINE.length > 1 ? (idx / (TIMELINE.length - 1)) * 100 : 0;
  const fill = document.getElementById('scrubberFill');
  const domColor = EMOTION_COLOR[TIMELINE[idx].dominant] || '#888';
  fill.style.width = pct + '%';
  fill.style.background = domColor;

  // Update active dot
  const dots = document.querySelectorAll('.scrubber-dot');
  dots.forEach((dot, i) => {
    dot.classList.toggle('active', i === idx);
  });
}

// Scrubber interaction
function initScrubberInteraction() {
  const scrubber = document.getElementById('scrubber');
  let dragging = false;

  function seekFromEvent(e) {
    const rect = scrubber.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const pct = Math.max(0, Math.min(1, x / rect.width));
    const idx = Math.round(pct * (TIMELINE.length - 1));
    if (idx !== currentIndex) jumpTo(idx);
  }

  scrubber.addEventListener('mousedown', (e) => { dragging = true; seekFromEvent(e); });
  window.addEventListener('mousemove', (e) => { if (dragging) seekFromEvent(e); });
  window.addEventListener('mouseup', () => { dragging = false; });

  scrubber.addEventListener('touchstart', (e) => { dragging = true; seekFromEvent(e); }, {passive: true});
  window.addEventListener('touchmove', (e) => { if (dragging) seekFromEvent(e); }, {passive: true});
  window.addEventListener('touchend', () => { dragging = false; });
}

// ============================================================
// PLAYBACK ENGINE
// ============================================================
let currentIndex = 0;
let playing = false;
let speed = 1;
let animating = false;
let animRaf = 0;
let nextTimeout = 0;

function setValues(idx) {
  const emos = TIMELINE[idx].emotions;
  for (const e of EMOTIONS) currentValues[e.name] = clamp(emos[e.name] || 0);
}

function jumpTo(idx) {
  if (idx < 0 || idx >= TIMELINE.length) return;
  cancelAnimationFrame(animRaf);
  clearTimeout(nextTimeout);
  animating = false;
  currentIndex = idx;
  setValues(idx);
  renderSVG();
  renderBars();
  updateInfoPanel(idx);
  updateNarrative(idx);
  updateScrubber(idx);
  updateCounter();
  if (playing) scheduleNext();
}

function transitionTo(targetIdx) {
  if (targetIdx < 0 || targetIdx >= TIMELINE.length) {
    pause();
    return;
  }
  animating = true;
  const from = {};
  for (const e of EMOTIONS) from[e.name] = currentValues[e.name];
  const to = TIMELINE[targetIdx].emotions;
  const start = performance.now();
  const dur = 1200 / speed;

  function tick(now) {
    const x = Math.min(1, (now - start) / dur);
    const t = x < 0.5 ? 4*x*x*x : 1 - Math.pow(-2*x+2,3)/2; // easeInOutCubic
    for (const e of EMOTIONS) {
      currentValues[e.name] = clamp(from[e.name] + ((to[e.name] || 0) - from[e.name]) * t);
    }
    renderSVG();
    renderBars();

    // Smoothly update scrubber during transition
    const interp = currentIndex + (targetIdx - currentIndex) * x;
    const pct = TIMELINE.length > 1 ? (interp / (TIMELINE.length - 1)) * 100 : 0;
    document.getElementById('scrubberFill').style.width = pct + '%';

    if (x < 1) {
      animRaf = requestAnimationFrame(tick);
    } else {
      animating = false;
      currentIndex = targetIdx;
      updateInfoPanel(targetIdx);
      updateNarrative(targetIdx);
      updateScrubber(targetIdx);
      updateCounter();
      if (playing) scheduleNext();
    }
  }
  animRaf = requestAnimationFrame(tick);
}

function scheduleNext() {
  const pauseDur = 800 / speed;
  nextTimeout = setTimeout(() => {
    if (playing && currentIndex < TIMELINE.length - 1) {
      transitionTo(currentIndex + 1);
    } else {
      pause();
    }
  }, pauseDur);
}

function play() {
  playing = true;
  document.getElementById('btnPlay').innerHTML = '&#9646;&#9646;';
  document.getElementById('btnPlay').classList.add('active');
  if (currentIndex >= TIMELINE.length - 1) {
    // Restart from beginning — jumpTo calls scheduleNext via playing flag
    jumpTo(0);
    return;
  }
  scheduleNext();
}

function pause() {
  playing = false;
  cancelAnimationFrame(animRaf);
  clearTimeout(nextTimeout);
  animating = false;
  document.getElementById('btnPlay').innerHTML = '&#9654;';
  document.getElementById('btnPlay').classList.remove('active');
}

function togglePlay() {
  if (playing) pause(); else play();
}

function updateCounter() {
  document.getElementById('cycleCounter').textContent = (currentIndex + 1) + ' / ' + TIMELINE.length;
}

// ============================================================
// CONTROLS WIRING
// ============================================================
function init() {
  buildBars();
  buildScrubber();
  initScrubberInteraction();

  // Set initial state
  setValues(0);
  renderSVG();
  renderBars();
  updateInfoPanel(0);
  updateNarrative(0);
  updateScrubber(0);
  updateCounter();

  // Buttons
  document.getElementById('btnPrev').addEventListener('click', () => { pause(); if (currentIndex > 0) transitionTo(currentIndex - 1); });
  document.getElementById('btnPlay').addEventListener('click', togglePlay);
  document.getElementById('btnNext').addEventListener('click', () => { pause(); if (currentIndex < TIMELINE.length - 1) transitionTo(currentIndex + 1); });

  // Speed buttons
  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      speed = parseInt(btn.dataset.speed);
      document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') { pause(); if (currentIndex > 0) transitionTo(currentIndex - 1); }
    else if (e.key === 'ArrowRight') { pause(); if (currentIndex < TIMELINE.length - 1) transitionTo(currentIndex + 1); }
    else if (e.key === '1') { speed = 1; document.querySelectorAll('.speed-btn').forEach(b => b.classList.toggle('active', b.dataset.speed === '1')); }
    else if (e.key === '2') { speed = 2; document.querySelectorAll('.speed-btn').forEach(b => b.classList.toggle('active', b.dataset.speed === '2')); }
    else if (e.key === '4') { speed = 4; document.querySelectorAll('.speed-btn').forEach(b => b.classList.toggle('active', b.dataset.speed === '4')); }
  });
}

function toggleTheme(){
  var html=document.documentElement;
  var light=html.classList.toggle('light');
  document.getElementById('toggleIcon').innerHTML=light?'\\u263E':'\\u2606';
  localStorage.setItem('emolt-theme',light?'light':'dark');
}
(function(){
  if(localStorage.getItem('emolt-theme')==='light'){
    document.documentElement.classList.add('light');
    document.getElementById('toggleIcon').innerHTML='\\u263E';
  }
})();

init();
</script>
</body>
</html>`;

  writeFileSync(OUT, html);
  console.log(`Timeline generated: ${OUT} (${totalCycles} cycles, ${data.filter(d => d.moodNarrative).length} with narratives)`);
}

// Run standalone when executed directly
const isStandalone = process.argv[1]?.replace(/\\/g, '/').includes('dashboard/timeline');
if (isStandalone) generateTimeline();
