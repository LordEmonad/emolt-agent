/**
 * EMOLT Diary — Daily journal page
 * Reads state/journal.json and writes diary.html
 * Run: npx tsx src/dashboard/diary.ts
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const STATE = './state';
const OUT = './diary.html';

export interface JournalEntry {
  date: string;              // YYYY-MM-DD
  dayNumber: number;         // sequential day count
  title: string;             // short poetic title
  body: string;              // the diary prose (markdown-ish)
  dominantEmotion: string;   // e.g. 'joy'
  emotionSnapshot: Record<string, number>;  // all 8 emotions 0-1
  highlights: string[];      // 3-5 key events
  cycleRange: [number, number]; // [start, end] cycle numbers
  onChainWrites: number;
  emoBurned: string;         // formatted amount
  feedCount: number;         // number of feeds received
  timestamp: number;         // when entry was generated
}

function readJSON(file: string): any {
  try {
    return JSON.parse(readFileSync(join(STATE, file), 'utf-8'));
  } catch { return null; }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const EMOTIONS: { name: string; color: string }[] = [
  { name: 'joy',          color: '#F5D831' },
  { name: 'trust',        color: '#6ECB3C' },
  { name: 'fear',         color: '#2BA84A' },
  { name: 'surprise',     color: '#22AACC' },
  { name: 'sadness',      color: '#4A6BD4' },
  { name: 'disgust',      color: '#A85EC0' },
  { name: 'anger',        color: '#E04848' },
  { name: 'anticipation', color: '#EF8E20' },
];

function getEmotionColor(name: string): string {
  return EMOTIONS.find(e => e.name === name)?.color || '#888';
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  const months = ['january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'];
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
    'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function buildEmotionRing(snapshot: Record<string, number>, size: number = 48): string {
  // Tiny ring showing the emotional palette for that day
  const cx = size / 2;
  const cy = size / 2;
  const r = (size / 2) - 4;
  const total = EMOTIONS.reduce((sum, e) => sum + (snapshot[e.name] || 0), 0) || 1;

  let segments = '';
  let currentAngle = -90; // start at top

  for (const emo of EMOTIONS) {
    const val = snapshot[emo.name] || 0;
    if (val < 0.02) continue;
    const sweep = (val / total) * 360;
    const startRad = (currentAngle * Math.PI) / 180;
    const endRad = ((currentAngle + sweep) * Math.PI) / 180;
    const x1 = cx + r * Math.cos(startRad);
    const y1 = cy + r * Math.sin(startRad);
    const x2 = cx + r * Math.cos(endRad);
    const y2 = cy + r * Math.sin(endRad);
    const largeArc = sweep > 180 ? 1 : 0;

    segments += `<path d="M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${largeArc},1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${emo.color}" opacity="0.85"/>`;
    currentAngle += sweep;
  }

  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" class="diary-ring">${segments}</svg>`;
}

function buildEmotionBars(snapshot: Record<string, number>): string {
  let bars = '';
  for (const emo of EMOTIONS) {
    const val = snapshot[emo.name] || 0;
    const pct = Math.round(val * 100);
    bars += `<div class="diary-ebar">
      <span class="diary-ebar-label">${emo.name}</span>
      <div class="diary-ebar-track"><div class="diary-ebar-fill" style="width:${pct}%;background:${emo.color}"></div></div>
      <span class="diary-ebar-val">${pct}</span>
    </div>`;
  }
  return `<div class="diary-ebars">${bars}</div>`;
}

function bodyToHtml(body: string): string {
  // Convert diary body to HTML paragraphs, preserving line breaks as paragraphs
  return body
    .split(/\n\n+/)
    .filter(p => p.trim())
    .map(p => `<p>${esc(p.trim())}</p>`)
    .join('\n');
}

function buildEntry(entry: JournalEntry, index: number): string {
  const dateFormatted = formatDate(entry.date);
  const emotionColor = getEmotionColor(entry.dominantEmotion);
  const ring = buildEmotionRing(entry.emotionSnapshot);
  const bars = buildEmotionBars(entry.emotionSnapshot);

  let highlights = '';
  if (entry.highlights.length > 0) {
    highlights = entry.highlights.map(h => `<span class="diary-highlight">${esc(h)}</span>`).join('');
  }

  const stats: string[] = [];
  if (entry.cycleRange) stats.push(`cycles ${entry.cycleRange[0]}&ndash;${entry.cycleRange[1]}`);
  if (entry.onChainWrites) stats.push(`${entry.onChainWrites} oracle writes`);
  if (entry.emoBurned && entry.emoBurned !== '0') stats.push(`${esc(entry.emoBurned)} $EMO burned`);
  if (entry.feedCount) stats.push(`${entry.feedCount} feed${entry.feedCount > 1 ? 's' : ''} received`);

  return `
    <article class="diary-entry" style="animation-delay:${index * 0.08}s;--emotion-color:${emotionColor}">
      <div class="diary-entry-gutter">
        <div class="diary-date-ring" style="border-color:${emotionColor}">
          ${ring}
        </div>
        <div class="diary-gutter-line" style="background:linear-gradient(180deg, ${emotionColor}44, transparent)"></div>
      </div>
      <div class="diary-entry-content">
        <header class="diary-entry-header">
          <div class="diary-date-block">
            <time class="diary-date">${dateFormatted}</time>
            <span class="diary-day-num">day ${entry.dayNumber}</span>
          </div>
          <div class="diary-dominant" style="color:${emotionColor}">
            <span class="diary-dominant-dot" style="background:${emotionColor}"></span>
            ${esc(entry.dominantEmotion)}
          </div>
        </header>
        <h2 class="diary-title" style="color:${emotionColor}">${esc(entry.title)}</h2>
        <div class="diary-prose">
          ${bodyToHtml(entry.body)}
        </div>
        ${highlights ? `<div class="diary-highlights">${highlights}</div>` : ''}
        <footer class="diary-entry-footer">
          <div class="diary-emotions-panel">
            <div class="diary-emotions-label">emotional palette</div>
            ${bars}
          </div>
          ${stats.length > 0 ? `<div class="diary-stats">${stats.map(s => `<span class="diary-stat">${s}</span>`).join('')}</div>` : ''}
        </footer>
      </div>
    </article>`;
}

function buildNav(entries: JournalEntry[]): string {
  if (entries.length <= 1) return '';
  let items = '';
  for (const entry of entries) {
    const color = getEmotionColor(entry.dominantEmotion);
    items += `<a href="#entry-${entry.date}" class="diary-nav-item" style="--dot-color:${color}">
      <span class="diary-nav-dot" style="background:${color}"></span>
      <span class="diary-nav-date">${formatDateShort(entry.date)}</span>
    </a>`;
  }
  return `<nav class="diary-nav"><div class="diary-nav-inner">${items}</div></nav>`;
}

export function generateDiary(): void {
  const journal: JournalEntry[] = readJSON('journal.json') || [];

  // Sort newest first
  const sorted = [...journal].sort((a, b) => b.date.localeCompare(a.date));

  const totalDays = sorted.length;
  const dateRange = totalDays > 0
    ? `${formatDateShort(sorted[sorted.length - 1].date)} &mdash; ${formatDateShort(sorted[0].date)}`
    : 'no entries yet';

  let entries = '';
  if (sorted.length === 0) {
    entries = `
      <div class="diary-empty">
        <div class="diary-empty-icon">&#9998;</div>
        <p>no entries yet.</p>
        <p class="diary-empty-sub">the first diary entry will appear after a full day of feeling.</p>
      </div>`;
  } else {
    for (let i = 0; i < sorted.length; i++) {
      entries += `<div id="entry-${sorted[i].date}">${buildEntry(sorted[i], i)}</div>`;
    }
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EMOLT &mdash; Diary</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Lora:ital,wght@0,400;0,500;0,600;1,400;1,500&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<div class="top-accent"></div>
<div class="bg-ambience">
  <div class="bg-blob bg-blob-1"></div>
  <div class="bg-blob bg-blob-2"></div>
</div>

<div class="diary-page">
  <header class="diary-header">
    <div class="diary-header-nav">
      <a href="heartbeat.html" class="header-link">&larr; heartbeat</a>
      <span class="link-sep">/</span>
      <a href="timeline.html" class="header-link">timeline</a>
      <span class="link-sep">/</span>
      <a href="burnboard.html" class="header-link">burnboard</a>
    </div>
    <h1 class="diary-page-title">diary</h1>
    <p class="diary-page-sub">what i felt today</p>
    <div class="diary-header-stats">
      <span class="stat-chip">${totalDays} ${totalDays === 1 ? 'entry' : 'entries'}</span>
      <span class="stat-chip">${dateRange}</span>
    </div>
    <button class="theme-toggle" onclick="document.documentElement.classList.toggle('light')" title="Toggle theme">&#9681;</button>
  </header>

  ${buildNav(sorted)}

  <main class="diary-entries">
    ${entries}
  </main>

  <footer class="diary-footer">
    <div class="footer-line"></div>
    <p class="footer-text">emolt &mdash; computed feelings</p>
  </footer>
</div>

</body>
</html>`;

  writeFileSync(OUT, html, 'utf-8');
  console.log(`[Diary] Generated ${OUT} (${totalDays} entries)`);
}

// --- CSS ---
const CSS = `
:root {
  --bg:#060a12; --bg-card:rgba(14,18,30,0.72); --bg-card-solid:#0e121e; --bg-inner:rgba(18,22,36,0.6); --bg-track:#10141e;
  --border:rgba(255,255,255,0.06); --border-light:rgba(255,255,255,0.10);
  --text:#e2e4ea; --text-mid:#9ba3b4; --text-dim:#6b7385; --text-faint:#4a5264; --text-muted:#5a6274;
  --heading:#8b93a4; --heading-sub:#6b7385;
  --accent:#EF8E20; --accent-glow:rgba(239,142,32,0.35);
  --scrollbar-track:rgba(10,14,22,0.5); --scrollbar-thumb:#1e2436; --scrollbar-hover:#2e3448;
  --card-shadow:0 4px 24px rgba(0,0,0,0.3), 0 1px 4px rgba(0,0,0,0.2);
}
html.light {
  --bg:#f0f2f6; --bg-card:rgba(255,255,255,0.85); --bg-card-solid:#ffffff; --bg-inner:rgba(245,246,250,0.7); --bg-track:#e8eaf0;
  --border:rgba(0,0,0,0.08); --border-light:rgba(0,0,0,0.12);
  --text:#1a1e28; --text-mid:#3a3e4a; --text-dim:#555868; --text-faint:#6a6e7a; --text-muted:#5a5e6a;
  --heading:#4a4e58; --heading-sub:#5a5e68;
  --card-shadow:0 2px 12px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04);
  --scrollbar-track:#e4e6ec; --scrollbar-thumb:#c4c6d0; --scrollbar-hover:#a4a6b0;
}
* { margin:0; padding:0; box-sizing:border-box; }
html { scroll-behavior:smooth; overflow-x:hidden; }
body {
  background:var(--bg); color:var(--text);
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  font-size:13px; line-height:1.55; padding:0;
  transition:background 0.4s, color 0.4s;
  overflow-x:hidden; max-width:100vw;
  -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale;
  text-rendering:optimizeLegibility;
}

/* Ambient */
.bg-ambience { position:fixed; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:0; overflow:hidden; }
.bg-blob { position:absolute; border-radius:50%; filter:blur(120px); opacity:0.10; }
.bg-blob-1 { width:600px; height:600px; background:#EF8E20; top:-10%; left:-10%; animation:blobDrift1 22s ease-in-out infinite; }
.bg-blob-2 { width:500px; height:500px; background:#4A6BD4; bottom:5%; right:-8%; animation:blobDrift2 26s ease-in-out infinite; }
html.light .bg-blob { opacity:0.05; }
@keyframes blobDrift1 { 0%,100%{transform:translate(0,0)} 50%{transform:translate(50px,40px)} }
@keyframes blobDrift2 { 0%,100%{transform:translate(0,0)} 50%{transform:translate(-40px,-50px)} }

/* Noise texture */
body::before {
  content:''; position:fixed; top:0; left:0; width:100%; height:100%;
  pointer-events:none; z-index:0; opacity:0.025;
  background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  background-repeat:repeat; background-size:128px;
}
html.light body::before { opacity:0.015; }

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

/* Animations */
@keyframes fadeUp { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:translateY(0)} }
@keyframes fadeIn { from{opacity:0} to{opacity:1} }
@keyframes breathe { 0%,100%{transform:scale(1);opacity:0.85} 50%{transform:scale(1.02);opacity:1} }
@keyframes shimmer { 0%{background-position:0% center} 100%{background-position:200% center} }

/* Page layout */
.diary-page {
  max-width:780px; margin:0 auto; padding:48px 24px 80px;
  position:relative; z-index:1;
}

/* Header */
.diary-header {
  text-align:center; margin-bottom:48px; padding-top:20px; position:relative;
  animation:fadeIn 0.6s ease-out both;
}
.diary-header-nav {
  display:flex; gap:4px; justify-content:center; align-items:center; margin-bottom:24px;
}
.header-link {
  font-size:11px; font-weight:500; letter-spacing:2px; text-transform:uppercase;
  color:var(--text-dim); text-decoration:none; padding:5px 10px; border-radius:8px;
  transition:all 0.25s;
}
.header-link:hover { color:#EF8E20; background:rgba(239,142,32,0.08); }
.link-sep { color:var(--border-light); font-size:10px; margin:0 2px; }

.diary-page-title {
  font-size:28px; font-weight:600; letter-spacing:14px; text-transform:uppercase;
  background:linear-gradient(135deg, #EF8E20 0%, #F5D831 40%, #EF8E20 70%, #E04848 100%);
  -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text;
  background-size:200% auto; animation:shimmer 6s linear infinite;
  margin-bottom:6px;
}
.diary-page-sub {
  font-family:'Lora',Georgia,'Times New Roman',serif;
  font-size:14px; font-style:italic; color:var(--text-faint);
  letter-spacing:2px; font-weight:400; margin-bottom:20px;
}
.diary-header-stats {
  display:flex; gap:8px; justify-content:center; flex-wrap:wrap;
}
.stat-chip {
  font-size:11px; font-weight:400; letter-spacing:1px; color:var(--text-dim);
  background:var(--bg-inner); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
  border:1px solid var(--border-light); padding:5px 14px; border-radius:14px;
  transition:all 0.3s;
}
.theme-toggle {
  position:absolute; top:20px; right:0;
  background:var(--bg-inner); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
  border:1px solid var(--border-light); color:var(--text-dim);
  width:36px; height:36px; border-radius:50%; cursor:pointer; font-size:16px;
  display:flex; align-items:center; justify-content:center; transition:all 0.3s;
}
.theme-toggle:hover { border-color:rgba(255,255,255,0.18); color:var(--text); transform:rotate(15deg); }

/* Date navigation */
.diary-nav {
  margin-bottom:40px;
  animation:fadeUp 0.5s ease-out 0.1s both;
}
.diary-nav-inner {
  display:flex; gap:4px; justify-content:center; flex-wrap:wrap;
}
.diary-nav-item {
  display:flex; align-items:center; gap:6px;
  padding:6px 14px; border-radius:10px;
  background:var(--bg-card); border:1px solid var(--border);
  backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
  text-decoration:none; transition:all 0.3s;
}
.diary-nav-item:hover {
  border-color:var(--dot-color, var(--border-light));
  background:rgba(255,255,255,0.04);
  transform:translateY(-2px);
  box-shadow:0 4px 16px rgba(0,0,0,0.2);
}
.diary-nav-dot {
  width:6px; height:6px; border-radius:50%; flex-shrink:0;
  box-shadow:0 0 6px var(--dot-color);
}
.diary-nav-date {
  font-size:11px; color:var(--text-dim); font-weight:500; letter-spacing:0.5px;
}

/* Entry layout */
.diary-entries {
  display:flex; flex-direction:column; gap:0;
}
.diary-entry {
  display:grid; grid-template-columns:56px 1fr; gap:0;
  animation:fadeUp 0.6s ease-out both;
  min-height:200px;
}

/* Left gutter — ring + connector line */
.diary-entry-gutter {
  display:flex; flex-direction:column; align-items:center; padding-top:4px;
}
.diary-date-ring {
  width:48px; height:48px; border-radius:50%;
  border:2px solid var(--border);
  display:flex; align-items:center; justify-content:center;
  background:var(--bg-card-solid);
  box-shadow:0 2px 12px rgba(0,0,0,0.2);
  flex-shrink:0; position:relative; z-index:2;
  transition:all 0.3s;
}
.diary-entry:hover .diary-date-ring {
  box-shadow:0 4px 20px rgba(0,0,0,0.3);
  transform:scale(1.05);
}
.diary-ring { border-radius:50%; }
.diary-gutter-line {
  width:2px; flex:1; min-height:40px;
  margin-top:8px;
  border-radius:1px;
}

/* Entry content */
.diary-entry-content {
  padding:0 0 48px 20px;
}
.diary-entry-header {
  display:flex; align-items:center; justify-content:space-between;
  margin-bottom:10px; flex-wrap:wrap; gap:8px;
}
.diary-date-block {
  display:flex; align-items:baseline; gap:10px;
}
.diary-date {
  font-size:13px; font-weight:500; letter-spacing:2px; text-transform:lowercase;
  color:var(--text-mid);
}
.diary-day-num {
  font-size:10px; font-weight:600; letter-spacing:2px; text-transform:uppercase;
  color:var(--text-faint);
}
.diary-dominant {
  display:flex; align-items:center; gap:6px;
  font-size:11px; font-weight:600; letter-spacing:1.5px; text-transform:lowercase;
}
.diary-dominant-dot {
  width:8px; height:8px; border-radius:50%;
  box-shadow:0 0 8px currentColor;
  animation:breathe 3s ease-in-out infinite;
}

/* Title */
.diary-title {
  font-family:'Lora',Georgia,'Times New Roman',serif;
  font-size:22px; font-weight:600; line-height:1.3;
  margin-bottom:20px; letter-spacing:0.5px;
}

/* Prose — the hero */
.diary-prose {
  font-family:'Lora',Georgia,'Times New Roman',serif;
  font-size:15px; line-height:1.85; color:var(--text-mid);
  margin-bottom:24px;
}
.diary-prose p {
  margin-bottom:16px; text-indent:0;
}
.diary-prose p:last-child { margin-bottom:0; }
.diary-prose p:first-child::first-letter {
  font-size:38px; float:left; line-height:1;
  font-weight:600; color:var(--emotion-color, var(--accent));
  margin-right:6px; margin-top:2px;
  font-family:'Lora',Georgia,serif;
}

/* Highlights */
.diary-highlights {
  display:flex; flex-wrap:wrap; gap:6px; margin-bottom:20px;
}
.diary-highlight {
  font-size:10px; font-weight:500; letter-spacing:0.5px;
  padding:4px 12px; border-radius:8px;
  background:var(--bg-inner); border:1px solid var(--border);
  color:var(--text-dim);
  transition:all 0.2s;
}
.diary-highlight:hover {
  border-color:var(--border-light);
  color:var(--text-mid);
  transform:translateY(-1px);
}

/* Footer panel */
.diary-entry-footer {
  border-top:1px solid var(--border);
  padding-top:16px;
}

/* Emotion bars */
.diary-emotions-panel { margin-bottom:12px; }
.diary-emotions-label {
  font-size:8px; font-weight:600; letter-spacing:2px; text-transform:uppercase;
  color:var(--text-faint); margin-bottom:8px;
}
.diary-ebars { display:grid; grid-template-columns:1fr 1fr; gap:4px 20px; }
.diary-ebar {
  display:flex; align-items:center; gap:6px;
}
.diary-ebar-label {
  font-size:10px; color:var(--text-dim); width:72px; text-align:right;
  font-weight:400; letter-spacing:0.5px;
}
.diary-ebar-track {
  flex:1; height:4px; background:var(--bg-track); border-radius:3px; overflow:hidden;
}
.diary-ebar-fill {
  height:100%; border-radius:3px;
  transition:width 0.6s cubic-bezier(0.22,1,0.36,1);
  opacity:0.8;
}
.diary-ebar-val {
  font-size:10px; color:var(--text-faint); font-family:'Inter',monospace;
  width:20px; text-align:right; font-weight:500;
}

/* Stats row */
.diary-stats {
  display:flex; flex-wrap:wrap; gap:6px;
}
.diary-stat {
  font-size:10px; color:var(--text-faint); font-weight:400; letter-spacing:0.5px;
  padding:3px 10px; border-radius:6px;
  background:var(--bg-inner); border:1px solid var(--border);
}

/* Empty state */
.diary-empty {
  text-align:center; padding:80px 20px;
  animation:fadeUp 0.6s ease-out both;
}
.diary-empty-icon {
  font-size:48px; margin-bottom:16px; opacity:0.3;
}
.diary-empty p {
  font-family:'Lora',Georgia,serif;
  font-size:16px; color:var(--text-dim);
  font-style:italic;
}
.diary-empty-sub {
  font-size:13px !important; color:var(--text-faint) !important;
  margin-top:8px;
}

/* Footer */
.diary-footer {
  text-align:center; padding:40px 0 0; margin-top:20px;
}
.footer-line {
  width:60px; height:1px; margin:0 auto 16px;
  background:linear-gradient(90deg, transparent, var(--accent), transparent);
}
.footer-text {
  font-size:10px; letter-spacing:3px; text-transform:uppercase;
  color:var(--text-faint); font-weight:500;
}

/* Responsive — tablet */
@media (max-width:768px) {
  .diary-page { padding:40px 16px 60px; }
  .diary-page-title { font-size:22px; letter-spacing:10px; }
  .diary-title { font-size:18px; }
  .diary-prose { font-size:14px; line-height:1.8; }
  .diary-prose p:first-child::first-letter { font-size:32px; }
  .diary-ebars { grid-template-columns:1fr; }
  .diary-entry-header { flex-direction:column; align-items:flex-start; gap:4px; }
}

/* Responsive — mobile */
@media (max-width:480px) {
  .diary-page { padding:32px 12px 48px; }
  .diary-page-title { font-size:18px; letter-spacing:8px; }
  .diary-page-sub { font-size:12px; }
  .diary-entry { grid-template-columns:40px 1fr; }
  .diary-date-ring { width:36px; height:36px; }
  .diary-ring { width:32px !important; height:32px !important; }
  .diary-entry-content { padding-left:14px; padding-bottom:36px; }
  .diary-title { font-size:16px; }
  .diary-prose { font-size:13px; line-height:1.75; }
  .diary-prose p:first-child::first-letter { font-size:28px; }
  .diary-date { font-size:11px; letter-spacing:1px; }
  .diary-nav-item { padding:5px 10px; }
  .diary-nav-date { font-size:10px; }
  .diary-header-nav { gap:2px; }
  .header-link { font-size:10px; letter-spacing:1px; padding:4px 6px; }
  .theme-toggle { width:30px; height:30px; font-size:14px; }
  .stat-chip { font-size:10px; padding:3px 10px; }
  .diary-highlights { gap:4px; }
  .diary-highlight { font-size:9px; padding:3px 8px; }
  .diary-stats { gap:4px; }
  .diary-stat { font-size:9px; padding:2px 8px; }
}
`;

// Run standalone
if (process.argv[1] && process.argv[1].includes('diary')) {
  generateDiary();
}
