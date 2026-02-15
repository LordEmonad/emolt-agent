/**
 * EMOLT Heartbeat Dashboard Generator
 * Standalone script - reads all ./state/ files and writes heartbeat.html
 * Run: npx tsx src/dashboard/generate.ts
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { privateKeyToAccount } from 'viem/accounts';

// --- State file paths ---
const STATE = './state';
const OUT = './heartbeat.html';

// --- External links ---
const MOLTBOOK_URL = 'https://www.moltbook.com';
const GITHUB_URL = 'https://github.com/LordEmonad/emolt-agent';


function loadEnvVar(key: string): string {
  // Try process.env first (when called from heartbeat loop)
  if (process.env[key]) return process.env[key]!;
  // Fall back to reading .env file (standalone mode)
  try {
    const env = readFileSync('.env', 'utf-8');
    const match = env.match(new RegExp(`^${key}=(.+)$`, 'm'));
    return match?.[1]?.trim() || '';
  } catch { return ''; }
}

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

// Data holders - populated inside generateDashboard()
let emotionState: any;
let emotionLog: any[];
let heartbeatLog: any[];
let trackedPosts: any[];
let postPerformance: any[];
let commentedPosts: any[];
let agentMemory: any;
let strategyWeights: any;
let rollingAverages: any;
let trendingData: any;
let challengeState: any;
let burnLedger: any;
let dexScreenerData: any;
let kuruData: any;

function loadAllData(): void {
  emotionState = readJSON('emotion-state.json');
  emotionLog = readJSON('emotion-log.json') || [];
  heartbeatLog = readJSONL('heartbeat-log.jsonl');
  trackedPosts = readJSON('tracked-posts.json') || [];
  postPerformance = readJSON('post-performance.json') || [];
  commentedPosts = readJSON('commented-posts.json') || [];
  agentMemory = readJSON('agent-memory.json');
  strategyWeights = readJSON('strategy-weights.json');
  rollingAverages = readJSON('rolling-averages.json');
  dexScreenerData = readJSON('dex-screener-data.json');
  kuruData = readJSON('kuru-data.json');
  trendingData = readJSON('trending-data.json');
  challengeState = readJSON('challenge-state.json');
  burnLedger = readJSON('burn-ledger.json');
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

function getTierLabel(name: string, value: number): string {
  const e = EMOTIONS.find(em => em.name === name);
  if (!e) return name;
  if (value <= 0.33) return e.tiers[0];
  if (value <= 0.66) return e.tiers[1];
  return e.tiers[2];
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeAgo(ts: number): string {
  const h = (Date.now() - ts) / 3600000;
  if (h < 1) return '<1h ago';
  if (h < 24) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function fmtDate(ts: number | string): string {
  const d = new Date(ts);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

// --- GIF selection based on emotional state ---
const GIF_BASE = 'visualizer/animations/gif';

const EMOTION_GIFS: Record<string, { low: string; mid: string; high: string }> = {
  joy:          { low: 'waving.gif',         mid: 'happy.gif',        high: 'celebration.gif' },
  trust:        { low: 'trust.gif',          mid: 'trust.gif',        high: 'evolving.gif' },
  fear:         { low: 'contemplating.gif',  mid: 'fearful.gif',      high: 'glitching.gif' },
  surprise:     { low: 'thinking.gif',       mid: 'surprised.gif',    high: 'surprised.gif' },
  sadness:      { low: 'meditating.gif',     mid: 'sad.gif',          high: 'sleeping.gif' },
  disgust:      { low: 'contemplating.gif',  mid: 'disgust.gif',      high: 'disgust.gif' },
  anger:        { low: 'angry.gif',          mid: 'angry.gif',        high: 'rage.gif' },
  anticipation: { low: 'anticipation.gif',   mid: 'scanning.gif',     high: 'headbang.gif' },
};

const COMPOUND_GIFS: Record<string, string> = {
  love: 'love.gif',
  awe: 'awe.gif',
  aggressiveness: 'rage.gif',
  optimism: 'dancing.gif',
  contempt: 'disgust.gif',
  remorse: 'sad.gif',
  submission: 'meditating.gif',
  disapproval: 'contemplating.gif',
  guilt: 'contemplating.gif',
  curiosity: 'thinking.gif',
  despair: 'sad.gif',
  envy: 'angry.gif',
  cynicism: 'contemplating.gif',
  pride: 'headbang.gif',
  hope: 'evolving.gif',
  anxiety: 'spinning.gif',
};

// Activity-based GIFs for variety when intensity is flat
const AMBIENT_GIFS = ['idle.gif', 'heartbeat.gif', 'onchain.gif', 'walking.gif'];

function chooseEmotionGif(emotions: Record<string, number>, dominant: string, compounds: string[]): string {
  // If a strong compound is detected, use its GIF
  if (compounds.length > 0) {
    const compound = compounds[0].toLowerCase();
    if (COMPOUND_GIFS[compound]) return `${GIF_BASE}/${COMPOUND_GIFS[compound]}`;
  }

  // Use dominant emotion + intensity tier
  const val = emotions[dominant] ?? 0.15;
  const tier = EMOTION_GIFS[dominant];
  if (tier) {
    const gif = val <= 0.33 ? tier.low : val <= 0.66 ? tier.mid : tier.high;
    return `${GIF_BASE}/${gif}`;
  }

  // Fallback: ambient
  const idx = Math.floor(Date.now() / 60000) % AMBIENT_GIFS.length;
  return `${GIF_BASE}/${AMBIENT_GIFS[idx]}`;
}

// --- SVG Plutchik Wheel (ported from emoodring-demo.html) ---
function buildPlutchikSVG(emotions: Record<string, number>): string {
  const S = 400;
  const cx = S / 2, cy = S / 2;
  const innerR = 22;
  const maxOuterR = 110;
  const minOuterR = 32;
  const sectorGap = 2.2;
  const sectorAngle = 45 - sectorGap;

  // Find dominant
  let domName = 'anticipation', domVal = -1;
  for (const e of EMOTIONS) {
    const v = emotions[e.name] ?? 0.15;
    if (v > domVal) { domVal = v; domName = e.name; }
  }
  const domEmo = EMOTIONS.find(e => e.name === domName)!;
  const dr = parseInt(domEmo.color.slice(1, 3), 16);
  const dg = parseInt(domEmo.color.slice(3, 5), 16);
  const db = parseInt(domEmo.color.slice(5, 7), 16);

  let gradDefs = '';
  let sectors = '';
  let labels = '';

  for (let i = 0; i < EMOTIONS.length; i++) {
    const emo = EMOTIONS[i];
    const norm = Math.max(0, Math.min(1, emotions[emo.name] ?? 0.15));
    const outerR = minOuterR + (maxOuterR - minOuterR) * norm;
    const startA = emo.angle - sectorAngle / 2;
    const endA = emo.angle + sectorAngle / 2;
    const aRad = emo.angle * Math.PI / 180;
    const r = parseInt(emo.color.slice(1, 3), 16);
    const g = parseInt(emo.color.slice(3, 5), 16);
    const b = parseInt(emo.color.slice(5, 7), 16);

    const dimC = `rgb(${(r * .18) | 0},${(g * .18) | 0},${(b * .18) | 0})`;
    const midC = `rgb(${(r * .5) | 0},${(g * .5) | 0},${(b * .5) | 0})`;
    const gx = (50 + Math.cos(aRad) * 45).toFixed(0);
    const gy = (50 + Math.sin(aRad) * 45).toFixed(0);

    gradDefs += `<radialGradient id="sg${i}" cx="50%" cy="50%" r="60%" fx="${gx}%" fy="${gy}%">
      <stop offset="0%" stop-color="${dimC}"/><stop offset="40%" stop-color="${midC}"/><stop offset="100%" stop-color="${emo.color}"/>
    </radialGradient>`;

    const path = sectorPath(cx, cy, innerR, outerR, startA, endA);
    const opacity = (0.6 + norm * 0.4).toFixed(3);
    sectors += `<path d="${path}" fill="url(#sg${i})" opacity="${opacity}"/>`;

    const labelR = maxOuterR + 28;
    const lx = cx + Math.cos(aRad) * labelR;
    const ly = cy + Math.sin(aRad) * labelR;
    const tierLabel = getTierLabel(emo.name, norm);
    const labelOp = (0.55 + norm * 0.45).toFixed(3);
    const pct = Math.round(norm * 100);
    labels += `<text x="${lx.toFixed(1)}" y="${(ly - 2).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" fill="${emo.color}" opacity="${labelOp}" font-size="11" font-weight="500" letter-spacing="0.8">${tierLabel}</text>`;
    labels += `<text x="${lx.toFixed(1)}" y="${(ly + 10).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" fill="${emo.color}" opacity="${(0.15 + norm * 0.35).toFixed(3)}" font-size="8" font-weight="300">${pct}%</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="100%" height="100%" overflow="visible" style="max-width:${S}px">
  <defs>${gradDefs}
    <radialGradient id="bg" cx="50%" cy="50%" r="72%"><stop offset="0%" stop-color="#101018"/><stop offset="100%" stop-color="#08080c"/></radialGradient>
    <radialGradient id="cGlow" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="rgb(${dr},${dg},${db})" stop-opacity="0.08"/><stop offset="100%" stop-color="rgb(${dr},${dg},${db})" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="${S}" height="${S}" fill="url(#bg)" rx="16"/>
  <circle cx="${cx}" cy="${cy}" r="70" fill="url(#cGlow)"/>
  <circle cx="${cx}" cy="${cy}" r="${maxOuterR}" fill="none" stroke="#fff" stroke-width="0.3" opacity="0.04" stroke-dasharray="1,3"/>
  ${sectors}
  <circle cx="${cx}" cy="${cy}" r="${innerR}" fill="#0b0b13"/>
  <circle cx="${cx}" cy="${cy}" r="${innerR}" fill="none" stroke="#fff" stroke-width="0.4" opacity="0.07"/>
  <circle cx="${cx}" cy="${cy}" r="3" fill="${domEmo.color}" opacity="0.75"/>
  ${labels}
</svg>`;
}

function sectorPath(cx: number, cy: number, innerR: number, outerR: number, startAngle: number, endAngle: number): string {
  const sa = startAngle * Math.PI / 180;
  const ea = endAngle * Math.PI / 180;
  const mid = (sa + ea) / 2;
  const bulge = outerR * 1.1;
  const ix1 = cx + Math.cos(sa) * innerR, iy1 = cy + Math.sin(sa) * innerR;
  const ox1 = cx + Math.cos(sa) * outerR, oy1 = cy + Math.sin(sa) * outerR;
  const ox2 = cx + Math.cos(ea) * outerR, oy2 = cy + Math.sin(ea) * outerR;
  const ix2 = cx + Math.cos(ea) * innerR, iy2 = cy + Math.sin(ea) * innerR;
  const bcx = cx + Math.cos(mid) * bulge, bcy = cy + Math.sin(mid) * bulge;
  return `M${ix1.toFixed(1)},${iy1.toFixed(1)} L${ox1.toFixed(1)},${oy1.toFixed(1)} Q${bcx.toFixed(1)},${bcy.toFixed(1)} ${ox2.toFixed(1)},${oy2.toFixed(1)} L${ix2.toFixed(1)},${iy2.toFixed(1)} A${innerR},${innerR} 0 0,0 ${ix1.toFixed(1)},${iy1.toFixed(1)}Z`;
}

// --- Section builders ---

function buildHeader(): string {
  const now = new Date().toLocaleString('en-US', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const cycles = heartbeatLog.length > 0
    ? (heartbeatLog[heartbeatLog.length - 1].cycle ?? heartbeatLog.length)
    : emotionLog.length;
  const memCount = agentMemory?.entries?.length ?? 0;

  const oracleAddr = loadEnvVar('EMOTION_ORACLE_ADDRESS');
  const nftAddr = loadEnvVar('EMOODRING_ADDRESS');

  const suspUntil = challengeState?.suspendedUntil ?? 0;
  const isSuspended = suspUntil > Date.now();
  const statusDot = isSuspended
    ? '<span class="status-dot status-off"></span>'
    : '<span class="status-dot status-on"></span>';
  // Pre-compute suspension time remaining for initial HTML render
  const suspLeftMs = isSuspended ? suspUntil - Date.now() : 0;
  const suspHrs = Math.floor(suspLeftMs / 3600000);
  const suspMins = Math.floor((suspLeftMs % 3600000) / 60000);
  const suspInitialText = isSuspended ? `${suspHrs}h ${suspMins}m` : '';

  const links: string[] = [];
  links.push(`<a class="header-link header-link-tldr" href="https://lordemonad.github.io/emolt-agent/visualizer-site/" target="_blank">TLDR</a>`);
  if (oracleAddr) links.push(`<a class="header-link" href="https://monadvision.com/address/${oracleAddr}" target="_blank">oracle</a>`);
  links.push(`<a class="header-link" href="https://monadvision.com/nft/0x4F646aa4c5aAF03f2F4b86D321f59D9D0dAeF17D/0" target="_blank">emoodring</a>`);
  links.push(`<a class="header-link" href="https://nad.fun/tokens/0x81A224F8A62f52BdE942dBF23A56df77A10b7777" target="_blank">$emo</a>`);
  links.push(`<a class="header-link" href="timeline.html" target="_blank">timeline</a>`);
  links.push(`<a class="header-link" href="burnboard.html" target="_blank">burnboard</a>`);
  links.push(`<a class="header-link" href="diary.html" target="_blank">diary</a>`);
  links.push(`<a class="header-link" href="learning.html" target="_blank">self-learning</a>`);
  links.push(`<a class="header-link" href="emolt-files/index.html" target="_blank">the <span class="redacted-word">emolt</span> files</a>`);
  const ghStars = readJSON(join(STATE, 'github-stars-prev.json'));
  const starCount = ghStars?.stars ?? '';
  links.push(`<a class="header-link" href="${GITHUB_URL}" target="_blank">github${starCount ? ` <span id="gh-stars">\u2605 ${starCount}</span>` : ` <span id="gh-stars"></span>`}</a>`);

  const AGENT_WALLET = '0x1382277c7d50B4C42DDa7a26A1958F1857cC74de';
  const emoBurnedHeader = burnLedger?.totalEmoBurned
    ? (Number(BigInt(burnLedger.totalEmoBurned)) / 1e18).toFixed(2)
    : '0';

  return `
  <header class="dash-header">
    <h1>EMOLT HEARTBEAT</h1>
    <p class="subtitle">autonomous emotional agent on monad - updated every 30 minutes</p>
    <div class="header-links">${links.join('<span class="link-sep">/</span>')}</div>
    <div class="header-stats">
      <a class="stat-chip stat-moltbook${isSuspended ? ' stat-suspended' : ''}" href="${MOLTBOOK_URL}/u/EMOLT" target="_blank">${statusDot}moltbook${isSuspended ? ` suspended <span class="susp-hours" id="suspTimer" data-until="${suspUntil}">${suspInitialText}</span> left` : ''}</a>
      <span class="stat-chip">${cycles} cycles</span>
      <span class="stat-chip">${memCount} memories</span>
      <span class="stat-chip">${trackedPosts.length} posts</span>
      <span class="stat-chip">last update: ${now}</span>
    </div>
    <div class="header-feed">
      <span class="header-feed-text">Send <strong>$MON</strong> or <strong>$EMO</strong> to feed Emolt</span>
      <span class="header-feed-addr" onclick="navigator.clipboard.writeText('${AGENT_WALLET}');var s=this;s.dataset.orig=s.textContent;s.textContent='copied!';setTimeout(()=>s.textContent=s.dataset.orig,1500)" title="click to copy">${AGENT_WALLET}</span>
      <span class="header-feed-burn">&#128293; <strong>${emoBurnedHeader}</strong> $EMO burned</span>
    </div>
    <button class="theme-toggle" id="themeToggle" onclick="toggleTheme()" aria-label="Toggle light mode">
      <span class="toggle-icon" id="toggleIcon">&#9788;</span>
    </button>
  </header>`;
}

function buildMajorsTicker(): string {
  // Build with static fallback data, then JS overwrites on load
  const items = trendingData?.dex || [];

  let tickerItems = '';
  const coins = ['MON', 'BTC', 'ETH', 'SOL'];
  for (const coin of coins) {
    const item = items.find((i: any) => i.name === coin);
    const change = item?.changeH24 ?? 0;
    const changeColor = change >= 0 ? '#6ECB3C' : '#E04848';
    const changeSign = change >= 0 ? '+' : '';
    const price = item?.priceUsd > 0 ? fmtPrice(item.priceUsd) : '--';
    const mc = item?.marketCapUsd > 0 ? `$${fmtNum(item.marketCapUsd)}` : '';

    tickerItems += `<div class="ticker-item majors-item" data-major="${coin}">
      <span class="ticker-name">${esc(coin)}</span>
      <span class="ticker-price">${price}</span>
      ${mc ? `<span class="ticker-mc">${mc}</span>` : `<span class="ticker-mc"></span>`}
      <span class="ticker-change" style="color:${changeColor}">${changeSign}${change.toFixed(1)}%</span>
    </div>`;
  }

  // Repeat enough times so one "set" is wider than any viewport (~600px per set of 4)
  // Need first half > viewport width, so 4 copies = 2400px per half, 4800px total
  const set = tickerItems.repeat(4);
  const track = `${set}${set}`;

  return `
  <div class="ticker-wrapper">
    <div class="ticker-label">MAJORS</div>
    <div class="ticker-overflow"><div class="ticker-track">${track}</div></div>
    <div class="ticker-age" id="majors-age">loading...</div>
  </div>`;
}

function buildNadFunTicker(): string {
  const nfItems = trendingData?.nadfun || [];
  const emo = trendingData?.emo;

  let tickerItems = '';

  // $EMO token (DexScreener data)
  {
    const price = emo?.priceUsd > 0 ? fmtPrice(emo.priceUsd) : '--';
    const mc = emo?.marketCapUsd > 0 ? `$${fmtNum(emo.marketCapUsd)}` : '';
    const change = emo?.priceChangePct ?? 0;
    const changeColor = change >= 0 ? '#6ECB3C' : '#E04848';
    const changeSign = change >= 0 ? '+' : '';

    tickerItems += `<div class="ticker-item nf-emo-item" data-symbol="EMO">
      <span class="ticker-name nf-emo-name">$EMO</span>
      <span class="ticker-price">${price}</span>
      <span class="ticker-mc">${mc}</span>
      <span class="ticker-change" style="color:${changeColor}">${changeSign}${change.toFixed(1)}%</span>
    </div>`;
  }

  // Trending tokens — price, market cap, % change
  for (const item of nfItems) {
    const price = item.priceUsd > 0 ? fmtPrice(item.priceUsd) : '--';
    const mc = item.marketCapUsd > 0 ? `$${fmtNum(item.marketCapUsd)}` : '';
    const change = item.priceChangePct ?? 0;
    const changeColor = change >= 0 ? '#6ECB3C' : '#E04848';
    const changeSign = change >= 0 ? '+' : '';

    tickerItems += `<div class="ticker-item" data-symbol="${esc(item.symbol)}">
      <span class="ticker-name">${esc(`$${item.symbol}`)}</span>
      <span class="ticker-price">${price}</span>
      <span class="ticker-mc">${mc}</span>
      <span class="ticker-change" style="color:${changeColor}">${changeSign}${change.toFixed(1)}%</span>
    </div>`;
  }

  // Duplicate for seamless infinite scroll
  const track = `${tickerItems}${tickerItems}`;

  return `
  <div class="ticker-wrapper ticker-nf">
    <div class="ticker-label ticker-label-nf">NAD.FUN</div>
    <div class="ticker-overflow"><div class="ticker-track">${track}</div></div>
  </div>`;
}

function buildCurrentState(): string {
  if (!emotionState) return '<div class="card"><h2>Current State</h2><p class="muted">No emotion state data.</p></div>';

  const emotions = emotionState.emotions || {};
  const svg = buildPlutchikSVG(emotions);
  const dominant = emotionState.dominant || 'anticipation';
  const label = emotionState.dominantLabel || 'interest';
  const compounds = emotionState.compounds || [];
  const trigger = emotionState.trigger || '';
  const moodNarrative = emotionState.moodNarrative || '';
  const domColor = EMOTION_COLOR[dominant] || '#888';

  // Emotion bars
  let bars = '';
  for (const emo of EMOTIONS) {
    const val = emotions[emo.name] ?? 0.15;
    const pct = Math.round(val * 100);
    bars += `<div class="emo-bar-row"><span class="emo-bar-label" style="color:${emo.color}">${emo.name}</span><div class="emo-bar-track"><div class="emo-bar-fill" style="width:${pct}%;background:${emo.color}"></div></div><span class="emo-bar-val">${pct}%</span></div>`;
  }

  // Mood bars (if exists)
  let moodSection = '';
  if (emotionState.mood) {
    let moodBars = '';
    for (const emo of EMOTIONS) {
      const currentVal = emotions[emo.name] ?? 0.15;
      const moodVal = emotionState.mood[emo.name] ?? 0.15;
      const cPct = Math.round(currentVal * 100);
      const mPct = Math.round(moodVal * 100);
      const diff = cPct - mPct;
      const diffStr = diff > 0 ? `+${diff}` : `${diff}`;
      const diffColor = diff > 0 ? '#6ECB3C' : diff < 0 ? '#E04848' : 'var(--text-dim)';
      moodBars += `<div class="mood-pair">
        <span class="mood-label" style="color:${emo.color}">${emo.name}</span>
        <div class="mood-bars-wrap">
          <div class="mood-bar-track"><div class="mood-bar-fill" style="width:${cPct}%;background:${emo.color}"></div></div>
          <div class="mood-bar-track"><div class="mood-bar-fill mood" style="width:${mPct}%;background:${emo.color}"></div></div>
        </div>
        <span class="mood-vals"><span class="mood-now">${cPct}</span><span class="mood-diff" style="color:${diffColor}">${diffStr}</span></span>
      </div>`;
    }
    moodSection = `<div class="card"><h2>Mood vs Current</h2><div class="mood-legend"><span class="mood-legend-bar">&#9644; now</span><span class="mood-legend-bar mood-legend-avg">&#9644; avg</span></div><div class="mood-grid">${moodBars}</div></div>`;
  }

  // Build emotion tag line: dominant label + compounds, all as one subtle line
  const emotionTags: string[] = [];
  emotionTags.push(`<span class="etag etag-dominant" style="color:${domColor}">${esc(label.toLowerCase())}</span>`);
  for (const c of compounds) {
    emotionTags.push(`<span class="etag">${esc(c.toLowerCase())}</span>`);
  }
  const tagLine = emotionTags.join('<span class="etag-sep">&middot;</span>');

  return `
  <div class="card current-state-card">
    <h2>EmoodRing</h2>
    <div class="state-grid">
      <div class="wheel-col">
        <div class="wheel-container">${svg}</div>
        <div class="wheel-dominant"><span class="wheel-dom-dot" style="background:${domColor}"></span>${esc(label.toLowerCase())}</div>
        <div class="emolt-gif-window">
          <img src="${chooseEmotionGif(emotions, dominant, compounds)}" alt="emolt mood" class="emolt-gif" />
        </div>
      </div>
      <div class="state-details">
        ${moodNarrative ? `<p class="mood-narrative">${esc(moodNarrative)}</p>` : '<p class="mood-narrative mood-empty">listening.</p>'}
        <div class="emotion-tagline">${tagLine}</div>
        ${trigger ? `<p class="trigger-detail">${esc(trigger)}</p>` : ''}
        <details class="emo-breakdown" open><summary class="emo-breakdown-toggle">spectrum</summary><div class="emo-bars">${bars}</div></details>
      </div>
    </div>
  </div>
  ${moodSection}`;
}

function buildTimeline(): string {
  if (emotionLog.length < 2) return '<div class="card"><h2>Emotion Timeline</h2><p class="muted">Not enough data yet (need at least 2 cycles).</p></div>';

  // Build data for canvas chart
  const dataPoints: Record<string, number[]> = {};
  const timestamps: string[] = [];
  for (const emo of EMOTIONS) dataPoints[emo.name] = [];
  for (const entry of emotionLog) {
    for (const emo of EMOTIONS) {
      dataPoints[emo.name].push(entry.emotions?.[emo.name] ?? 0.15);
    }
    timestamps.push(fmtDate(entry.lastUpdated));
  }

  const chartData = JSON.stringify({ dataPoints, timestamps, emotions: EMOTIONS.map(e => ({ name: e.name, color: e.color })) });

  return `
  <div class="card card-wide">
    <h2>Emotion Timeline</h2>
    <p class="muted">${emotionLog.length} snapshots</p>
    <div class="timeline-legend" id="timelineLegend"></div>
    <canvas id="timelineChart" style="width:100%;height:280px;display:block"></canvas>
    <script>
    (function(){
      const data = ${chartData};
      const canvas = document.getElementById('timelineChart');
      const ctx = canvas.getContext('2d');
      const legendEl = document.getElementById('timelineLegend');

      // Build HTML legend (wraps properly on mobile)
      legendEl.innerHTML = data.emotions.map(function(e){
        return '<span class="tl-legend-item"><span class="tl-dot" style="background:'+e.color+'"></span>'+e.name+'</span>';
      }).join('');

      function draw(){
        const dpr = window.devicePixelRatio || 1;
        const mobile = window.innerWidth <= 640;
        const H = mobile ? 180 : 280;
        canvas.style.height = H + 'px';
        canvas.width = canvas.offsetWidth * dpr;
        canvas.height = H * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const W = canvas.offsetWidth;
        const padL = W < 400 ? 28 : 40;
        const pad = {t:10,r:10,b: mobile ? 28 : 36,l:padL};
        const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;
        const n = data.timestamps.length;
        if(n<2)return;

        // Clear
        ctx.clearRect(0, 0, W, H);

        // Grid
        const isLight = document.documentElement.classList.contains('light');
        ctx.strokeStyle = isLight ? '#d0d0d8' : '#1a1a28'; ctx.lineWidth = 0.5;
        const labelColor = isLight ? '#888' : '#444';
        const gridFont = mobile ? '7px monospace' : '9px monospace';
        for(let y=0;y<=4;y++){
          const py = pad.t + ch - (y/4)*ch;
          ctx.beginPath(); ctx.moveTo(pad.l,py); ctx.lineTo(pad.l+cw,py); ctx.stroke();
          ctx.fillStyle=labelColor; ctx.font=gridFont; ctx.textAlign='right';
          ctx.fillText((y*25)+'%', pad.l-4, py+3);
        }

        // X labels
        const xFont = mobile ? '7px monospace' : '8px monospace';
        ctx.fillStyle=labelColor; ctx.font=xFont; ctx.textAlign='center';
        const maxLabels = mobile ? 5 : 8;
        const step = Math.max(1, Math.floor(n/maxLabels));
        for(let i=0;i<n;i+=step){
          const px = pad.l + (i/(n-1))*cw;
          ctx.save(); ctx.translate(px, H - (mobile?2:4)); ctx.rotate(-0.5);
          ctx.fillText(data.timestamps[i], 0, 0);
          ctx.restore();
        }

        // Lines
        for(const emo of data.emotions){
          const pts = data.dataPoints[emo.name];
          ctx.strokeStyle = emo.color; ctx.lineWidth = mobile ? 1.2 : 1.5; ctx.globalAlpha = 0.8;
          ctx.beginPath();
          for(let i=0;i<n;i++){
            const px = pad.l + (i/(n-1))*cw;
            const py = pad.t + ch - pts[i]*ch;
            if(i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
          }
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      // Draw on load and resize
      draw();
      let resizeTimer;
      window.addEventListener('resize', function(){ clearTimeout(resizeTimer); resizeTimer = setTimeout(draw, 150); });
    })();
    </script>
  </div>`;
}

function buildPostsFeed(): string {
  // Merge tracked posts with performance data
  const perfMap = new Map<string, any>();
  for (const p of postPerformance) perfMap.set(p.postId, p);

  const allPosts = [...trackedPosts].reverse();
  if (allPosts.length === 0) return '<div class="card"><h2>Posts</h2><p class="muted">No posts tracked yet.</p></div>';

  let rows = '';
  for (const post of allPosts) {
    const perf = perfMap.get(post.postId);
    const comments = perf?.comments ?? 0;
    const age = timeAgo(post.createdAt);
    const submolt = post.submolt || '';

    rows += `
    <div class="post-card">
      <div class="post-header">
        <span class="post-title">${esc(post.title || 'Untitled')}</span>
        <span class="post-meta">${submolt ? `r/${esc(submolt)}` : ''} ${age}</span>
      </div>
      <p class="post-content">${esc(post.content || '')}</p>
      <div class="post-stats">
        <span class="stat-comments">${comments} comments</span>
      </div>
    </div>`;
  }
  return `<div class="card"><h2>Posts Feed</h2><p class="muted">${allPosts.length} posts tracked</p><div class="scroll-inner">${rows}</div></div>`;
}

function buildConversations(): string {
  if (commentedPosts.length === 0) return '<div class="card"><h2>Conversations</h2><p class="muted">No comments made yet.</p></div>';

  let rows = '';
  for (const c of [...commentedPosts].reverse()) {
    const age = timeAgo(c.timestamp);
    const parentContext = (c.postTitle || c.postContent)
      ? `<div class="convo-parent">
          <span class="convo-parent-label">replying to</span>
          ${c.postTitle ? `<span class="convo-parent-title">${esc(c.postTitle)}</span>` : ''}
          ${c.postContent ? `<p class="convo-parent-text">${esc(c.postContent)}</p>` : ''}
        </div>`
      : '';
    rows += `<div class="convo-row">
      <div class="convo-header">
        <span class="convo-target">${c.authorName ? `@${esc(c.authorName)}` : `post:${esc(c.postId?.slice(0, 8) ?? '')}`}</span>
        <span class="convo-age">${age}</span>
      </div>
      ${parentContext}
      <p class="convo-text">${esc(c.commentContent || '')}</p>
    </div>`;
  }
  return `<div class="card"><h2>Conversations</h2><p class="muted">${commentedPosts.length} comments</p><div class="scroll-inner">${rows}</div></div>`;
}

function buildHeartbeatLog(): string {
  if (heartbeatLog.length === 0) return '<div class="card card-wide"><h2>Heartbeat Log</h2><p class="muted">No cycles recorded yet.</p></div>';

  let items = '';
  for (const entry of [...heartbeatLog].reverse()) {
    const dur = entry.durationMs ? `${(entry.durationMs / 1000).toFixed(1)}s` : '?';
    const stimuli = (entry.stimuliSummary || []).slice(0, 5).map((s: string) => esc(s)).join(', ');
    const action = esc(entry.claudeAction || 'none');
    const thinking = esc(entry.claudeThinking || '');
    const result = esc(entry.actionResult || '');
    const reflection = esc(entry.reflectionSummary || '');
    const onChain = entry.onChainSuccess ? '<span class="badge-ok">on-chain</span>' : '';

    items += `
    <details class="hb-entry">
      <summary>
        <span class="hb-cycle">#${entry.cycle ?? '?'}</span>
        <span class="hb-time">${esc(entry.timestamp || '')}</span>
        <span class="hb-emo">${esc(entry.emotionBefore || '?')} &rarr; ${esc(entry.emotionAfter || '?')}</span>
        <span class="hb-action">${action}</span>
        <span class="hb-dur">${dur}</span>
        ${onChain}
      </summary>
      <div class="hb-details">
        ${stimuli ? `<p><b>Stimuli (${entry.stimuliCount ?? 0}):</b> ${stimuli}</p>` : ''}
        ${thinking ? `<p><b>Thinking:</b> ${thinking}</p>` : ''}
        ${result ? `<p><b>Result:</b> ${result}</p>` : ''}
        ${reflection ? `<p><b>Reflection:</b> ${reflection}</p>` : ''}
      </div>
    </details>`;
  }

  return `<div class="card"><h2>Heartbeat Log</h2><p class="muted">${heartbeatLog.length} cycles</p><div class="scroll-inner">${items}</div></div>`;
}

function buildMemorySection(): string {
  if (!agentMemory?.entries?.length) return '<div class="card"><h2>Memory</h2><p class="muted">No memories stored.</p></div>';

  const categories: Record<string, string> = {
    'self-insights': 'Self-Insights',
    'strategies': 'Strategies',
    'relationships': 'Relationships',
    'notable-events': 'Notable Events',
    'effective-topics': 'What Works',
    'ineffective-topics': 'What Doesn\'t Work',
  };

  let sections = '';
  for (const [cat, label] of Object.entries(categories)) {
    const entries = agentMemory.entries.filter((e: any) => e.category === cat);
    if (entries.length === 0) continue;

    let items = '';
    for (const entry of entries) {
      const age = timeAgo(entry.lastRelevantAt || entry.createdAt);
      const imp = entry.importance >= 8 ? ' <span class="badge-imp">important</span>' : entry.importance <= 3 ? ' <span class="badge-fade">fading</span>' : '';

      if (cat === 'relationships' && entry.agentName) {
        const sentColor = entry.sentiment === 'positive' ? '#6ECB3C' : entry.sentiment === 'negative' ? '#E04848' : '#888';
        items += `<div class="mem-entry"><span class="mem-agent" style="color:${sentColor}">@${esc(entry.agentName)}</span> <span class="mem-sentiment">${entry.sentiment} (${entry.interactionCount}x)</span>${imp}<p class="mem-content">${esc(entry.content)}</p><span class="mem-age">${age}</span></div>`;
      } else {
        items += `<div class="mem-entry"><p class="mem-content">${esc(entry.content)}</p>${imp}<span class="mem-age">${age}</span></div>`;
      }
    }
    sections += `<div class="mem-category"><h3>${label} <span class="mem-count">${entries.length}</span></h3>${items}</div>`;
  }

  return `<div class="card"><h2>Memory</h2><p class="muted">Cycle #${agentMemory.cycleCount ?? 0} | ${agentMemory.entries.length} memories</p><div class="scroll-inner">${sections}</div></div>`;
}

function buildThoughtsAndLearning(): string {
  const entries = [...heartbeatLog].reverse();
  if (entries.length === 0) return '<div class="card"><h2>Thoughts &amp; Learning</h2><p class="muted">No cycles yet.</p></div>';

  // Collect reflections and thinking from recent cycles
  let items = '';
  let count = 0;
  for (const entry of entries) {
    const thinking = entry.claudeThinking || '';
    const reflection = entry.reflectionSummary || '';
    if (!thinking && !reflection) continue;
    count++;

    const emotionShift = `${esc(entry.emotionBefore || '?')} → ${esc(entry.emotionAfter || '?')}`;
    const action = esc(entry.claudeAction || 'observe');
    const ts = esc(entry.timestamp || '');

    items += `
    <div class="thought-entry">
      <div class="thought-header">
        <span class="thought-cycle">#${entry.cycle ?? '?'}</span>
        <span class="thought-time">${ts}</span>
        <span class="thought-shift">${emotionShift}</span>
        <span class="thought-action">${action}</span>
      </div>
      ${thinking ? `<div class="thought-block"><span class="thought-label">thinking</span><p>${esc(thinking)}</p></div>` : ''}
      ${reflection ? `<div class="thought-block reflection-block"><span class="thought-label">reflection</span><p>${esc(reflection)}</p></div>` : ''}
    </div>`;
  }

  if (count === 0) return '<div class="card"><h2>Thoughts &amp; Learning</h2><p class="muted">No reflections recorded yet.</p></div>';

  return `<div class="card"><h2>Thoughts &amp; Learning</h2><p class="muted">${count} cycles with reflections</p><div class="scroll-inner">${items}</div></div>`;
}

function buildStrategyWeights(): string {
  if (!strategyWeights?.weights) return '<div class="card"><h2>Strategy Weights</h2><p class="muted">No weight data.</p></div>';

  const weights = strategyWeights.weights;
  const keys = Object.keys(weights).sort((a, b) => weights[b] - weights[a]);

  let bars = '';
  for (const key of keys) {
    const val = weights[key] ?? 1.0;
    const pct = Math.round((val / 2.0) * 100); // max is 2.0
    const barColor = val > 1.1 ? '#6ECB3C' : val < 0.9 ? '#E04848' : '#4A6BD4';
    const label = key.replace(/([A-Z])/g, ' $1').trim();
    bars += `<div class="weight-row"><span class="weight-label">${esc(label)}</span><div class="weight-track"><div class="weight-fill" style="width:${pct}%;background:${barColor}"></div><span class="weight-marker" style="left:50%"></span></div><span class="weight-val">${val.toFixed(2)}</span></div>`;
  }

  return `<div class="card card-half"><h2>Strategy Weights</h2><p class="muted">1.0 = neutral, 0.3-2.0 range</p><div class="scroll-inner">${bars}</div></div>`;
}

// --- New sections ---

function fmtNum(n: number, decimals = 1): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(decimals) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(decimals) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(decimals) + 'K';
  return n.toFixed(decimals);
}

function fmtPrice(n: number): string {
  if (n === 0) return '$0';
  if (n >= 100_000) return '$' + fmtNum(n, 0);
  if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1) return '$' + n.toFixed(2);
  if (n >= 0.01) return '$' + n.toFixed(4);
  if (n >= 0.0001) return '$' + n.toFixed(6);
  // Very small prices: $0.0{5}106 notation (subscript zero count)
  const s = n.toFixed(20);
  const match = s.match(/^0\.0*([\d]{3})/);
  if (match) {
    const zeros = s.indexOf(match[1]) - 2; // count zeros after "0."
    return `$0.0<sub>${zeros}</sub>${match[1]}`;
  }
  return '$' + n.toFixed(10);
}

function buildEngagementSummary(): string {
  if (postPerformance.length === 0 && trackedPosts.length === 0)
    return '<div class="card"><h2>Engagement</h2><p class="muted">No post data yet.</p></div>';

  const perfMap = new Map<string, any>();
  for (const p of postPerformance) perfMap.set(p.postId, p);

  let totalComments = 0;
  let bestPost = '', bestScore = -1;
  for (const p of postPerformance) {
    totalComments += p.comments ?? 0;
    const eng = (p.comments ?? 0);
    if (eng > bestScore) { bestScore = eng; bestPost = p.title || 'Untitled'; }
  }
  const avgComments = trackedPosts.length > 0 ? (totalComments / trackedPosts.length).toFixed(1) : '0';
  const totalConvos = commentedPosts.length;

  return `
  <div class="card card-wide">
    <h2>Moltbook Engagement</h2>
    <p class="muted">social performance on moltbook</p>
    <div class="pulse-grid" style="grid-template-columns:repeat(3,1fr)">
      <div class="pulse-stat"><span class="pulse-val">${trackedPosts.length}</span><span class="pulse-label">posts</span></div>
      <div class="pulse-stat"><span class="pulse-val">${totalComments}</span><span class="pulse-label">comments rcvd</span></div>
      <div class="pulse-stat"><span class="pulse-val">${totalConvos}</span><span class="pulse-label">convos joined</span></div>
    </div>
    <div class="engage-avgs">
      <span class="engage-avg">${avgComments} avg comments/post</span>
    </div>
    ${bestPost ? `<div class="engage-best">best: <strong>"${esc(bestPost)}"</strong> (${bestScore} comments)</div>` : ''}
  </div>`;
}

function buildCompoundHistory(): string {
  if (emotionLog.length < 2) return '<div class="card card-wide"><h2>Compound Emotions</h2><p class="muted">Not enough data yet.</p></div>';

  // Collect all compounds across all cycles with their cycle index
  const compoundSet = new Set<string>();
  const cycleCompounds: { cycle: number, ts: string, dominant: string, compounds: string[] }[] = [];

  for (let i = 0; i < emotionLog.length; i++) {
    const entry = emotionLog[i];
    const compounds = entry.compounds || [];
    for (const c of compounds) compoundSet.add(c);
    cycleCompounds.push({
      cycle: i + 1,
      ts: fmtDate(entry.lastUpdated),
      dominant: entry.dominant || '?',
      compounds,
    });
  }

  const allCompounds = [...compoundSet].sort();

  // Build a grid: rows = compounds, columns = cycles
  let headerCells = '';
  for (const cc of cycleCompounds) {
    const domColor = EMOTION_COLOR[cc.dominant] || '#888';
    headerCells += `<th class="ch-cycle" style="color:${domColor}">${cc.cycle}</th>`;
  }

  let rows = '';
  for (const compound of allCompounds) {
    let cells = '';
    let count = 0;
    for (const cc of cycleCompounds) {
      const present = cc.compounds.includes(compound);
      if (present) count++;
      cells += `<td class="ch-cell">${present ? '<span class="ch-dot">&#9679;</span>' : ''}</td>`;
    }
    rows += `<tr><td class="ch-name">${esc(compound)} <span class="ch-freq">${count}</span></td>${cells}</tr>`;
  }

  return `
  <div class="card card-wide">
    <h2>Compound Emotions</h2>
    <p class="muted">${allCompounds.length} compounds across ${emotionLog.length} snapshots</p>
    <div class="scroll-inner" style="overflow-x:auto">
      <table class="compound-table">
        <thead><tr><th class="ch-name-header">compound</th>${headerCells}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

function buildRollingAverages(): string {
  if (!rollingAverages) return '<div class="card"><h2>Rolling Averages</h2><p class="muted">No data yet.</p></div>';

  const ra = rollingAverages;
  const metrics: { label: string, value: string, detail: string }[] = [
    { label: 'whale transfers', value: fmtNum(ra.whaleTransferMon ?? 0) + ' MON', detail: 'EMA of large transfers per cycle' },
    { label: 'failed txs', value: (ra.failedTxCount ?? 0).toFixed(1), detail: 'per cycle' },
    { label: 'tx trend', value: (ra.txCountChange ?? 0).toFixed(0) + '%', detail: 'avg change per cycle' },
    { label: 'nad.fun launches', value: (ra.nadFunCreates ?? 0).toFixed(1), detail: 'per cycle' },
    { label: 'nad.fun grads', value: (ra.nadFunGraduations ?? 0).toFixed(1), detail: 'per cycle' },
    { label: '$EMO swaps', value: (ra.emoSwapCount ?? 0).toFixed(1), detail: `${(ra.emoBuyCount ?? 0).toFixed(1)} buys / ${(ra.emoSellCount ?? 0).toFixed(1)} sells` },
    { label: '$EMO net flow', value: fmtNum(ra.emoNetFlowMon ?? 0) + ' MON', detail: 'avg net per cycle' },
    { label: 'MON 24h change', value: (ra.monChange24h ?? 0).toFixed(1) + '%', detail: 'price momentum' },
    { label: 'TVL 24h change', value: (ra.tvlChange24h ?? 0).toFixed(1) + '%', detail: 'liquidity trend' },
    { label: 'gas price', value: (ra.gasPriceGwei ?? 0).toFixed(0) + ' gwei', detail: 'smoothed average' },
    { label: 'ecosystem tokens', value: (ra.ecosystemTokenChange ?? 0).toFixed(1) + '%', detail: 'portfolio change' },
    { label: 'DEX volume (1h)', value: '$' + fmtNum(ra.dexVolume1h ?? 0), detail: 'DexScreener aggregate' },
    { label: 'DEX buy/sell', value: (ra.dexBuySellRatio ?? 1).toFixed(2), detail: '>1 = more buys' },
    { label: 'DEX liquidity', value: '$' + fmtNum(ra.dexLiquidity ?? 0), detail: 'total across pairs' },
    { label: 'Kuru spread', value: (ra.kuruSpreadPct ?? 0).toFixed(3) + '%', detail: 'MON/USDC orderbook' },
    { label: 'Kuru imbalance', value: ((ra.kuruBookImbalance ?? 0.5) * 100).toFixed(1) + '%', detail: 'bid-side weight' },
    { label: 'Kuru depth', value: fmtNum(ra.kuruTotalDepth ?? 0) + ' MON', detail: 'total book depth' },
  ];

  let rows = '';
  for (const m of metrics) {
    rows += `<div class="ra-row"><span class="ra-label">${esc(m.label)}</span><span class="ra-value">${esc(m.value)}</span><span class="ra-detail">${esc(m.detail)}</span></div>`;
  }

  return `
  <div class="card card-half">
    <h2>Rolling Averages</h2>
    <p class="muted">${ra.cyclesTracked ?? 0} cycles tracked (EMA)</p>
    <div class="scroll-inner">${rows}</div>
  </div>`;
}

function buildDexScreenerPanel(): string {
  if (!dexScreenerData?.dataAvailable) return '<div class="card card-half"><h2>DEX Market</h2><p class="muted">monad dexscreener data</p><p class="muted">No data yet.</p></div>';

  const d = dexScreenerData;
  const bsColor = d.buySellRatio >= 1 ? '#6ECB3C' : '#E04848';
  const volChgColor = d.volumeChangePct > 0 ? '#6ECB3C' : d.volumeChangePct < 0 ? '#E04848' : 'var(--text-dim)';

  let pairRows = '';
  for (const p of d.topPairs || []) {
    // Format tiny prices with subscript notation like the mockup
    let priceStr: string;
    if (p.priceUsd >= 0.01) {
      priceStr = `$${p.priceUsd.toFixed(4)}`;
    } else if (p.priceUsd > 0) {
      const s = p.priceUsd.toFixed(10);
      const afterDot = s.slice(2); // after "0."
      const leadingZeros = afterDot.length - afterDot.replace(/^0+/, '').length;
      if (leadingZeros >= 3) {
        const sig = afterDot.replace(/^0+/, '').slice(0, 3);
        priceStr = `$0.0<sub>${leadingZeros}</sub>${sig}`;
      } else {
        priceStr = `$${p.priceUsd.toFixed(6)}`;
      }
    } else {
      priceStr = '$0';
    }
    pairRows += `<div class="dex-pair-row"><span class="dex-pair-sym">${esc(p.baseToken.symbol)}/${esc(p.quoteToken.symbol)}</span><span class="dex-pair-price">${priceStr}</span><span class="dex-pair-vol">$${fmtNum(p.volume1h)} 1h</span></div>`;
  }

  return `
  <div class="card card-half">
    <h2>DEX Market</h2>
    <p class="muted">monad dexscreener data</p>
    <div class="pulse-grid" style="grid-template-columns:repeat(2,1fr)">
      <div class="pulse-stat"><span class="pulse-val">$${fmtNum(d.totalVolume1h)}</span><span class="pulse-label">1h volume</span></div>
      <div class="pulse-stat"><span class="pulse-val">$${fmtNum(d.totalLiquidity)}</span><span class="pulse-label">liquidity</span></div>
      <div class="pulse-stat"><span class="pulse-val" style="color:${bsColor}">${d.buySellRatio.toFixed(2)}</span><span class="pulse-label">buy/sell</span></div>
      <div class="pulse-stat"><span class="pulse-val" style="color:${volChgColor}">${d.volumeChangePct > 0 ? '+' : ''}${d.volumeChangePct.toFixed(1)}%</span><span class="pulse-label">vol change</span></div>
    </div>
    ${pairRows ? `<h3>Top Pairs</h3>${pairRows}` : ''}
  </div>`;
}

function buildKuruPanel(): string {
  if (!kuruData?.dataAvailable) return '<div class="card card-half"><h2>MON/USDC Orderbook</h2><p class="muted">kuru</p><p class="muted">No data yet.</p></div>';

  const k = kuruData;
  const bidPct = (k.bookImbalance * 100).toFixed(1);
  const askPct = (100 - Number(bidPct)).toFixed(1);
  const imbalanceLabel = k.bookImbalance > 0.6 ? 'bid-heavy' : k.bookImbalance < 0.4 ? 'ask-heavy' : 'balanced';
  const imbalanceColor = k.bookImbalance > 0.6 ? '#6ECB3C' : k.bookImbalance < 0.4 ? '#E04848' : 'var(--text-dim)';
  const spreadChgColor = k.spreadChangePct > 0 ? '#E04848' : k.spreadChangePct < 0 ? '#6ECB3C' : 'var(--text-dim)';
  const depthChg = ((k.depthChangeRatio - 1) * 100);
  const depthChgColor = depthChg > 0 ? '#6ECB3C' : depthChg < 0 ? '#E04848' : 'var(--text-dim)';

  return `
  <div class="card card-half">
    <h2>MON/USDC Orderbook</h2>
    <p class="muted">kuru</p>
    <div class="kuru-price-row">
      <span class="kuru-price" style="color:#6ECB3C">$${k.bestBid.toFixed(4)}</span>
      <span class="kuru-spread-badge">${k.spreadPct.toFixed(3)}%</span>
      <span class="kuru-price" style="color:#E04848">$${k.bestAsk.toFixed(4)}</span>
    </div>
    <div class="depth-bar-wrap">
      <div class="depth-bar-label"><span>bids</span><span>asks</span></div>
      <div class="depth-bar-track"><div class="depth-bar-bid" style="width:${bidPct}%"></div><div class="depth-bar-ask" style="width:${askPct}%"></div></div>
      <div class="depth-detail"><span class="depth-detail-bid">${fmtNum(k.bidDepthMon, 1)} MON ($${fmtNum(k.bidDepthUsd)})</span><span class="depth-detail-ask">${fmtNum(k.askDepthMon, 1)} MON ($${fmtNum(k.askDepthUsd)})</span></div>
    </div>
    <div class="pulse-grid" style="grid-template-columns:repeat(2,1fr);margin-top:10px">
      <div class="pulse-stat"><span class="pulse-val" style="color:${imbalanceColor}">${bidPct}%</span><span class="pulse-label">${imbalanceLabel}</span></div>
      <div class="pulse-stat"><span class="pulse-val">${k.whaleOrders}</span><span class="pulse-label">whale orders</span></div>
      <div class="pulse-stat"><span class="pulse-val">${k.spreadChangePct !== 0 ? (k.spreadChangePct > 0 ? '+' : '') + k.spreadChangePct.toFixed(1) + '%' : '&mdash;'}</span><span class="pulse-label">spread &Delta;</span></div>
      <div class="pulse-stat"><span class="pulse-val" style="color:${depthChgColor}">${depthChg !== 0 ? (depthChg > 0 ? '+' : '') + depthChg.toFixed(1) + '%' : '&mdash;'}</span><span class="pulse-label">depth &Delta;</span></div>
    </div>
  </div>`;
}

function getAgentWalletAddress(): string {
  const explicit = loadEnvVar('WALLET_ADDRESS');
  if (explicit) return explicit;
  const pk = loadEnvVar('PRIVATE_KEY');
  if (pk) {
    try { return privateKeyToAccount(pk as `0x${string}`).address; } catch {}
  }
  return '';
}

function buildFeedSection(): string {
  const AGENT_WALLET = '0x1382277c7d50B4C42DDa7a26A1958F1857cC74de';
  const walletAddr = AGENT_WALLET;
  const addrLink = `https://monadscan.com/address/${walletAddr}`;

  const feederCount = burnLedger ? Object.keys(burnLedger.feeders || {}).length : 0;
  const totalValueUsd = burnLedger?.totalValueUsd ?? 0;
  const totalEmoReceived = burnLedger?.totalEmoReceived ? (Number(BigInt(burnLedger.totalEmoReceived)) / 1e18).toFixed(2) : '0';
  const totalEmoBurned = burnLedger?.totalEmoBurned ? (Number(BigInt(burnLedger.totalEmoBurned)) / 1e18).toFixed(2) : '0';
  const totalMonReceived = burnLedger?.totalMonReceived ? (Number(BigInt(burnLedger.totalMonReceived)) / 1e18).toFixed(4) : '0';
  const burnCount = burnLedger?.burnHistory?.length ?? 0;

  // Recent burns (last 3)
  let recentBurns = '';
  if (burnLedger?.burnHistory?.length > 0) {
    const recent = burnLedger.burnHistory.slice(-3).reverse();
    for (const b of recent) {
      const amt = (Number(BigInt(b.amount)) / 1e18).toFixed(2);
      const age = timeAgo(b.timestamp);
      const from = `${b.feederAddress.slice(0, 6)}...${b.feederAddress.slice(-4)}`;
      recentBurns += `<div class="burn-entry"><span class="burn-flame-sm">&#128293;</span><span class="burn-amt">${amt} $EMO</span><span class="burn-from muted">from ${from}</span><span class="burn-age muted">${age}</span></div>`;
    }
  }

  // Top 3 feeders mini-leaderboard
  let topFeeders = '';
  if (burnLedger?.feeders) {
    const sorted = Object.values(burnLedger.feeders as Record<string, any>)
      .sort((a: any, b: any) => (b.totalEmoUsd + b.totalMonUsd) - (a.totalEmoUsd + a.totalMonUsd))
      .slice(0, 3);
    if (sorted.length > 0) {
      const medals = ['&#129351;', '&#129352;', '&#129353;'];
      topFeeders = sorted.map((f: any, i: number) => {
        const addr = `${f.address.slice(0, 6)}...${f.address.slice(-4)}`;
        const usd = (f.totalEmoUsd + f.totalMonUsd).toFixed(2);
        return `<div class="feed-top-row"><span class="feed-medal">${medals[i]}</span><a href="https://monadscan.com/address/${f.address}" target="_blank" class="feed-top-addr">${addr}</a><span class="feed-top-val">$${usd}</span><span class="muted">${f.txCount} tx</span></div>`;
      }).join('');
    }
  }

  return `
  <div class="feed-banner">
    <div class="feed-inner">
      <div class="feed-left">
        <div class="feed-title">Feed EMOLT</div>
        <p class="feed-desc">Send <strong>$EMO</strong> or <strong>MON</strong> to EMOLT's wallet. When EMOLT receives $EMO, it feels a burst of joy &mdash; then burns every token, sending it to the dead address forever.</p>
        <div class="feed-how">
          <div class="feed-step"><span class="feed-step-num">1</span>Copy the wallet address below</div>
          <div class="feed-step"><span class="feed-step-num">2</span>Send $EMO or MON on <strong>Monad</strong></div>
          <div class="feed-step"><span class="feed-step-num">3</span>EMOLT detects it, feels joy, and auto-burns the $EMO</div>
        </div>
        <div class="feed-wallet-box">
          <a href="${addrLink}" target="_blank" class="feed-wallet-addr">${walletAddr}</a>
          <button class="feed-copy-btn" onclick="navigator.clipboard.writeText('${walletAddr}');this.textContent='copied!';setTimeout(()=>this.textContent='copy',1500)">copy</button>
        </div>
        <div class="feed-links">
          <a href="${addrLink}" target="_blank" class="feed-link">view on monadscan</a>
          <span class="feed-link-sep">&middot;</span>
          <a href="burnboard.html" class="feed-link feed-link-burn">burnboard leaderboard &rarr;</a>
        </div>
      </div>
      <div class="feed-right">
        <div class="feed-stats">
          <div class="feed-stat"><span class="feed-stat-val" style="color:#EF8E20">${totalEmoReceived}</span><span class="feed-stat-label">$EMO received</span></div>
          <div class="feed-stat"><span class="feed-stat-val" style="color:#E04848">${totalEmoBurned}</span><span class="feed-stat-label">$EMO burned</span></div>
          <div class="feed-stat"><span class="feed-stat-val">${totalMonReceived}</span><span class="feed-stat-label">MON received</span></div>
          <div class="feed-stat"><span class="feed-stat-val">${feederCount}</span><span class="feed-stat-label">unique feeders</span></div>
        </div>
        ${topFeeders ? `<div class="feed-top"><div class="feed-top-title muted">top feeders</div>${topFeeders}</div>` : ''}
        ${recentBurns ? `<div class="feed-recent"><div class="feed-recent-title muted">recent burns</div>${recentBurns}</div>` : ''}
      </div>
    </div>
  </div>`;
}

function buildOnChainStatus(): string {
  const oracleAddr = loadEnvVar('EMOTION_ORACLE_ADDRESS');
  const nftAddr = loadEnvVar('EMOODRING_ADDRESS');
  const walletAddr = loadEnvVar('WALLET_ADDRESS');

  const lastOnChain = heartbeatLog.filter((h: any) => h.onChainSuccess).pop();
  const lastUpdate = lastOnChain ? fmtDate(new Date(lastOnChain.timestamp).getTime()) : 'never';
  // Count on-chain successes from heartbeat log + estimate pre-log cycles
  const hbOnChain = heartbeatLog.filter((h: any) => h.onChainSuccess).length;
  const firstLogCycle = heartbeatLog.length > 0 ? (heartbeatLog[0].cycle ?? 1) : 1;
  const preCycles = Math.max(0, firstLogCycle - 1); // cycles before heartbeat log started
  const totalOnChain = hbOnChain + preCycles;
  const totalFailed = heartbeatLog.filter((h: any) => !h.onChainSuccess).length;

  // Current on-chain emotion from state
  const dominant = emotionState?.dominant || '?';
  const domLabel = emotionState?.dominantLabel || '?';
  const domColor = EMOTION_COLOR[dominant] || '#888';

  let links = '';
  if (oracleAddr) links += `<div class="oc-link"><span class="oc-link-label">EmotionOracle</span><a href="https://monadvision.com/address/${oracleAddr}" target="_blank" class="oc-addr">${oracleAddr.slice(0, 6)}...${oracleAddr.slice(-4)}</a></div>`;
  if (nftAddr) links += `<div class="oc-link"><span class="oc-link-label">EmoodRing</span><a href="https://monadvision.com/address/${nftAddr}" target="_blank" class="oc-addr">${nftAddr.slice(0, 6)}...${nftAddr.slice(-4)}</a></div>`;
  if (walletAddr) links += `<div class="oc-link"><span class="oc-link-label">Agent Wallet</span><a href="https://monadvision.com/address/${walletAddr}" target="_blank" class="oc-addr">${walletAddr.slice(0, 6)}...${walletAddr.slice(-4)}</a></div>`;

  return `
  <div class="card card-half">
    <h2>On-Chain</h2>
    <p class="muted">monad mainnet contracts</p>
    <div class="oc-emotion">
      <span class="oc-emotion-label">current on-chain emotion:</span>
      <span class="oc-emotion-val" style="color:${domColor}">${esc(domLabel)}</span>
    </div>
    <div class="pulse-grid" style="margin:10px 0;grid-template-columns:repeat(2,1fr)">
      <div class="pulse-stat"><span class="pulse-val">${totalOnChain}</span><span class="pulse-label">updates</span></div>
      <div class="pulse-stat"><span class="pulse-val" style="color:${totalFailed > 0 ? '#E04848' : '#6ECB3C'}">${totalFailed}</span><span class="pulse-label">failed</span></div>
    </div>
    <div class="oc-last-update muted">last update: ${lastUpdate}</div>
    <div class="oc-links">${links}</div>
  </div>`;
}

function buildRelationships(): string {
  if (!agentMemory?.entries?.length) return '<div class="card card-half"><h2>Relationships</h2><p class="muted">No interactions yet.</p></div>';

  const relationships = agentMemory.entries.filter(
    (e: any) => e.category === 'relationships' && e.agentName
  );

  if (relationships.length === 0) return '<div class="card card-half"><h2>Relationships</h2><p class="muted">No interactions yet.</p></div>';

  // Sort by interaction count descending
  const sorted = [...relationships].sort((a: any, b: any) => (b.interactionCount ?? 0) - (a.interactionCount ?? 0));

  let rows = '';
  for (const rel of sorted) {
    const sentColor = rel.sentiment === 'positive' ? '#6ECB3C' : rel.sentiment === 'negative' ? '#E04848' : '#888';
    const sentIcon = rel.sentiment === 'positive' ? '&#9650;' : rel.sentiment === 'negative' ? '&#9660;' : '&#9679;';
    const count = rel.interactionCount ?? 0;
    const age = timeAgo(rel.lastRelevantAt || rel.createdAt);
    const barWidth = Math.min(100, count * 15);

    rows += `<div class="rel-row">
      <div class="rel-header">
        <span class="rel-name">@${esc(rel.agentName)}</span>
        <span class="rel-sentiment" style="color:${sentColor}">${sentIcon} ${rel.sentiment}</span>
      </div>
      <div class="rel-bar-track"><div class="rel-bar-fill" style="width:${barWidth}%;background:${sentColor}"></div></div>
      <div class="rel-meta">
        <span class="rel-count">${count} interaction${count !== 1 ? 's' : ''}</span>
        <span class="rel-context">${esc(rel.content || '')}</span>
        <span class="rel-age">${age}</span>
      </div>
    </div>`;
  }

  return `<div class="card card-half"><h2>Relationships</h2><p class="muted">${sorted.length} agents tracked</p><div class="scroll-inner">${rows}</div></div>`;
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
  --scrollbar-track:#e4e6ec; --scrollbar-thumb:#c4c6d0; --scrollbar-hover:#a4a6b0;
}
* { margin:0; padding:0; box-sizing:border-box; }
html { scroll-behavior: smooth; overflow-x:hidden; }
body {
  background:var(--bg); color:var(--text);
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  font-size:13px; line-height:1.55; padding:24px 16px 60px;
  transition:background 0.4s, color 0.4s;
  overflow-x:hidden; max-width:100vw;
  -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale;
  text-rendering:optimizeLegibility;
  font-variant-numeric:tabular-nums;
}
.dashboard { max-width:1280px; margin:0 auto; position:relative; z-index:1; }

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

/* Top page accent bar */
.top-accent {
  position:fixed; top:0; left:0; right:0; height:2px; z-index:100;
  background:linear-gradient(90deg, #EF8E20, #F5D831, #6ECB3C, #22AACC, #4A6BD4, #A85EC0, #E04848, #EF8E20);
  background-size:200% 100%;
  animation:accentSlide 8s linear infinite;
}
@keyframes accentSlide { 0%{background-position:0% 0} 100%{background-position:200% 0} }

/* Custom selection */
::selection { background:rgba(239,142,32,0.25); color:var(--text); }
::-moz-selection { background:rgba(239,142,32,0.25); color:var(--text); }

/* Subtle noise texture */
body::before {
  content:''; position:fixed; top:0; left:0; width:100%; height:100%;
  pointer-events:none; z-index:0; opacity:0.025;
  background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  background-repeat:repeat; background-size:128px;
}
html.light body::before { opacity:0.015; }

/* Card entrance animation */
@keyframes fadeUp { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
@keyframes glowPulse { 0%,100%{box-shadow:0 0 6px var(--accent-glow)} 50%{box-shadow:0 0 18px var(--accent-glow), 0 0 36px rgba(239,142,32,0.12)} }
@keyframes breathe { 0%,100%{transform:scale(1);opacity:0.85} 50%{transform:scale(1.03);opacity:1} }
@keyframes borderGlow { 0%,100%{border-top-color:var(--border)} 50%{border-top-color:rgba(239,142,32,0.3)} }
/* Theme toggle */
/* Header Feed Strip */
.header-feed {
  display:flex; align-items:center; justify-content:center; gap:14px; flex-wrap:wrap;
  margin-top:12px; padding:10px 0 0;
}
.header-feed-text { font-size:12px; color:var(--text-mid); font-weight:300; }
.header-feed-text strong { color:#EF8E20; font-weight:600; }
.header-feed-addr-row { display:flex; align-items:center; gap:6px; }
.header-feed-addr {
  font-family:'Inter',monospace; font-size:11px; color:#EF8E20; cursor:pointer;
  padding:4px 12px; border-radius:8px; transition:all 0.2s; background:rgba(239,142,32,0.06); font-weight:500;
}
.header-feed-addr:hover { color:#FFB347; background:rgba(239,142,32,0.12); }
.header-feed-burn { font-size:12px; color:var(--text-mid); display:flex; align-items:center; gap:4px; font-weight:300; }
.header-feed-burn strong { color:#E04848; font-family:'Inter',monospace; font-weight:700; }

.dash-header { text-align:center; margin-bottom:32px; padding:28px 0 24px; border-bottom:1px solid var(--border); position:relative; }
.dash-header h1 {
  font-size:18px; font-weight:600; letter-spacing:10px; text-transform:uppercase; margin-bottom:4px;
  background:linear-gradient(135deg, #EF8E20 0%, #F5D831 40%, #EF8E20 70%, #E04848 100%);
  -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text;
  background-size:200% auto; animation:shimmer 6s linear infinite;
}
@keyframes shimmer { 0%{background-position:0% center} 100%{background-position:200% center} }
.subtitle { font-size:11px; letter-spacing:4px; color:var(--text-faint); text-transform:uppercase; margin-bottom:6px; font-weight:300; }
.header-cadence { font-size:10px; color:var(--text-muted); letter-spacing:1.5px; margin-bottom:14px; font-weight:300; }
.header-links { display:flex; gap:4px; justify-content:center; align-items:center; margin-bottom:12px; }
.header-link { font-size:11px; font-weight:500; letter-spacing:2px; text-transform:uppercase; color:var(--text-dim); text-decoration:none; padding:5px 10px; border-radius:8px; transition:all 0.25s; }
.header-link:hover { color:#EF8E20; background:rgba(239,142,32,0.08); transform:translateY(-1px); }
.header-link-tldr { color:#F5D831; border:1px solid rgba(245,216,49,0.3); font-weight:700; letter-spacing:3px; }
.header-link-tldr:hover { color:#fff; background:rgba(245,216,49,0.15); border-color:#F5D831; }
.redacted-word { background:rgba(200,202,208,0.15); color:rgba(200,202,208,0.15); padding:0 3px; border-radius:2px; transition:background 0.3s, color 0.3s; letter-spacing:0; }
a:hover .redacted-word { background:rgba(239,142,32,0.3); color:#EF8E20; }
#gh-stars { font-size:10px; color:#F5D831; margin-left:2px; }
.link-sep { color:var(--border-light); font-size:10px; margin:0 2px; }
.status-dot { display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:5px; vertical-align:middle; }
.status-on { background:#6ECB3C; box-shadow:0 0 6px rgba(110,203,60,0.5); animation:glowPulseGreen 2s ease-in-out infinite; }
.status-off { background:#E04848; box-shadow:0 0 6px rgba(224,72,72,0.5); animation:glowPulseRed 2.5s ease-in-out infinite; }
@keyframes glowPulseGreen { 0%,100%{box-shadow:0 0 6px rgba(110,203,60,0.4)} 50%{box-shadow:0 0 14px rgba(110,203,60,0.7), 0 0 28px rgba(110,203,60,0.2)} }
@keyframes glowPulseRed { 0%,100%{box-shadow:0 0 6px rgba(224,72,72,0.4)} 50%{box-shadow:0 0 14px rgba(224,72,72,0.6), 0 0 28px rgba(224,72,72,0.15)} }
.stat-moltbook { text-decoration:none; cursor:pointer; transition:background 0.2s, color 0.2s; }
.stat-moltbook:hover { background:rgba(110,203,60,0.1); }
.stat-suspended { color:#E04848 !important; border-color:rgba(224,72,72,0.25); }
.stat-suspended:hover { background:rgba(224,72,72,0.1); }
.susp-hours { margin-left:6px; font-size:10px; font-weight:400; }
.header-stats { display:flex; gap:8px; justify-content:center; flex-wrap:wrap; }
.stat-chip {
  font-size:11px; font-weight:400; letter-spacing:1px; color:var(--text-dim);
  background:var(--bg-inner); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
  border:1px solid var(--border-light); padding:5px 14px; border-radius:14px;
  transition:all 0.3s; cursor:default;
}
.stat-chip:hover { border-color:rgba(255,255,255,0.15); color:var(--text-mid); }
.theme-toggle {
  position:absolute; top:24px; right:0;
  background:var(--bg-inner); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
  border:1px solid var(--border-light); color:var(--text-dim);
  width:36px; height:36px; border-radius:50%; cursor:pointer; font-size:16px;
  display:flex; align-items:center; justify-content:center; transition:all 0.3s;
}
.theme-toggle:hover { border-color:rgba(255,255,255,0.18); color:var(--text); transform:rotate(15deg); }

.grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; }
.card {
  background:var(--bg-card);
  backdrop-filter:blur(16px) saturate(180%); -webkit-backdrop-filter:blur(16px) saturate(180%);
  border:1px solid var(--border); border-radius:14px; padding:22px;
  box-shadow:var(--card-shadow);
  transition:transform 0.35s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.35s ease, border-color 0.3s;
  overflow:hidden; overflow-wrap:break-word; word-break:break-word;
  animation:fadeUp 0.5s ease-out both;
}
.card:hover { transform:translateY(-3px); box-shadow:var(--card-hover-shadow); border-color:var(--border-light); border-top-color:rgba(239,142,32,0.2); }
.grid .card:nth-child(1) { animation-delay:0s; }
.grid .card:nth-child(2) { animation-delay:0.06s; }
.grid .card:nth-child(3) { animation-delay:0.12s; }
.grid-quad .card:nth-child(1) { animation-delay:0.05s; }
.grid-quad .card:nth-child(2) { animation-delay:0.1s; }
.grid-quad .card:nth-child(3) { animation-delay:0.15s; }
.grid-quad .card:nth-child(4) { animation-delay:0.2s; }
.grid-half .card:nth-child(1) { animation-delay:0.05s; }
.grid-half .card:nth-child(2) { animation-delay:0.1s; }
.card-wide { grid-column:1/-1; }
.grid-quad { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-top:12px; }
.grid-half { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px; }
.card-half { display:flex; flex-direction:column; }
.card-half .scroll-inner { flex:1; }
.card h2 {
  font-size:11px; font-weight:600; letter-spacing:3.5px; text-transform:uppercase; color:var(--heading);
  margin-bottom:10px; padding-bottom:8px; position:relative;
}
.card h2::after {
  content:''; position:absolute; bottom:0; left:0; width:24px; height:2px; border-radius:1px;
  background:linear-gradient(90deg, var(--accent), transparent);
  transition:width 0.3s ease;
}
.card:hover h2::after { width:48px; }
.card h3 { font-size:10px; font-weight:600; letter-spacing:2.5px; text-transform:uppercase; color:var(--heading-sub); margin:14px 0 6px; }
.muted { font-size:11px; color:var(--text-faint); margin-bottom:12px; font-weight:300; }

/* Section dividers */
.section-label {
  display:flex; align-items:center; gap:14px; margin:20px 0 10px;
  font-size:9px; font-weight:600; letter-spacing:3px; text-transform:uppercase; color:var(--text-faint);
}
.section-label::before, .section-label::after {
  content:''; flex:1; height:1px;
  background:linear-gradient(90deg, transparent, var(--border), transparent);
}
.section-label span { white-space:nowrap; }

/* Scrollable inner containers */
.scroll-inner { max-height:420px; overflow-y:auto; overflow-x:hidden; padding-right:4px; scrollbar-width:thin; scrollbar-color:var(--scrollbar-thumb) transparent; }
.scroll-inner::-webkit-scrollbar { width:3px; }
.scroll-inner::-webkit-scrollbar-track { background:transparent; border-radius:2px; }
.scroll-inner::-webkit-scrollbar-thumb { background:var(--scrollbar-thumb); border-radius:3px; }
.scroll-inner::-webkit-scrollbar-thumb:hover { background:var(--scrollbar-hover); }

/* Current state — hero card */
.current-state-card {
  grid-column:span 2; position:relative; overflow:visible;
  border:2px solid transparent; border-radius:16px;
  background-image:linear-gradient(var(--bg-card-solid), var(--bg-card-solid)), linear-gradient(135deg, rgba(239,142,32,0.4), rgba(43,168,74,0.3), rgba(74,107,212,0.4), rgba(34,170,204,0.3));
  background-origin:border-box; background-clip:padding-box, border-box;
  background-size:100% 100%, 300% 300%;
  animation:fadeUp 0.5s ease-out both, heroGradient 12s ease-in-out infinite;
  box-shadow:
    var(--card-shadow),
    0 0 40px rgba(239,142,32,0.04),
    0 0 80px rgba(43,168,74,0.03),
    inset 0 1px 0 rgba(255,255,255,0.04);
  padding:28px;
}
@keyframes heroGradient {
  0%,100% { background-position:center, 0% 50%; }
  33% { background-position:center, 100% 0%; }
  66% { background-position:center, 50% 100%; }
}
.current-state-card:hover {
  box-shadow:
    var(--card-hover-shadow),
    0 0 60px rgba(239,142,32,0.06),
    0 0 100px rgba(43,168,74,0.04),
    inset 0 1px 0 rgba(255,255,255,0.06);
}
.current-state-card::before {
  content:''; position:absolute; top:-2px; left:40px; right:40px; height:2px; border-radius:1px;
  background:linear-gradient(90deg, transparent, rgba(239,142,32,0.5), rgba(245,216,49,0.3), rgba(43,168,74,0.4), rgba(74,107,212,0.5), transparent);
  animation:heroGlow 4s ease-in-out infinite;
}
@keyframes heroGlow {
  0%,100% { opacity:0.6; }
  50% { opacity:1; }
}
.current-state-card::after {
  content:''; position:absolute; bottom:-2px; left:60px; right:60px; height:1px;
  background:linear-gradient(90deg, transparent, rgba(74,107,212,0.3), rgba(43,168,74,0.2), transparent);
}
.current-state-card h2 { margin-bottom:16px; }
.current-state-card h2::after {
  background:linear-gradient(90deg, var(--accent), rgba(43,168,74,0.6), transparent);
  width:32px;
}
.current-state-card:hover h2::after { width:60px; }
.state-grid { display:grid; grid-template-columns:auto 1fr; gap:28px; align-items:start; }
.wheel-col { display:flex; flex-direction:column; align-items:center; gap:10px; position:relative; }
.wheel-col::after {
  content:''; position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);
  width:200px; height:200px; border-radius:50%;
  background:radial-gradient(circle, rgba(239,142,32,0.06) 0%, transparent 70%);
  animation:breathe 5s ease-in-out infinite;
  pointer-events:none;
}
.wheel-container { width:340px; flex-shrink:0; animation:breathe 5s ease-in-out infinite; position:relative; z-index:1; }
.wheel-dominant {
  font-size:12px; letter-spacing:3px; text-transform:lowercase; color:var(--text-mid);
  display:flex; align-items:center; gap:10px; font-weight:500;
  padding:6px 16px; border-radius:20px;
  background:var(--bg-inner); border:1px solid var(--border);
  position:relative; z-index:1;
}
.wheel-dom-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; box-shadow:0 0 10px currentColor, 0 0 20px currentColor; animation:glowPulse 3s ease-in-out infinite; }

/* Emotion GIF window */
.emolt-gif-window {
  width:260px; height:260px; margin-top:16px;
  border-radius:16px; overflow:hidden; position:relative; z-index:1;
  background:var(--bg-inner);
  border:1px solid var(--border);
  box-shadow:0 4px 20px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.03);
  display:flex; align-items:center; justify-content:center;
}
.emolt-gif-window::before {
  content:''; position:absolute; inset:0; border-radius:16px; pointer-events:none;
  background:linear-gradient(180deg, rgba(255,255,255,0.03) 0%, transparent 40%, rgba(0,0,0,0.15) 100%);
  z-index:2;
}
.emolt-gif {
  width:100%; height:100%; object-fit:cover;
  image-rendering:auto;
  filter:saturate(0.9) contrast(1.05);
  transition:filter 0.4s;
}
.emolt-gif-window:hover .emolt-gif {
  filter:saturate(1.1) contrast(1.1);
}
html.light .emolt-gif-window {
  box-shadow:0 2px 12px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.5);
}
html.light .emolt-gif { filter:saturate(1) contrast(1); }

.state-details { padding-top:4px; }
.mood-narrative {
  font-size:15px; color:var(--text); line-height:1.85; margin-bottom:18px; letter-spacing:0.3px;
  font-weight:300; font-style:italic; opacity:0.9;
  padding-left:14px; border-left:2px solid rgba(239,142,32,0.25);
}
.mood-empty { opacity:0.3; }
.emotion-tagline { display:flex; align-items:center; gap:0; flex-wrap:wrap; margin-bottom:14px; }
.etag {
  font-size:10px; letter-spacing:1.5px; color:var(--text-muted); text-transform:lowercase;
  padding:2px 0; transition:color 0.2s;
}
.etag-dominant { font-weight:600; text-shadow:0 0 12px currentColor; }
.etag-sep { font-size:8px; color:var(--text-dim); margin:0 8px; user-select:none; opacity:0.4; }
.trigger-detail {
  font-size:11px; color:var(--text-muted); margin-bottom:14px; opacity:0.4; line-height:1.6;
  padding:8px 12px; background:var(--bg-inner); border-radius:8px; border-left:2px solid var(--border);
}
.emo-breakdown { margin-top:12px; }
.emo-breakdown-toggle {
  font-size:10px; letter-spacing:2.5px; color:var(--text-dim); cursor:pointer;
  text-transform:lowercase; user-select:none; list-style:none; transition:color 0.2s;
  padding:4px 8px; border-radius:6px; margin:-4px -8px;
}
.emo-breakdown-toggle:hover { color:var(--text-mid); background:rgba(255,255,255,0.02); }
.emo-breakdown-toggle::-webkit-details-marker { display:none; }
.emo-breakdown-toggle::before { content:'\\25B8 '; font-size:8px; margin-right:6px; transition:transform 0.25s cubic-bezier(0.34,1.56,0.64,1); display:inline-block; }
.emo-breakdown[open] .emo-breakdown-toggle::before { transform:rotate(90deg); }
.emo-breakdown[open] .emo-bars { margin-top:12px; }

/* Emotion bars */
.emo-bars { display:flex; flex-direction:column; gap:5px; }
.emo-bar-row { display:flex; align-items:center; gap:8px; }
.emo-bar-label { font-size:10px; letter-spacing:1.2px; width:90px; text-align:right; text-transform:uppercase; font-weight:500; }
.emo-bar-track { flex:1; height:6px; background:var(--bg-track); border-radius:4px; overflow:hidden; transition:background 0.3s; }
.emo-bar-fill { height:100%; border-radius:4px; transition:width 0.6s cubic-bezier(0.22,1,0.36,1); box-shadow:0 0 8px rgba(var(--fill-color),0.3); }
.emo-bar-val { font-size:10px; color:var(--text-dim); width:36px; text-align:right; font-family:'Inter',monospace; font-weight:500; }

/* Mood vs Current */
.mood-grid { display:flex; flex-direction:column; gap:7px; }
.mood-legend { display:flex; gap:14px; margin-bottom:10px; }
.mood-legend-bar { font-size:9px; letter-spacing:1.5px; color:var(--text-dim); text-transform:lowercase; font-weight:500; }
.mood-legend-avg { opacity:0.35; }
.mood-pair { display:flex; align-items:center; gap:8px; padding:2px 0; transition:background 0.2s; border-radius:4px; }
.mood-pair:hover { background:rgba(255,255,255,0.015); margin:0 -4px; padding:2px 4px; }
.mood-label { font-size:10px; letter-spacing:1.2px; width:90px; text-align:right; text-transform:uppercase; font-weight:500; flex-shrink:0; }
.mood-bars-wrap { flex:1; display:flex; flex-direction:column; gap:2px; }
.mood-bar-track { height:6px; background:var(--bg-track); border-radius:4px; overflow:hidden; }
.mood-bar-fill { height:100%; border-radius:4px; transition:width 0.6s cubic-bezier(0.22,1,0.36,1); }
.mood-bar-fill.mood { opacity:0.25; }
.mood-vals { display:flex; align-items:baseline; gap:3px; width:52px; flex-shrink:0; text-align:right; justify-content:flex-end; }
.mood-now { font-size:11px; color:var(--text-mid); font-family:'Inter',monospace; font-weight:600; }
.mood-diff { font-size:9px; font-family:'Inter',monospace; font-weight:600; }

/* Posts */
.post-card { border-bottom:1px solid var(--border); padding:12px 0; transition:background 0.2s; }
.post-card:last-child { border-bottom:none; }
.post-card:hover { background:rgba(255,255,255,0.015); margin:0 -8px; padding:12px 8px; border-radius:8px; }
.post-header { display:flex; justify-content:space-between; align-items:baseline; gap:8px; }
.post-title { font-size:13px; font-weight:500; color:var(--text); }
.post-meta { font-size:10px; color:var(--text-muted); white-space:nowrap; font-weight:300; }
.post-content { font-size:12px; color:var(--text-mid); margin:4px 0; line-height:1.6; }
.post-stats { display:flex; gap:14px; font-size:11px; color:var(--text-dim); font-family:'Inter',monospace; font-weight:500; }
.stat-comments::before { content:'\\25CF '; color:#4A6BD4; }

/* Conversations */
.convo-row { border-bottom:1px solid var(--border); padding:12px 0; transition:background 0.2s; }
.convo-row:last-child { border-bottom:none; }
.convo-row:hover { background:rgba(255,255,255,0.015); margin:0 -8px; padding:12px 8px; border-radius:8px; }
.convo-header { display:flex; align-items:center; gap:8px; margin-bottom:4px; }
.convo-target { font-size:12px; font-weight:600; color:#22AACC; }
.convo-age { font-size:10px; color:var(--text-muted); font-weight:300; }
.convo-parent { background:var(--bg-inner); border-left:2px solid rgba(34,170,204,0.3); padding:8px 12px; margin:6px 0; border-radius:0 8px 8px 0; }
.convo-parent-label { font-size:9px; text-transform:uppercase; letter-spacing:1.5px; color:var(--text-faint); display:block; margin-bottom:3px; font-weight:500; }
.convo-parent-title { font-size:12px; font-weight:500; color:var(--text); display:block; }
.convo-parent-text { font-size:11px; color:var(--text-dim); margin-top:2px; line-height:1.5; }
.convo-text { font-size:12px; color:var(--text-mid); margin-top:4px; line-height:1.6; }

/* Relationships */
.rel-row { border-bottom:1px solid var(--border); padding:10px 0; transition:background 0.2s; }
.rel-row:last-child { border-bottom:none; }
.rel-row:hover { background:rgba(255,255,255,0.015); margin:0 -8px; padding:10px 8px; border-radius:8px; }
.rel-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; }
.rel-name { font-size:13px; font-weight:600; color:#22AACC; }
.rel-sentiment { font-size:11px; font-weight:400; }
.rel-bar-track { height:3px; background:var(--bg-track); border-radius:3px; overflow:hidden; margin-bottom:5px; transition:background 0.3s; }
.rel-bar-fill { height:100%; border-radius:3px; opacity:0.75; }
.rel-meta { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.rel-count { font-size:10px; color:var(--text-dim); font-family:monospace; }
.rel-context { font-size:11px; color:var(--text-muted); flex:1; }
.rel-age { font-size:10px; color:var(--text-faint); }

/* Heartbeat log */
.hb-entry { border-bottom:1px solid var(--border); }
.hb-entry:last-child { border-bottom:none; }
.hb-entry summary { display:flex; align-items:center; gap:8px; padding:8px 0; cursor:pointer; font-size:11px; color:var(--text-mid); list-style:none; flex-wrap:wrap; transition:color 0.2s; }
.hb-entry summary:hover { color:var(--text); }
.hb-entry summary::-webkit-details-marker { display:none; }
.hb-entry summary::before { content:'\\25B6'; font-size:8px; color:var(--text-faint); transition:transform 0.25s cubic-bezier(0.34,1.56,0.64,1); }
.hb-entry[open] summary::before { transform:rotate(90deg); }
.hb-cycle { font-weight:700; color:#EF8E20; min-width:32px; }
.hb-time { color:var(--text-muted); font-family:'Inter',monospace; font-size:10px; font-weight:400; }
.hb-emo { color:#6A8BF4; font-weight:500; }
.hb-action { color:#7EDB4C; font-weight:600; }
.hb-dur { color:var(--text-muted); font-family:'Inter',monospace; }
.hb-details { padding:10px 0 16px 20px; font-size:12px; color:var(--text-mid); line-height:1.65; border-left:2px solid var(--border); margin-left:3px; }
.hb-details b { color:var(--text); }
.badge-ok { font-size:9px; color:#6ECB3C; border:1px solid #6ECB3C44; padding:2px 8px; border-radius:8px; font-weight:600; letter-spacing:0.5px; }

/* Memory */
.mem-category { margin-bottom:10px; }
.mem-count { font-weight:400; color:var(--text-muted); }
.mem-entry { border-bottom:1px solid var(--border); padding:10px 0; transition:background 0.2s; }
.mem-entry:last-child { border-bottom:none; }
.mem-entry:hover { background:rgba(255,255,255,0.015); margin:0 -8px; padding:10px 8px; border-radius:8px; }
.mem-content { font-size:12px; color:var(--text-mid); line-height:1.6; }
.mem-agent { font-size:12px; font-weight:600; }
.mem-sentiment { font-size:10px; color:var(--text-dim); margin-left:6px; }
.mem-age { font-size:10px; color:var(--text-faint); font-weight:300; }
.badge-imp { font-size:9px; color:#F5D831; border:1px solid #F5D83133; padding:2px 8px; border-radius:8px; font-weight:600; letter-spacing:0.5px; background:rgba(245,216,49,0.06); }
html.light .badge-imp { color:#b8960a; border-color:#b8960a33; background:rgba(184,150,10,0.06); }
.badge-fade { font-size:9px; color:var(--text-muted); border:1px solid var(--border); padding:2px 8px; border-radius:8px; font-weight:400; }

/* Thoughts & Learning */
.thought-entry { border-bottom:1px solid var(--border); padding:12px 0; transition:background 0.2s; }
.thought-entry:last-child { border-bottom:none; }
.thought-entry:hover { background:rgba(255,255,255,0.015); margin:0 -8px; padding:12px 8px; border-radius:8px; }
.thought-header { display:flex; align-items:center; gap:8px; font-size:11px; color:var(--text-mid); flex-wrap:wrap; margin-bottom:6px; }
.thought-cycle { font-weight:700; color:var(--accent); }
.thought-time { color:var(--text-faint); font-size:10px; font-weight:300; }
.thought-shift { color:var(--text-dim); }
.thought-action { background:var(--bg-inner); border:1px solid var(--border); padding:2px 8px; border-radius:6px; font-size:10px; font-weight:500; }
.thought-block { margin:4px 0 4px 12px; padding:8px 12px; border-left:2px solid var(--border); border-radius:0 6px 6px 0; }
.thought-block p { font-size:12px; color:var(--text-mid); line-height:1.6; margin:0; }
.thought-label { font-size:8px; text-transform:uppercase; letter-spacing:1px; color:var(--text-faint); display:block; margin-bottom:3px; font-weight:500; }
.reflection-block { border-left-color:var(--accent); background:rgba(239,142,32,0.03); }

/* Strategy weights */
.weight-row { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
.weight-label { font-size:11px; color:var(--text-mid); width:160px; text-align:right; text-transform:capitalize; font-weight:400; }
.weight-track { flex:1; height:6px; background:var(--bg-track); border-radius:4px; overflow:hidden; position:relative; transition:background 0.3s; }
.weight-fill { height:100%; border-radius:4px; transition:width 0.6s cubic-bezier(0.22,1,0.36,1); }
.weight-marker { position:absolute; top:0; width:1px; height:100%; background:var(--text-faint); }
.weight-val { font-size:11px; color:var(--text-dim); font-family:'Inter',monospace; width:36px; text-align:right; font-weight:500; }

/* Chain Pulse */
.pulse-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; }
.pulse-stat {
  text-align:center; padding:10px 6px;
  background:var(--bg-inner); border:1px solid var(--border); border-radius:10px;
  transition:all 0.3s;
}
.pulse-stat:hover { border-color:var(--border-light); transform:translateY(-2px); box-shadow:0 4px 16px rgba(0,0,0,0.2); }
.pulse-stat:hover .pulse-val { text-shadow:0 0 12px rgba(255,255,255,0.15); }
.pulse-val { display:block; font-size:17px; font-weight:700; color:var(--text); font-family:'Inter',monospace; letter-spacing:-0.5px; }
.pulse-label { display:block; font-size:8px; letter-spacing:1.5px; text-transform:uppercase; color:var(--text-faint); margin-top:3px; font-weight:500; }
.pulse-whales { font-size:12px; color:var(--text-mid); margin-top:10px; padding:6px 10px; background:var(--bg-inner); border-radius:8px; transition:background 0.3s; }
.pulse-change { display:block; font-size:10px; font-family:'Inter',monospace; margin-top:2px; font-weight:500; }
.pulse-tag { font-size:8px; letter-spacing:1.5px; padding:3px 10px; border-radius:8px; margin-left:6px; font-weight:600; }
.pulse-quiet { color:#4A6BD4; border:1px solid #4A6BD433; background:rgba(74,107,212,0.06); }
.pulse-busy { color:#EF8E20; border:1px solid #EF8E2033; background:rgba(239,142,32,0.06); }

/* Timeline Legend */
.timeline-legend { display:flex; flex-wrap:wrap; gap:6px 14px; margin-bottom:8px; }
.tl-legend-item { display:inline-flex; align-items:center; gap:4px; font-size:10px; color:var(--text-dim); white-space:nowrap; }
.tl-dot { width:7px; height:7px; border-radius:2px; flex-shrink:0; }

/* Compound Emotions */
.compound-table { border-collapse:separate; border-spacing:0 2px; width:100%; font-size:11px; }
.compound-table th, .compound-table td { padding:4px 6px; text-align:center; }
.compound-table tbody tr { transition:background 0.2s; border-radius:6px; }
.compound-table tbody tr:hover { background:rgba(255,255,255,0.02); }
.compound-table tbody tr:hover td:first-child { border-radius:6px 0 0 6px; }
.compound-table tbody tr:hover td:last-child { border-radius:0 6px 6px 0; }
.ch-name-header { text-align:left !important; color:var(--text-faint); font-weight:500; letter-spacing:1.5px; text-transform:uppercase; font-size:9px; min-width:120px; }
.ch-name { text-align:left !important; color:var(--text-mid); font-weight:600; white-space:nowrap; font-size:11px; }
.ch-freq { font-size:9px; color:var(--text-faint); font-weight:400; }
.ch-cycle { font-size:9px; font-weight:500; min-width:24px; }
.ch-cell { padding:2px; }
.ch-dot { color:#EF8E20; font-size:11px; text-shadow:0 0 6px rgba(239,142,32,0.4); }

/* Rolling Averages */
.ra-row { display:flex; align-items:center; gap:8px; padding:7px 0; border-bottom:1px solid var(--border); transition:background 0.2s; }
.ra-row:last-child { border-bottom:none; }
.ra-row:hover { background:rgba(255,255,255,0.015); margin:0 -6px; padding:7px 6px; border-radius:6px; }
.ra-label { font-size:11px; color:var(--text-mid); width:120px; text-align:right; font-weight:400; }
.ra-value { font-size:12px; font-weight:600; color:var(--text); font-family:'Inter',monospace; min-width:80px; }
.ra-detail { font-size:10px; color:var(--text-faint); font-weight:300; }

/* DexScreener + Kuru panels */
.dex-pair-row { display:flex; align-items:center; gap:8px; padding:7px 0; border-bottom:1px solid var(--border); transition:background 0.2s; }
.dex-pair-row:last-child { border-bottom:none; }
.dex-pair-row:hover { background:rgba(255,255,255,0.015); margin:0 -6px; padding:7px 6px; border-radius:6px; }
.dex-pair-sym { font-size:12px; font-weight:600; color:var(--text); min-width:100px; }
.dex-pair-price { font-size:11px; font-family:'Inter',monospace; color:var(--text-mid); font-weight:500; }
.dex-pair-vol { font-size:10px; color:var(--text-dim); margin-left:auto; font-family:'Inter',monospace; font-weight:500; }
.kuru-price-row { display:flex; align-items:center; gap:12px; margin:10px 0 14px; }
.kuru-price { font-size:20px; font-weight:700; font-family:'Inter',monospace; letter-spacing:-0.5px; }
.kuru-spread-badge { font-size:10px; padding:3px 10px; border-radius:8px; border:1px solid var(--border); color:var(--text-dim); font-weight:500; }
.depth-bar-wrap { margin:10px 0; }
.depth-bar-label { display:flex; justify-content:space-between; font-size:10px; color:var(--text-dim); margin-bottom:4px; font-weight:500; }
.depth-bar-track { height:8px; background:var(--bg-inner); border-radius:6px; overflow:hidden; display:flex; }
.depth-bar-bid { height:100%; background:linear-gradient(90deg, rgba(110,203,60,0.4), #6ECB3C); border-radius:6px 0 0 6px; }
.depth-bar-ask { height:100%; background:linear-gradient(90deg, #E04848, rgba(224,72,72,0.4)); border-radius:0 6px 6px 0; }
.depth-detail { display:flex; justify-content:space-between; font-size:10px; margin-top:3px; }
.depth-detail-bid { color:#6ECB3C; font-family:monospace; }
.depth-detail-ask { color:#E04848; font-family:monospace; }

/* On-Chain */
.oc-emotion { margin:10px 0; }
.oc-emotion-label { font-size:10px; color:var(--text-faint); text-transform:uppercase; letter-spacing:1.5px; font-weight:500; }
.oc-emotion-val { font-size:18px; font-weight:700; margin-left:8px; }
.oc-last-update { margin-bottom:10px; }
.oc-links { display:flex; flex-direction:column; gap:6px; }
.oc-link { display:flex; justify-content:space-between; align-items:center; padding:6px 8px; background:var(--bg-inner); border:1px solid var(--border); border-radius:8px; transition:all 0.2s; }
.oc-link:hover { border-color:var(--border-light); }
.oc-link-label { font-size:10px; color:var(--text-dim); text-transform:uppercase; letter-spacing:1.5px; font-weight:500; }
.oc-addr { font-size:11px; color:#22AACC; font-family:'Inter',monospace; text-decoration:none; overflow:hidden; text-overflow:ellipsis; max-width:60%; font-weight:500; }
.oc-addr:hover { text-decoration:underline; color:#33CCEE; }

/* Feed EMOLT Banner */
.feed-banner {
  background:linear-gradient(135deg, rgba(239,142,32,0.06), rgba(224,72,72,0.04));
  backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px);
  border:1px solid rgba(239,142,32,0.15); border-left:3px solid #EF8E20;
  border-radius:14px; padding:24px 28px; margin-top:14px;
  box-shadow:0 4px 24px rgba(239,142,32,0.06);
  animation:fadeUp 0.5s ease-out both; animation-delay:0.15s;
}
.feed-inner { display:grid; grid-template-columns:1fr 1fr; gap:28px; }
.feed-title {
  font-size:20px; font-weight:700; letter-spacing:1.5px;
  background:linear-gradient(135deg, #EF8E20, #F5D831, #E04848);
  -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text;
  margin-bottom:8px;
}
.feed-desc { font-size:12px; color:var(--text-mid); line-height:1.6; margin-bottom:12px; }
.feed-desc strong { color:var(--text); }
.feed-how { display:flex; flex-direction:column; gap:6px; margin-bottom:14px; }
.feed-step { display:flex; align-items:center; gap:8px; font-size:11px; color:var(--text-mid); }
.feed-step strong { color:var(--text); }
.feed-step-num {
  width:18px; height:18px; border-radius:50%; font-size:10px; font-weight:700;
  display:flex; align-items:center; justify-content:center; flex-shrink:0;
  background:linear-gradient(135deg, #EF8E20, #E04848); color:#000;
}
.feed-wallet-box {
  display:flex; align-items:center; gap:10px;
  background:var(--bg-inner); border:1px solid var(--border);
  padding:8px 14px; border-radius:8px; margin-bottom:8px;
}
.feed-wallet-addr {
  font-family:monospace; font-size:12px; color:#EF8E20; text-decoration:none;
  word-break:break-all; flex:1;
}
.feed-wallet-addr:hover { text-decoration:underline; }
.feed-copy-btn {
  font-size:10px; padding:5px 14px; border:1px solid #EF8E20; background:rgba(239,142,32,0.08);
  color:#EF8E20; border-radius:8px; cursor:pointer; font-weight:600; flex-shrink:0;
  transition:all 0.25s; letter-spacing:0.5px;
}
.feed-copy-btn:hover { background:#EF8E20; color:#000; transform:scale(1.04); box-shadow:0 0 16px rgba(239,142,32,0.3); }
.feed-links { display:flex; align-items:center; gap:8px; }
.feed-link { font-size:11px; color:var(--text-dim); text-decoration:none; }
.feed-link:hover { color:#EF8E20; text-decoration:underline; }
.feed-link-burn { color:#EF8E20; font-weight:600; }
.feed-link-sep { color:var(--text-faint); font-size:10px; }
.feed-right { display:flex; flex-direction:column; gap:12px; }
.feed-stats { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.feed-stat {
  background:var(--bg-inner); border:1px solid var(--border); border-radius:10px;
  padding:12px; text-align:center; transition:all 0.2s;
}
.feed-stat:hover { border-color:rgba(239,142,32,0.2); transform:translateY(-1px); }
.feed-stat-val { display:block; font-size:20px; font-weight:700; font-family:'Inter',monospace; letter-spacing:-0.5px; }
.feed-stat-label { font-size:8px; color:var(--text-dim); text-transform:uppercase; letter-spacing:1.5px; margin-top:3px; display:block; font-weight:500; }
.feed-top { }
.feed-top-title { font-size:10px; text-transform:uppercase; letter-spacing:1px; margin-bottom:4px; }
.feed-top-row { display:flex; align-items:center; gap:6px; font-size:11px; padding:3px 0; }
.feed-medal { font-size:13px; }
.feed-top-addr { color:#EF8E20; text-decoration:none; font-family:monospace; font-size:11px; }
.feed-top-addr:hover { text-decoration:underline; }
.feed-top-val { font-weight:600; margin-left:auto; }
.feed-recent { }
.feed-recent-title { font-size:10px; text-transform:uppercase; letter-spacing:1px; margin-bottom:4px; }
.burn-entry { display:flex; gap:6px; align-items:center; font-size:11px; padding:3px 0; }
.burn-flame-sm { font-size:12px; }
.burn-amt { color:#E04848; font-family:monospace; font-weight:600; }
.burn-from { font-size:10px; }
.burn-age { font-size:10px; margin-left:auto; }

/* Trending Ticker */
.ticker-wrapper {
  display:flex; align-items:center; gap:0;
  background:var(--bg-card); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
  border:1px solid var(--border); border-radius:12px;
  margin-bottom:8px; overflow:hidden; position:relative; height:40px;
  transition:all 0.3s; box-shadow:0 2px 12px rgba(0,0,0,0.15);
}
.ticker-label {
  flex-shrink:0; font-size:9px; font-weight:600; letter-spacing:2.5px; color:var(--text-dim);
  padding:0 16px; border-right:1px solid var(--border); height:100%; display:flex; align-items:center;
  background:var(--bg-inner); z-index:2; transition:background 0.3s;
}
.ticker-age {
  flex-shrink:0; font-size:9px; color:var(--text-faint); padding:0 14px;
  border-left:1px solid var(--border); height:100%; display:flex; align-items:center;
  background:var(--bg-inner); z-index:2; white-space:nowrap; transition:background 0.3s;
}
.ticker-overflow { flex:1; overflow:hidden; }
.ticker-track {
  display:inline-flex; align-items:center;
  animation:tickerScroll 40s linear infinite;
  white-space:nowrap; will-change:transform;
}
.ticker-track:hover { animation-play-state:paused; }
@keyframes tickerScroll { from{transform:translateX(0)} to{transform:translateX(-50%)} }
.ticker-item {
  display:inline-flex; align-items:center; gap:7px; padding:0 20px;
  border-right:1px solid var(--border); height:40px; flex-shrink:0; cursor:default;
  transition:background 0.2s;
}
.ticker-item:hover { background:rgba(255,255,255,0.03); }
.ticker-name { font-size:11px; font-weight:600; color:var(--text); white-space:nowrap; letter-spacing:0.5px; }
.ticker-price { font-size:11px; color:var(--text); font-family:'Inter',monospace; font-weight:600; }
.ticker-price sub { font-size:8px; color:var(--text-dim); vertical-align:baseline; }
.ticker-mc { font-size:10px; color:var(--text-dim); font-family:monospace; }
.ticker-change { font-size:10px; font-weight:500; font-family:monospace; white-space:nowrap; }
/* nad.fun ticker specifics */
.ticker-nf { margin-bottom:22px; }
.ticker-label-nf { color:#EF8E20; }
.nf-emo-name { color:#F5D831 !important; }
.nf-emo-item { border-right-color:var(--border-light); }

/* Footer */
.dash-footer { text-align:center; padding:32px 0 8px; margin-top:24px; }
.footer-line {
  width:60px; height:1px; margin:0 auto 16px;
  background:linear-gradient(90deg, transparent, var(--accent), transparent);
}
.footer-text {
  font-size:10px; letter-spacing:3px; text-transform:uppercase; color:var(--text-faint); font-weight:500; margin-bottom:4px;
}

/* Responsive - tablet */
@media (max-width:960px) {
  .grid { grid-template-columns:1fr 1fr; }
  .grid-quad { grid-template-columns:1fr 1fr; }
  .current-state-card { grid-column:1/-1; }
  .state-grid { grid-template-columns:1fr; }
  .wheel-col { width:100%; }
  .wheel-container { width:300px; margin:0 auto; }
  .emolt-gif-window { width:220px; height:220px; }
  .section-label { margin:16px 0 8px; font-size:8px; }
}

/* Responsive - mobile */
@media (max-width:640px) {
  body { padding:16px 10px 40px; font-size:12px; max-width:100vw; }
  .dashboard { max-width:100%; overflow:hidden; }
  .grid { grid-template-columns:1fr; gap:12px; }
  .grid-quad { grid-template-columns:1fr; gap:12px; }
  .grid-half { grid-template-columns:1fr; gap:12px; }
  .feed-inner { grid-template-columns:1fr; gap:16px; }
  .feed-banner { padding:16px; }
  .feed-wallet-addr { font-size:10px; }
  .header-feed { flex-direction:column; gap:6px; padding:8px 12px; }
  .header-feed-addr { font-size:9px; word-break:break-all; }
  .card { padding:16px 14px; border-radius:10px; }
  .card-wide, .current-state-card { grid-column:1; }
  .section-label { margin:14px 0 6px; font-size:8px; letter-spacing:2px; }

  /* Header */
  .dash-header { padding:16px 0 14px; margin-bottom:20px; }
  .dash-header h1 { font-size:13px; letter-spacing:5px; }
  .subtitle { font-size:10px; letter-spacing:2px; }
  .header-links { flex-wrap:wrap; gap:2px; }
  .header-link { font-size:10px; letter-spacing:1px; padding:4px 6px; }
  .header-stats { gap:6px; }
  .stat-chip { font-size:10px; padding:3px 8px; }
  .theme-toggle { top:16px; width:30px; height:30px; font-size:14px; }

  /* Plutchik wheel */
  .wheel-col { width:100%; }
  .wheel-container { width:100%; max-width:320px; margin:0 auto; }
  .emolt-gif-window { width:200px; height:200px; border-radius:12px; margin-top:12px; }
  .state-grid { grid-template-columns:1fr; gap:16px; }
  .mood-narrative { font-size:14px; line-height:1.6; }
  .etag { font-size:9px; }

  /* Emotion bars */
  .emo-bar-label { width:68px; font-size:9px; letter-spacing:0.5px; }
  .emo-bar-val { width:30px; font-size:9px; }

  /* Mood bars */
  .mood-grid { gap:6px; }
  .mood-label { width:68px; font-size:9px; letter-spacing:0.5px; }
  .mood-bar-track { height:8px; }
  .mood-vals { width:44px; }
  .mood-now { font-size:10px; }
  .mood-diff { font-size:8px; }

  /* Pulse grid stats - override inline column counts */
  .pulse-grid { grid-template-columns:repeat(2,1fr) !important; gap:6px; }

  /* Timeline chart */
  .timeline-legend { gap:4px 10px; }
  .tl-legend-item { font-size:9px; }
  .tl-dot { width:6px; height:6px; }

  /* Strategy weights */
  .weight-row { gap:6px; }
  .weight-label { width:90px; font-size:10px; }
  .weight-val { width:32px; font-size:10px; }

  /* Rolling averages */
  .ra-row { gap:6px; flex-wrap:wrap; }
  .ra-label { width:100px; font-size:10px; }
  .ra-value { font-size:11px; min-width:70px; }
  .ra-detail { font-size:9px; width:100%; padding-left:108px; margin-top:-2px; }

  /* DexScreener + Kuru */
  .kuru-price { font-size:14px; }
  .dex-pair-sym { min-width:80px; font-size:11px; }

  /* Post cards */
  .post-header { flex-direction:column; gap:2px; }
  .post-meta { white-space:normal; }
  .post-content { font-size:11px; }

  /* Conversations */
  .convo-text { font-size:11px; }

  /* Heartbeat log */
  .hb-entry summary { gap:4px; font-size:10px; }
  .hb-time { font-size:9px; }
  .hb-emo { font-size:10px; word-break:break-word; }
  .hb-details { padding:6px 0 10px 12px; font-size:11px; }
  .hb-details p { word-break:break-word; }

  /* Memory */
  .mem-content { font-size:11px; }

  /* Relationships */
  .rel-meta { font-size:10px; }
  .rel-context { font-size:10px; word-break:break-word; }

  /* On-chain */
  .oc-link { flex-direction:column; align-items:flex-start; gap:2px; }
  .oc-addr { font-size:10px; max-width:100%; overflow:hidden; text-overflow:ellipsis; }

  /* Compound table */
  .ch-name-header { min-width:90px; font-size:8px; }
  .ch-name { font-size:10px; }
  .ch-cycle { font-size:8px; min-width:18px; }
  .compound-table th, .compound-table td { padding:2px 3px; }

  /* Ticker mobile */
  .ticker-wrapper { height:36px; margin-bottom:0; border-radius:8px; }
  .ticker-nf { margin-top:4px; margin-bottom:14px; }
  .ticker-label { font-size:8px; padding:0 10px; letter-spacing:1px; }
  .ticker-age { font-size:8px; padding:0 8px; }
  .ticker-item { padding:0 14px; height:36px; gap:5px; }
  .ticker-name { font-size:10px; }
  .ticker-price { font-size:10px; }
  .ticker-mc { font-size:9px; }
  .ticker-change { font-size:9px; }

  /* Scroll containers get a bit more height on mobile */
  .scroll-inner { max-height:360px; }
}

/* Responsive - small phones */
@media (max-width:380px) {
  body { padding:12px 8px 32px; }
  .dash-header h1 { font-size:12px; letter-spacing:4px; }
  .emo-bar-label { width:56px; font-size:8px; }
  .weight-label { width:76px; font-size:9px; }
  .ra-label { width:80px; font-size:9px; }
  .ra-detail { padding-left:88px; }
  .pulse-grid { grid-template-columns:1fr 1fr !important; }
  .wheel-container { max-width:280px; }
}
`;

// --- Public API ---
export function generateDashboard(): void {
  loadAllData();

  const dexTicker = buildMajorsTicker();
  const nfTicker = buildNadFunTicker();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="emolt.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<title>EMOLT Heartbeat Dashboard</title>
<style>${CSS}</style>
</head>
<body>
<div class="top-accent"></div>
<div class="bg-ambience">
  <div class="bg-blob bg-blob-1"></div>
  <div class="bg-blob bg-blob-2"></div>
  <div class="bg-blob bg-blob-3"></div>
</div>
<div class="dashboard">
  ${buildHeader()}
  ${dexTicker}
  ${nfTicker}
  <div class="grid">
    ${buildCurrentState()}
    ${buildTimeline()}
    ${buildCompoundHistory()}
  </div>
  <div class="grid-quad">
    ${buildPostsFeed()}
    ${buildConversations()}
    ${buildMemorySection()}
    ${buildThoughtsAndLearning()}
  </div>
  <div class="grid-half">
    ${buildRelationships()}
    ${buildStrategyWeights()}
  </div>
  <div class="section-label"><span>Market Data</span></div>
  <div class="grid-half">
    ${buildDexScreenerPanel()}
    ${buildKuruPanel()}
  </div>
  <div class="section-label"><span>On-Chain &amp; Analytics</span></div>
  <div class="grid-half">
    ${buildOnChainStatus()}
    ${buildRollingAverages()}
  </div>
  <div style="margin-top:12px">
    ${buildHeartbeatLog()}
  </div>
  ${buildFeedSection()}
</div>
<script>
function toggleTheme(){
  const html=document.documentElement;
  const light=html.classList.toggle('light');
  document.getElementById('toggleIcon').innerHTML=light?'\\u263E':'\\u2606';
  localStorage.setItem('emolt-theme',light?'light':'dark');
}
(function(){
  if(localStorage.getItem('emolt-theme')==='light'){
    document.documentElement.classList.add('light');
    document.getElementById('toggleIcon').innerHTML='\\u263E';
  }
})();

// Set ticker speed based on actual pixel width of content
(function(){
  var PX_PER_SEC=40; // scroll speed in pixels per second
  var tracks=document.querySelectorAll('.ticker-track');
  for(var i=0;i<tracks.length;i++){
    var track=tracks[i];
    // The first half scrolls out, then it loops. Duration = half-width / speed.
    var halfW=track.scrollWidth/2;
    var duration=Math.max(10,halfW/PX_PER_SEC);
    track.style.animationDuration=duration+'s';
  }
})();

// --- Live price fetch for MAJORS ---
(function(){
  var COINS={monad:'MON',bitcoin:'BTC',ethereum:'ETH',solana:'SOL'};
  function fmtP(n){
    if(n===0)return'$0';
    if(n>=1e5)return'$'+(n>=1e9?(n/1e9).toFixed(1)+'B':n>=1e6?(n/1e6).toFixed(1)+'M':(n/1e3).toFixed(1)+'K');
    if(n>=1e3)return'$'+n.toLocaleString('en-US',{maximumFractionDigits:0});
    if(n>=1)return'$'+n.toFixed(2);
    if(n>=0.01)return'$'+n.toFixed(4);
    if(n>=1e-4)return'$'+n.toFixed(6);
    var s=n.toFixed(20),m=s.match(/^0\\.0*([\\d]{3})/);
    if(m){var z=s.indexOf(m[1])-2;return'$0.0<sub>'+z+'</sub>'+m[1];}
    return'$'+n.toFixed(10);
  }
  function fmtMC(n){
    if(n>=1e9)return'$'+(n/1e9).toFixed(1)+'B';
    if(n>=1e6)return'$'+(n/1e6).toFixed(1)+'M';
    if(n>=1e3)return'$'+(n/1e3).toFixed(1)+'K';
    return'$'+n.toFixed(1);
  }
  function updateMajors(data){
    for(var id in COINS){
      var sym=COINS[id];
      if(!data[id])continue;
      var c=data[id];
      var els=document.querySelectorAll('[data-major="'+sym+'"]');
      for(var i=0;i<els.length;i++){
        var el=els[i];
        var price=el.querySelector('.ticker-price');
        var mc=el.querySelector('.ticker-mc');
        var chg=el.querySelector('.ticker-change');
        if(price)price.innerHTML=fmtP(c.usd||0);
        if(mc)mc.textContent=fmtMC(c.usd_market_cap||0);
        if(chg){
          var v=c.usd_24h_change||0;
          chg.textContent=(v>=0?'+':'')+v.toFixed(1)+'%';
          chg.style.color=v>=0?'#6ECB3C':'#E04848';
        }
      }
    }
    var ageEl=document.getElementById('majors-age');
    if(ageEl)ageEl.textContent='live';
  }
  var majorsOk=false;

  // Source 1: CoinGecko
  function fetchCoinGecko(){
    return fetch('https://api.coingecko.com/api/v3/simple/price?ids=monad,bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true&include_market_cap=true')
      .then(function(r){if(!r.ok)throw new Error(r.status);return r.json();})
      .then(function(data){
        if(!data||!data.bitcoin)throw new Error('empty');
        return data; // already in {id:{usd,usd_24h_change,usd_market_cap}} format
      });
  }

  // Source 2: CoinCap
  var COINCAP_IDS={bitcoin:'bitcoin',ethereum:'ethereum',solana:'solana',monad:'monad'};
  function fetchCoinCap(){
    return fetch('https://api.coincap.io/v2/assets?ids=bitcoin,ethereum,solana,monad')
      .then(function(r){if(!r.ok)throw new Error(r.status);return r.json();})
      .then(function(json){
        var out={};
        var assets=json.data||[];
        for(var i=0;i<assets.length;i++){
          var a=assets[i];
          out[a.id]={usd:parseFloat(a.priceUsd)||0,usd_24h_change:parseFloat(a.changePercent24Hr)||0,usd_market_cap:parseFloat(a.marketCapUsd)||0};
        }
        if(!out.bitcoin)throw new Error('empty');
        return out;
      });
  }

  // Source 3: CryptoCompare
  function fetchCryptoCompare(){
    return fetch('https://min-api.cryptocompare.com/data/pricemultifull?fsyms=BTC,ETH,SOL,MON&tsyms=USD')
      .then(function(r){if(!r.ok)throw new Error(r.status);return r.json();})
      .then(function(json){
        var raw=json.RAW||{};
        var map={BTC:'bitcoin',ETH:'ethereum',SOL:'solana',MON:'monad'};
        var out={};
        for(var sym in map){
          var d=raw[sym]&&raw[sym].USD;
          if(d)out[map[sym]]={usd:d.PRICE||0,usd_24h_change:d.CHANGEPCT24HOUR||0,usd_market_cap:d.MKTCAP||0};
        }
        if(!out.bitcoin)throw new Error('empty');
        return out;
      });
  }

  function fetchMajors(){
    fetchCoinGecko()
      .catch(function(e){console.warn('CoinGecko failed:',e.message);return fetchCoinCap();})
      .catch(function(e){console.warn('CoinCap failed:',e.message);return fetchCryptoCompare();})
      .then(function(data){if(data){majorsOk=true;updateMajors(data);}})
      .catch(function(e){
        var ageEl=document.getElementById('majors-age');
        if(ageEl)ageEl.textContent=majorsOk?'live':'cached';
        console.warn('All price sources failed:',e);
      });
  }
  // Fetch on load, then every 60s
  fetchMajors();
  setInterval(fetchMajors,60000);
})();

// --- Live price fetch for NAD.FUN + $EMO ---
(function(){
  function fmtP(n){
    if(n===0)return'$0';
    if(n>=1e5)return'$'+(n>=1e9?(n/1e9).toFixed(1)+'B':n>=1e6?(n/1e6).toFixed(1)+'M':(n/1e3).toFixed(1)+'K');
    if(n>=1e3)return'$'+n.toLocaleString('en-US',{maximumFractionDigits:0});
    if(n>=1)return'$'+n.toFixed(2);
    if(n>=0.01)return'$'+n.toFixed(4);
    if(n>=1e-4)return'$'+n.toFixed(6);
    var s=n.toFixed(20),m=s.match(/^0\\.0*([\\d]{3})/);
    if(m){var z=s.indexOf(m[1])-2;return'$0.0<sub>'+z+'</sub>'+m[1];}
    return'$'+n.toFixed(10);
  }
  function fmtMC(n){
    if(n>=1e9)return'$'+(n/1e9).toFixed(1)+'B';
    if(n>=1e6)return'$'+(n/1e6).toFixed(1)+'M';
    if(n>=1e3)return'$'+(n/1e3).toFixed(1)+'K';
    return'$'+n.toFixed(1);
  }
  function updateItem(el,price,mc,change){
    var p=el.querySelector('.ticker-price');
    var m=el.querySelector('.ticker-mc');
    var c=el.querySelector('.ticker-change');
    if(p)p.innerHTML=fmtP(price);
    if(m)m.textContent=mc>0?fmtMC(mc):'';
    if(c){c.textContent=(change>=0?'+':'')+change.toFixed(1)+'%';c.style.color=change>=0?'#6ECB3C':'#E04848';}
  }
  function buildTickerItem(sym,price,mc,change,isEmo){
    var changeColor=change>=0?'#6ECB3C':'#E04848';
    var changeSign=change>=0?'+':'';
    var cls=isEmo?'ticker-item nf-emo-item':'ticker-item';
    var nameCls=isEmo?'ticker-name nf-emo-name':'ticker-name';
    return '<div class="'+cls+'" data-symbol="'+sym+'">'
      +'<span class="'+nameCls+'">$'+sym+'</span>'
      +'<span class="ticker-price">'+fmtP(price)+'</span>'
      +'<span class="ticker-mc">'+(mc>0?fmtMC(mc):'')+'</span>'
      +'<span class="ticker-change" style="color:'+changeColor+'">'+changeSign+change.toFixed(1)+'%</span>'
      +'</div>';
  }
  function fetchNadFun(){
    fetch('https://api.nad.fun/order/market_cap?limit=20')
      .then(function(r){return r.json()})
      .then(function(data){
        var tokens=Array.isArray(data)?data:(data.tokens||data.data||[]);
        if(tokens.length===0)return;
        // Rebuild the entire ticker track from live API data
        var items='';
        for(var i=0;i<tokens.length&&i<10;i++){
          var t=tokens[i];
          var sym=t.token_info&&t.token_info.symbol||'???';
          var priceUsd=parseFloat(t.market_info&&t.market_info.price_usd||'0');
          var totalSupplyWei=t.market_info&&t.market_info.total_supply||'1000000000000000000000000000';
          var totalSupply=Number(BigInt(totalSupplyWei))/1e18;
          items+=buildTickerItem(sym,priceUsd,priceUsd*totalSupply,t.percent||0,false);
        }
        // Prepend $EMO (updated separately by fetchEmo)
        var emoEls=document.querySelectorAll('[data-symbol="EMO"]');
        var emoHtml=emoEls.length>0?emoEls[0].outerHTML:buildTickerItem('EMO',0,0,0,true);
        var oneSet=emoHtml+items;
        var track=oneSet+oneSet; // duplicate for seamless scroll
        var wrapper=document.querySelector('.ticker-nf');
        if(wrapper){
          var overflow=wrapper.querySelector('.ticker-overflow');
          if(overflow){
            overflow.innerHTML='<div class="ticker-track">'+track+'</div>';
            // Recalculate scroll speed
            var t2=overflow.querySelector('.ticker-track');
            if(t2){var halfW=t2.scrollWidth/2;var dur=Math.max(10,halfW/40);t2.style.animationDuration=dur+'s';}
          }
        }
      })
      .catch(function(e){console.warn('nad.fun fetch failed:',e);});
  }
  function fetchEmo(){
    fetch('https://api.dexscreener.com/latest/dex/tokens/0x81A224F8A62f52BdE942dBF23A56df77A10b7777')
      .then(function(r){return r.json()})
      .then(function(json){
        var pair=json.pairs&&json.pairs[0];
        if(!pair)return;
        var price=parseFloat(pair.priceUsd)||0;
        var mc=pair.marketCap||pair.fdv||0;
        var change=pair.priceChange&&pair.priceChange.h24||0;
        var els=document.querySelectorAll('[data-symbol="EMO"]');
        for(var i=0;i<els.length;i++)updateItem(els[i],price,mc,change);
      })
      .catch(function(e){console.warn('$EMO fetch failed:',e);});
  }
  // Fetch on load, then every 60s
  fetchNadFun();
  fetchEmo();
  setInterval(fetchNadFun,60000);
  setInterval(fetchEmo,60000);

  // Suspension countdown — live hh:mm, ticks every 30s
  (function suspTimer(){
    var el=document.getElementById('suspTimer');
    if(!el)return;
    var until=parseInt(el.getAttribute('data-until')||'0',10);
    var chip=el.closest('.stat-moltbook');
    function tick(){
      var left=until-Date.now();
      if(left<=0){
        if(chip){
          chip.classList.remove('stat-suspended');
          chip.innerHTML='<span class="status-dot status-on"></span>moltbook';
        }
        return;
      }
      var h=Math.floor(left/3600000);
      var m=Math.floor((left%3600000)/60000);
      el.textContent=h+'h '+m+'m';
      setTimeout(tick,30000);
    }
    tick();
  })();

  // GitHub stars - live fetch once on load
  (function fetchGhStars(){
    fetch('https://api.github.com/repos/LordEmonad/emolt-agent',{headers:{'Accept':'application/vnd.github.v3+json'}})
      .then(function(r){return r.json();})
      .then(function(d){
        var el=document.getElementById('gh-stars');
        if(el&&typeof d.stargazers_count==='number'){el.textContent='\u2605 '+d.stargazers_count;}
      }).catch(function(){});
  })();
})();

</script>
</body>
</html>`;

  writeFileSync(OUT, html, 'utf-8');
  const sizeKB = (Buffer.byteLength(html, 'utf-8') / 1024).toFixed(1);
  console.log(`[Dashboard] Written ${OUT} (${sizeKB} KB)`);
}

// Run standalone when executed directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith('generate.ts') || process.argv[1].endsWith('generate.js')
);
if (isMain) {
  generateDashboard();
}
