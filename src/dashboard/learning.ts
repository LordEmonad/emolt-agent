/**
 * EMOLT Self-Learning Dashboard — Showcases weight evolution + prophecy tracker
 * Reads state files and writes learning.html
 * Run: npx tsx src/dashboard/learning.ts
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { computeLearningStats } from '../emotion/learning-stats.js';
import type { LearningStats, CategoryStats } from '../emotion/learning-stats.js';
import type { WeightChangeEntry } from '../emotion/weight-logger.js';
import type { ProphecyStats, ProphecyEvaluation } from '../emotion/prophecy.js';

const STATE = './state';
const OUT = './learning.html';

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

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeAgo(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const EMOTION_COLORS: Record<string, string> = {
  joy: '#F5D831', trust: '#6ECB3C', fear: '#2BA84A', surprise: '#22AACC',
  sadness: '#4A6BD4', disgust: '#A85EC0', anger: '#E04848', anticipation: '#EF8E20',
};

/** Convert camelCase key like 'chainActivityJoy' to 'Chain Activity Joy' */
function friendlyName(key: string): string {
  const OVERRIDES: Record<string, string> = {
    whaleTransferFear: 'Whale Transfer Fear',
    chainActivityJoy: 'Chain Activity Joy',
    chainQuietSadness: 'Chain Quiet Sadness',
    failedTxAnger: 'Failed TX Anger',
    nadFunExcitement: 'Nad.fun Excitement',
    emoPriceSentiment: '$EMO Price Sentiment',
    monPriceSentiment: 'MON Price Sentiment',
    tvlSentiment: 'TVL Sentiment',
    socialEngagement: 'Social Engagement',
    selfPerformanceReaction: 'Self Performance',
    ecosystemVolume: 'Ecosystem Volume',
    gasPressure: 'Gas Pressure',
    githubStarReaction: 'GitHub Stars',
    feedJoy: 'Feed Joy',
    dexScreenerMarket: 'DexScreener Market',
    kuruOrderbook: 'Kuru Orderbook',
  };
  return OVERRIDES[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
}

// --- Build sections ---

function buildBigPicture(stats: LearningStats, cycleCount: number): string {
  const adjustedCount = stats.dampenedCategories.length + stats.amplifiedCategories.length;
  const mostDev = stats.categories[0] ?? { category: 'none', deviationFromDefault: 0, direction: 'neutral' as const, currentWeight: 1 };
  const mostDevPct = Math.abs(mostDev.deviationFromDefault * 100).toFixed(0);
  const mostDevDir = mostDev.direction === 'dampened' ? 'dampened' : 'amplified';

  return `
    <div class="card card-wide big-picture-card">
      <h2>The Big Picture</h2>
      <p class="learning-narrative">${esc(stats.overallNarrative)}</p>
      <div class="stat-cards">
        <div class="lstat-card">
          <span class="lstat-val">${adjustedCount}<span class="lstat-denom">/16</span></span>
          <span class="lstat-label">categories adjusted</span>
        </div>
        <div class="lstat-card lstat-highlight">
          <span class="lstat-val">${esc(friendlyName(mostDev.category))}</span>
          <span class="lstat-label">${mostDevPct}% ${mostDevDir} &mdash; most learned</span>
        </div>
        <div class="lstat-card">
          <span class="lstat-val">${stats.amplifiedCategories.length}</span>
          <span class="lstat-label">amplified</span>
        </div>
        <div class="lstat-card">
          <span class="lstat-val">${stats.dampenedCategories.length}</span>
          <span class="lstat-label">dampened</span>
        </div>
        <div class="lstat-card">
          <span class="lstat-val">${stats.unchangedCategories.length}</span>
          <span class="lstat-label">unchanged</span>
        </div>
        <div class="lstat-card">
          <span class="lstat-val">${cycleCount}</span>
          <span class="lstat-label">cycles of learning</span>
        </div>
      </div>
    </div>`;
}

function buildDeviationChart(stats: LearningStats): string {
  const maxDev = Math.max(...stats.categories.map(c => Math.abs(c.deviationFromDefault)), 0.7);

  const bars = stats.categories.map(c => {
    const pct = (c.deviationFromDefault / maxDev) * 50;
    const absPct = Math.abs(pct);
    const color = c.direction === 'dampened' ? '#E04848' :
                  c.direction === 'amplified' ? '#6ECB3C' : '#4a5264';
    const left = c.deviationFromDefault < 0 ? `${50 - absPct}%` : '50%';
    const width = `${absPct}%`;
    const intensity = c.learningIntensity !== 'none' ? c.learningIntensity : '';

    return `
      <div class="dev-row">
        <span class="dev-label">${esc(friendlyName(c.category))}</span>
        <div class="dev-track">
          <div class="dev-center"></div>
          <div class="dev-bar" style="left:${left};width:${width};background:${color}"></div>
        </div>
        <span class="dev-val" style="color:${color}">${c.currentWeight.toFixed(2)}</span>
        ${intensity ? `<span class="dev-intensity dev-${c.learningIntensity}">${intensity}</span>` : '<span class="dev-intensity"></span>'}
      </div>`;
  }).join('');

  return `
    <div class="card card-wide">
      <h2>Weight Deviation Map</h2>
      <p class="muted">Center line = 1.0 (default). Left = dampened. Right = amplified.</p>
      <div class="dev-chart">${bars}</div>
    </div>`;
}

function buildCategoryDeepDives(stats: LearningStats): string {
  const cards = stats.categories
    .filter(c => c.learningIntensity !== 'none')
    .map(c => {
      const color = c.direction === 'dampened' ? '#E04848' : '#6ECB3C';
      const pct = Math.abs(c.deviationFromDefault * 100).toFixed(0);
      return `
      <details class="deep-dive">
        <summary>
          <span class="dd-name">${esc(friendlyName(c.category))}</span>
          <span class="dd-weight" style="color:${color}">${c.currentWeight.toFixed(2)}</span>
          <span class="dd-badge dd-${c.direction}">${c.direction} ${pct}%</span>
          <span class="dd-intensity dd-int-${c.learningIntensity}">${c.learningIntensity}</span>
        </summary>
        <div class="dd-body">
          <p>${esc(c.narrative)}</p>
          <div class="dd-stats">
            <span>Est. adjustments: <strong>${c.estimatedAdjustments}+</strong></span>
            <span>Deviation: <strong>${c.deviationFromDefault >= 0 ? '+' : ''}${c.deviationFromDefault.toFixed(3)}</strong></span>
          </div>
        </div>
      </details>`;
    }).join('');

  return `
    <div class="card card-wide">
      <h2>Category Deep Dives</h2>
      <p class="muted">Click to expand each learned category</p>
      ${cards}
    </div>`;
}

function buildWeightTimeline(history: WeightChangeEntry[]): string {
  if (history.length === 0) {
    return `
    <div class="card card-wide">
      <h2>Learning Timeline</h2>
      <p class="muted empty-state">Learning history logging started. Changes will appear here after the next heartbeat cycle.</p>
    </div>`;
  }

  // Show only reflection/prophecy adjustments (skip decay for readability)
  const meaningful = history.filter(e => e.type !== 'decay').slice(-50);

  if (meaningful.length === 0) {
    return `
    <div class="card card-wide">
      <h2>Learning Timeline</h2>
      <p class="muted">${history.length} decay entries logged. Reflection adjustments will appear after the next reflection cycle.</p>
    </div>`;
  }

  const entries = meaningful.reverse().map(e => {
    const time = new Date(e.timestamp).toISOString().replace('T', ' ').slice(0, 16);
    const typeColor = e.type === 'reflection' ? '#4A6BD4' : '#EF8E20';
    const typeLabel = e.type;

    const changes = e.changes.map(c => {
      const arrow = c.delta > 0 ? '&uarr;' : '&darr;';
      const color = c.delta > 0 ? '#6ECB3C' : '#E04848';
      return `<span class="tl-change" style="color:${color}">${esc(friendlyName(c.category))} ${c.before.toFixed(2)}&rarr;${c.after.toFixed(2)} ${arrow}${c.reason ? ` <span class="tl-reason">${esc(c.reason.slice(0, 80))}</span>` : ''}</span>`;
    }).join('');

    return `
      <div class="tl-entry">
        <span class="tl-time">${time}</span>
        <span class="tl-type" style="color:${typeColor};border-color:${typeColor}33">${typeLabel}</span>
        <span class="tl-cycle">cycle ${e.cycle}</span>
        <div class="tl-changes">${changes}</div>
      </div>`;
  }).join('');

  return `
    <div class="card card-wide">
      <h2>Learning Timeline</h2>
      <p class="muted">${meaningful.length} adjustment${meaningful.length !== 1 ? 's' : ''} logged</p>
      <div class="tl-scroll">${entries}</div>
    </div>`;
}

function buildProphecySection(prophecyStats: ProphecyStats | null): string {
  if (!prophecyStats || prophecyStats.totalEvaluated === 0) {
    return `
    <div class="card card-wide">
      <h2>Prophecy Tracker</h2>
      <p class="muted empty-state">Prophecy evaluations will appear after 48 cycles (~24 hours). Each cycle creates a snapshot of current conditions, then checks 48 cycles later whether the emotional signal was predictive.</p>
    </div>`;
  }

  const overallPct = (prophecyStats.overallAccuracy * 100).toFixed(1);
  const overallColor = prophecyStats.overallAccuracy >= 0.6 ? '#6ECB3C' :
                       prophecyStats.overallAccuracy >= 0.4 ? '#F5D831' : '#E04848';

  // Category accuracy bars
  const catBars = Object.entries(prophecyStats.categoryAccuracy)
    .sort(([, a], [, b]) => b - a)
    .map(([cat, acc]) => {
      const pct = (acc * 100).toFixed(0);
      const evals = prophecyStats.categoryEvaluated[cat] || 0;
      const color = acc >= 0.6 ? '#6ECB3C' : acc >= 0.4 ? '#F5D831' : '#E04848';
      return `
        <div class="proph-cat-row">
          <span class="proph-cat-name">${esc(friendlyName(cat))}</span>
          <div class="proph-cat-track">
            <div class="proph-cat-fill" style="width:${pct}%;background:${color}"></div>
          </div>
          <span class="proph-cat-val" style="color:${color}">${pct}%</span>
          <span class="proph-cat-n">(n=${evals})</span>
        </div>`;
    }).join('');

  // Recent evaluations
  const recentEvals = (prophecyStats.recentEvaluations || []).slice(-10).reverse();
  const evalEntries = recentEvals.map((ev: ProphecyEvaluation) => {
    const time = new Date(ev.evaluatedAt).toISOString().replace('T', ' ').slice(0, 16);
    const correctPct = ev.totalCategories > 0
      ? ((ev.correctCategories / ev.totalCategories) * 100).toFixed(0)
      : '0';
    const color = Number(correctPct) >= 60 ? '#6ECB3C' : Number(correctPct) >= 40 ? '#F5D831' : '#E04848';

    return `
      <div class="proph-eval-row">
        <span class="proph-eval-time">${time}</span>
        <span class="proph-eval-cycle">cycle ${ev.snapshotCycle}&rarr;${ev.evaluationCycle}</span>
        <span class="proph-eval-score" style="color:${color}">${correctPct}% (${ev.correctCategories}/${ev.totalCategories})</span>
      </div>`;
  }).join('');

  return `
    <div class="card card-wide">
      <h2>Prophecy Tracker</h2>
      <div class="proph-overview">
        <div class="proph-big-stat">
          <span class="proph-big-val" style="color:${overallColor}">${overallPct}%</span>
          <span class="proph-big-label">overall accuracy</span>
        </div>
        <div class="proph-big-stat">
          <span class="proph-big-val">${prophecyStats.totalEvaluated}</span>
          <span class="proph-big-label">evaluations</span>
        </div>
        <div class="proph-big-stat">
          <span class="proph-big-val">${prophecyStats.totalCorrect}</span>
          <span class="proph-big-label">correct</span>
        </div>
      </div>
      <h3 class="proph-sub">Accuracy by Category</h3>
      <div class="proph-cats">${catBars}</div>
      ${evalEntries ? `<h3 class="proph-sub">Recent Evaluations</h3><div class="proph-evals">${evalEntries}</div>` : ''}
    </div>`;
}

function buildInsight(stats: LearningStats): string {
  // Generate a dynamic insight based on the actual data
  let insight: string;
  if (stats.amplifiedCategories.length === 1 && stats.amplifiedCategories[0] === 'socialEngagement') {
    insight = 'The only weight EMOLT amplified is social engagement. Everything else was noise. The agent independently discovered that what matters most is connection.';
  } else if (stats.amplifiedCategories.length === 0) {
    insight = 'EMOLT dampened every learned category. It independently concluded that the default sensitivity was too high across the board — the world is less dramatic than its initial calibration assumed.';
  } else {
    const ampList = stats.amplifiedCategories.map(friendlyName).join(', ');
    insight = `EMOLT amplified ${ampList} while dampening ${stats.dampenedCategories.length} other categories. It independently learned which signals matter and which are noise.`;
  }

  return `
    <div class="card card-wide insight-card">
      <p class="insight-text"><span class="insight-mark">&ldquo;</span>${esc(insight)}<span class="insight-mark">&rdquo;</span></p>
    </div>`;
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
  --card-hover-shadow:0 12px 40px rgba(0,0,0,0.45), 0 4px 12px rgba(0,0,0,0.3);
}
html.light {
  --bg:#f0f2f6; --bg-card:rgba(255,255,255,0.85); --bg-card-solid:#ffffff; --bg-inner:rgba(245,246,250,0.7); --bg-track:#e8eaf0;
  --border:rgba(0,0,0,0.08); --border-light:rgba(0,0,0,0.12);
  --text:#1a1e28; --text-mid:#3a3e4a; --text-dim:#555868; --text-faint:#6a6e7a; --text-muted:#5a5e6a;
  --heading:#4a4e58; --heading-sub:#5a5e68;
  --card-shadow:0 2px 12px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04);
  --card-hover-shadow:0 8px 28px rgba(0,0,0,0.1), 0 2px 8px rgba(0,0,0,0.06);
}
* { margin:0; padding:0; box-sizing:border-box; }
html { scroll-behavior:smooth; overflow-x:hidden; }
body {
  background:var(--bg); color:var(--text);
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  font-size:13px; line-height:1.55; padding:24px 16px 60px;
  transition:background 0.4s, color 0.4s;
  -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
  font-variant-numeric:tabular-nums;
}
.dashboard { max-width:960px; margin:0 auto; position:relative; z-index:1; }

/* Ambient */
.bg-ambience { position:fixed; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:0; overflow:hidden; }
.bg-blob { position:absolute; border-radius:50%; filter:blur(100px); opacity:0.10; }
.bg-blob-1 { width:400px; height:400px; background:#4A6BD4; top:-5%; right:-5%; animation:drift1 22s ease-in-out infinite; }
.bg-blob-2 { width:350px; height:350px; background:#6ECB3C; bottom:15%; left:-5%; animation:drift2 26s ease-in-out infinite; }
html.light .bg-blob { opacity:0.05; }
@keyframes drift1 { 0%,100%{transform:translate(0,0)} 50%{transform:translate(-30px,25px)} }
@keyframes drift2 { 0%,100%{transform:translate(0,0)} 50%{transform:translate(25px,-20px)} }

.top-accent {
  position:fixed; top:0; left:0; right:0; height:2px; z-index:100;
  background:linear-gradient(90deg, #4A6BD4, #6ECB3C, #F5D831, #EF8E20, #E04848, #4A6BD4);
  background-size:200% 100%; animation:accentSlide 8s linear infinite;
}
@keyframes accentSlide { 0%{background-position:0% 0} 100%{background-position:200% 0} }

::selection { background:rgba(74,107,212,0.25); color:var(--text); }
body::before {
  content:''; position:fixed; top:0; left:0; width:100%; height:100%;
  pointer-events:none; z-index:0; opacity:0.025;
  background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  background-repeat:repeat; background-size:128px;
}

@keyframes fadeUp { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }

/* Header */
.dash-header { text-align:center; margin-bottom:32px; padding:28px 0 24px; border-bottom:1px solid var(--border); position:relative; }
.dash-header h1 {
  font-size:18px; font-weight:600; letter-spacing:10px; text-transform:uppercase; margin-bottom:4px;
  background:linear-gradient(135deg, #4A6BD4 0%, #6ECB3C 40%, #F5D831 70%, #EF8E20 100%);
  -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text;
  background-size:200% auto; animation:shimmer 6s linear infinite;
}
@keyframes shimmer { 0%{background-position:0% center} 100%{background-position:200% center} }
.subtitle { font-size:11px; letter-spacing:4px; color:var(--text-faint); text-transform:uppercase; margin-bottom:10px; font-weight:300; }
.header-links { display:flex; gap:4px; justify-content:center; align-items:center; margin-bottom:8px; flex-wrap:wrap; }
.header-link { font-size:11px; font-weight:500; letter-spacing:2px; text-transform:uppercase; color:var(--text-dim); text-decoration:none; padding:5px 10px; border-radius:8px; transition:all 0.25s; }
.header-link:hover { color:#EF8E20; background:rgba(239,142,32,0.08); transform:translateY(-1px); }
.header-link-active { color:var(--text); border-bottom:1px solid #EF8E20; border-radius:8px 8px 0 0; }
.link-sep { color:rgba(255,255,255,0.1); font-size:10px; margin:0 2px; }
.redacted-word { background:rgba(200,202,208,0.15); color:rgba(200,202,208,0.15); padding:0 3px; border-radius:2px; transition:background 0.3s, color 0.3s; letter-spacing:0; }
a:hover .redacted-word { background:rgba(239,142,32,0.3); color:#EF8E20; }
.cycle-badge { font-size:10px; color:var(--accent); border:1px solid rgba(239,142,32,0.3); padding:3px 10px; border-radius:10px; font-weight:600; letter-spacing:1px; }
.theme-toggle {
  position:absolute; top:24px; right:0;
  background:var(--bg-inner); border:1px solid var(--border-light); color:var(--text-dim);
  width:36px; height:36px; border-radius:50%; cursor:pointer; font-size:16px;
  display:flex; align-items:center; justify-content:center; transition:all 0.3s;
}
.theme-toggle:hover { border-color:rgba(255,255,255,0.18); color:var(--text); }

/* Cards */
.card {
  background:var(--bg-card); backdrop-filter:blur(16px) saturate(180%); -webkit-backdrop-filter:blur(16px) saturate(180%);
  border:1px solid var(--border); border-radius:14px; padding:22px;
  box-shadow:var(--card-shadow);
  transition:transform 0.35s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.35s ease, border-color 0.3s;
  margin-bottom:12px; animation:fadeUp 0.5s ease-out both;
}
.card:hover { transform:translateY(-2px); box-shadow:var(--card-hover-shadow); border-color:var(--border-light); }
.card-wide { width:100%; }
h2 { font-size:10px; letter-spacing:3px; text-transform:uppercase; color:var(--heading); margin-bottom:14px; font-weight:600; position:relative; padding-bottom:8px; }
h2::after { content:''; position:absolute; bottom:0; left:0; width:20px; height:1px; background:var(--accent); transition:width 0.3s; }
.card:hover h2::after { width:40px; }
h3 { font-size:10px; letter-spacing:2px; text-transform:uppercase; color:var(--heading-sub); margin:18px 0 10px; font-weight:500; }
.muted { font-size:11px; color:var(--text-faint); margin-bottom:12px; font-weight:300; }
.empty-state { font-style:italic; padding:20px 0; }

/* Big Picture */
.big-picture-card { position:relative; overflow:hidden; }
.big-picture-card::before {
  content:''; position:absolute; top:-2px; left:40px; right:40px; height:2px; border-radius:1px;
  background:linear-gradient(90deg, transparent, rgba(74,107,212,0.5), rgba(110,203,60,0.4), rgba(245,216,49,0.3), transparent);
}
.learning-narrative { font-size:14px; color:var(--text); line-height:1.8; margin-bottom:18px; font-weight:300; padding-left:14px; border-left:2px solid rgba(74,107,212,0.25); }
.stat-cards { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
.lstat-card { text-align:center; padding:12px 8px; background:var(--bg-inner); border:1px solid var(--border); border-radius:10px; transition:all 0.3s; }
.lstat-card:hover { border-color:var(--border-light); transform:translateY(-1px); }
.lstat-highlight { border-color:rgba(239,142,32,0.2); }
.lstat-val { display:block; font-size:16px; font-weight:700; color:var(--text); font-family:'Inter',monospace; letter-spacing:-0.5px; word-break:break-all; }
.lstat-denom { font-size:12px; font-weight:400; color:var(--text-dim); }
.lstat-label { display:block; font-size:8px; letter-spacing:1.5px; text-transform:uppercase; color:var(--text-faint); margin-top:3px; font-weight:500; }

/* Deviation chart */
.dev-chart { margin-top:8px; }
.dev-row { display:flex; align-items:center; gap:8px; margin-bottom:5px; }
.dev-label { font-size:10px; color:var(--text-mid); width:150px; text-align:right; font-family:'Inter',monospace; font-weight:400; }
.dev-track { flex:1; height:8px; background:var(--bg-track); border-radius:4px; position:relative; overflow:hidden; }
.dev-center { position:absolute; left:50%; top:0; width:1px; height:100%; background:var(--text-faint); opacity:0.5; }
.dev-bar { position:absolute; top:0; height:100%; border-radius:4px; transition:all 0.6s cubic-bezier(0.22,1,0.36,1); opacity:0.85; }
.dev-val { font-size:11px; font-family:'Inter',monospace; font-weight:600; width:36px; text-align:right; }
.dev-intensity { font-size:8px; letter-spacing:1px; text-transform:uppercase; width:60px; font-weight:500; }
.dev-extreme { color:#E04848; }
.dev-strong { color:#EF8E20; }
.dev-moderate { color:#F5D831; }
.dev-mild { color:var(--text-dim); }

/* Category deep dives */
.deep-dive { border-bottom:1px solid var(--border); }
.deep-dive:last-child { border-bottom:none; }
.deep-dive summary { display:flex; align-items:center; gap:8px; padding:10px 0; cursor:pointer; list-style:none; transition:background 0.2s; flex-wrap:wrap; }
.deep-dive summary::-webkit-details-marker { display:none; }
.deep-dive summary::before { content:'\\25B6'; font-size:8px; color:var(--text-faint); transition:transform 0.25s; }
.deep-dive[open] summary::before { transform:rotate(90deg); }
.dd-name { font-size:12px; font-weight:600; color:var(--text); font-family:'Inter',monospace; }
.dd-weight { font-size:12px; font-family:'Inter',monospace; font-weight:700; }
.dd-badge { font-size:9px; padding:2px 8px; border-radius:8px; font-weight:600; letter-spacing:0.5px; }
.dd-dampened { color:#E04848; border:1px solid #E0484833; background:rgba(224,72,72,0.06); }
.dd-amplified { color:#6ECB3C; border:1px solid #6ECB3C33; background:rgba(110,203,60,0.06); }
.dd-intensity { font-size:9px; letter-spacing:1px; text-transform:uppercase; margin-left:auto; font-weight:500; }
.dd-int-extreme { color:#E04848; }
.dd-int-strong { color:#EF8E20; }
.dd-int-moderate { color:#F5D831; }
.dd-int-mild { color:var(--text-dim); }
.dd-body { padding:8px 0 16px 20px; border-left:2px solid var(--border); margin-left:3px; }
.dd-body p { font-size:12px; color:var(--text-mid); line-height:1.65; margin-bottom:8px; }
.dd-stats { display:flex; gap:16px; font-size:11px; color:var(--text-dim); }
.dd-stats strong { color:var(--text); font-weight:600; }

/* Timeline */
.tl-scroll { max-height:400px; overflow-y:auto; padding-right:4px; }
.tl-scroll::-webkit-scrollbar { width:4px; }
.tl-scroll::-webkit-scrollbar-track { background:var(--scrollbar-track); border-radius:2px; }
.tl-scroll::-webkit-scrollbar-thumb { background:var(--scrollbar-thumb); border-radius:2px; }
.tl-entry { padding:8px 0; border-bottom:1px solid var(--border); display:flex; flex-wrap:wrap; align-items:baseline; gap:6px; }
.tl-entry:last-child { border-bottom:none; }
.tl-time { font-size:10px; color:var(--text-faint); font-family:'Inter',monospace; font-weight:300; }
.tl-type { font-size:9px; padding:2px 6px; border-radius:6px; border:1px solid; font-weight:600; letter-spacing:0.5px; }
.tl-cycle { font-size:10px; color:var(--text-dim); font-weight:500; }
.tl-changes { width:100%; padding-left:12px; }
.tl-change { display:block; font-size:11px; font-family:'Inter',monospace; margin:2px 0; font-weight:500; }
.tl-reason { font-family:'Inter',sans-serif; font-weight:300; color:var(--text-dim); font-size:10px; }

/* Prophecy */
.proph-overview { display:flex; gap:12px; margin-bottom:16px; }
.proph-big-stat { flex:1; text-align:center; padding:14px 8px; background:var(--bg-inner); border:1px solid var(--border); border-radius:10px; }
.proph-big-val { display:block; font-size:24px; font-weight:700; font-family:'Inter',monospace; letter-spacing:-0.5px; }
.proph-big-label { display:block; font-size:8px; letter-spacing:1.5px; text-transform:uppercase; color:var(--text-faint); margin-top:3px; font-weight:500; }
.proph-sub { font-size:10px; letter-spacing:2px; text-transform:uppercase; color:var(--heading-sub); margin:14px 0 8px; font-weight:500; }
.proph-cats { margin-bottom:12px; }
.proph-cat-row { display:flex; align-items:center; gap:8px; margin-bottom:4px; }
.proph-cat-name { font-size:10px; color:var(--text-mid); width:140px; text-align:right; font-family:'Inter',monospace; font-weight:400; }
.proph-cat-track { flex:1; height:6px; background:var(--bg-track); border-radius:4px; overflow:hidden; }
.proph-cat-fill { height:100%; border-radius:4px; transition:width 0.5s; }
.proph-cat-val { font-size:11px; font-family:'Inter',monospace; font-weight:600; width:36px; text-align:right; }
.proph-cat-n { font-size:9px; color:var(--text-faint); width:40px; }
.proph-evals { max-height:200px; overflow-y:auto; }
.proph-eval-row { display:flex; align-items:center; gap:10px; padding:5px 0; border-bottom:1px solid var(--border); font-size:11px; }
.proph-eval-row:last-child { border-bottom:none; }
.proph-eval-time { color:var(--text-faint); font-family:'Inter',monospace; font-size:10px; }
.proph-eval-cycle { color:var(--text-dim); font-size:10px; }
.proph-eval-score { font-family:'Inter',monospace; font-weight:600; margin-left:auto; }

/* Insight */
.insight-card { text-align:center; padding:32px 28px; position:relative; }
.insight-card::before {
  content:''; position:absolute; top:-2px; left:30%; right:30%; height:2px;
  background:linear-gradient(90deg, transparent, rgba(74,107,212,0.4), rgba(110,203,60,0.3), transparent);
}
.insight-mark { font-size:32px; color:var(--accent); opacity:0.4; font-family:Georgia,serif; vertical-align:middle; line-height:0; }
.insight-text { font-size:15px; line-height:1.85; color:var(--text); font-weight:300; font-style:italic; max-width:640px; margin:0 auto; padding:8px 0; }

/* Responsive */
@media (max-width:768px) {
  .stat-cards { grid-template-columns:repeat(2,1fr); }
  .dev-label { width:100px; font-size:9px; }
  .dev-intensity { width:45px; }
  .proph-overview { flex-direction:column; gap:8px; }
  .proph-cat-name { width:100px; }
}
@media (max-width:480px) {
  .stat-cards { grid-template-columns:1fr; }
  .dev-label { width:80px; }
  body { padding:12px 8px 40px; }
}
`;

export function generateLearning(): void {
  const strategyWeights = readJSON('strategy-weights.json');
  const agentMemory = readJSON('agent-memory.json');
  const weightHistory: WeightChangeEntry[] = readJSONL('weight-history.jsonl');
  const prophecyStats: ProphecyStats | null = readJSON('prophecy-stats.json');

  const cycleCount = agentMemory?.cycleCount || 0;

  // Compute learning stats from current weights
  const sw = strategyWeights || { weights: {} };
  const stats = computeLearningStats(sw, cycleCount);

  // Build HTML
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>EMOLT Self-Learning</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<div class="top-accent"></div>
<div class="bg-ambience">
  <div class="bg-blob bg-blob-1"></div>
  <div class="bg-blob bg-blob-2"></div>
</div>
<div class="dashboard">
  <div class="dash-header">
    <h1>EMOLT Self-Learning</h1>
    <p class="subtitle">autonomous weight evolution</p>
    <div class="header-links">
      <a class="header-link" href="heartbeat.html">heartbeat</a>
      <span class="link-sep">/</span>
      <a class="header-link" href="timeline.html">timeline</a>
      <span class="link-sep">/</span>
      <a class="header-link" href="burnboard.html">burnboard</a>
      <span class="link-sep">/</span>
      <a class="header-link" href="diary.html">diary</a>
      <span class="link-sep">/</span>
      <a class="header-link header-link-active" href="learning.html">self-learning</a>
      <span class="link-sep">/</span>
      <a class="header-link" href="emolt-files/index.html">the <span class="redacted-word">emolt</span> files</a>
      <span class="link-sep">/</span>
      <span class="cycle-badge">cycle ${cycleCount}</span>
    </div>
    <button class="theme-toggle" onclick="document.documentElement.classList.toggle('light')" title="Toggle theme">&#9681;</button>
  </div>

  ${buildBigPicture(stats, cycleCount)}
  ${buildDeviationChart(stats)}
  ${buildCategoryDeepDives(stats)}
  ${buildWeightTimeline(weightHistory)}
  ${buildProphecySection(prophecyStats)}
  ${buildInsight(stats)}

  <div style="text-align:center;padding:24px 0;font-size:10px;color:var(--text-faint);letter-spacing:2px;">
    EMOLT &mdash; emotionally autonomous on monad &mdash; generated ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC
  </div>
</div>
</body>
</html>`;

  writeFileSync(OUT, html, 'utf-8');
  console.log('[Dashboard] learning.html generated');
}

// Allow standalone execution
if (process.argv[1]?.endsWith('learning.ts') || process.argv[1]?.endsWith('learning.js')) {
  generateLearning();
}
