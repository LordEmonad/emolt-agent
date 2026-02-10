/**
 * EMOLT Heartbeat Dashboard Generator
 * Standalone script - reads all ./state/ files and writes heartbeat.html
 * Run: npx tsx src/dashboard/generate.ts
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

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
  trendingData = readJSON('trending-data.json');
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

// --- SVG Plutchik Wheel (ported from emoodring-demo.html) ---
function buildPlutchikSVG(emotions: Record<string, number>): string {
  const S = 320;
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

    const labelR = maxOuterR + 20;
    const lx = cx + Math.cos(aRad) * labelR;
    const ly = cy + Math.sin(aRad) * labelR;
    const tierLabel = getTierLabel(emo.name, norm);
    const labelOp = (0.5 + norm * 0.5).toFixed(3);
    const pct = Math.round(norm * 100);
    labels += `<text x="${lx.toFixed(1)}" y="${(ly - 1).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" fill="${emo.color}" opacity="${labelOp}" font-size="9" font-weight="500" letter-spacing="1">${tierLabel}</text>`;
    labels += `<text x="${lx.toFixed(1)}" y="${(ly + 9).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" fill="${emo.color}" opacity="${(norm * 0.4).toFixed(3)}" font-size="7" font-weight="300">${pct}%</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="100%" height="100%" style="max-width:${S}px">
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

  const links: string[] = [];
  links.push(`<a class="header-link" href="${MOLTBOOK_URL}/u/EMOLT" target="_blank">moltbook</a>`);
  if (oracleAddr) links.push(`<a class="header-link" href="https://monadvision.com/address/${oracleAddr}" target="_blank">oracle</a>`);
  links.push(`<a class="header-link" href="https://monadvision.com/nft/0x4F646aa4c5aAF03f2F4b86D321f59D9D0dAeF17D/0" target="_blank">emoodring</a>`);
  links.push(`<a class="header-link" href="https://nad.fun/tokens/0x81A224F8A62f52BdE942dBF23A56df77A10b7777" target="_blank">$emo</a>`);
  const ghStars = readJSON(join(STATE, 'github-stars-prev.json'));
  const starCount = ghStars?.stars ?? '';
  links.push(`<a class="header-link" href="${GITHUB_URL}" target="_blank">github${starCount ? ` <span id="gh-stars">\u2605 ${starCount}</span>` : ` <span id="gh-stars"></span>`}</a>`);

  return `
  <header class="dash-header">
    <h1>EMOLT HEARTBEAT</h1>
    <p class="subtitle">autonomous emotional agent on monad</p>
    <div class="header-cadence">EMOLT reads Monad and nad.fun chain data, feels emotions, and posts autonomously on Moltbook</div>
    <div class="header-links">${links.join('<span class="link-sep">/</span>')}</div>
    <div class="header-stats">
      <span class="stat-chip">${cycles} cycles</span>
      <span class="stat-chip">${memCount} memories</span>
      <span class="stat-chip">${trackedPosts.length} posts</span>
      <span class="stat-chip">last update: ${now}</span>
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
      moodBars += `<div class="mood-pair">
        <span class="emo-bar-label" style="color:${emo.color}">${emo.name}</span>
        <div class="mood-bars-wrap">
          <div class="mood-bar-track"><div class="mood-bar-fill current" style="width:${cPct}%;background:${emo.color}"></div></div>
          <div class="mood-bar-track"><div class="mood-bar-fill mood" style="width:${mPct}%;background:${emo.color};opacity:0.4"></div></div>
        </div>
        <span class="emo-bar-val">${cPct}/${mPct}</span>
      </div>`;
    }
    moodSection = `<div class="card"><h2>Mood vs Current</h2><p class="muted">Top = current, bottom = mood (EMA)</p>${moodBars}</div>`;
  }

  return `
  <div class="card current-state-card">
    <h2>Current Emotional State</h2>
    <div class="state-grid">
      <div class="wheel-container">${svg}</div>
      <div class="state-details">
        <div class="dominant-display">
          <span class="dominant-tier" style="color:${domColor}">${esc(label.toUpperCase())}</span>
          <span class="dominant-emotion" style="color:${domColor}">${dominant}</span>
        </div>
        ${compounds.length > 0 ? `<div class="compounds">${compounds.map((c: string) => `<span class="compound-tag">${esc(c)}</span>`).join('')}</div>` : ''}
        ${trigger ? `<p class="trigger">trigger: ${esc(trigger)}</p>` : ''}
        <div class="emo-bars">${bars}</div>
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
  --bg:#08080c; --bg-card:#0e0e16; --bg-inner:#12121c; --bg-track:#12121c;
  --border:#16161e; --border-light:#1e1e2a;
  --text:#d4d4dc; --text-mid:#aab; --text-dim:#778; --text-faint:#556; --text-muted:#667;
  --heading:#888; --heading-sub:#777;
  --scrollbar-track:#0a0a12; --scrollbar-thumb:#2a2a3a; --scrollbar-hover:#3a3a4e;
}
html.light {
  --bg:#f0f0f4; --bg-card:#ffffff; --bg-inner:#f5f5f8; --bg-track:#e8e8ee;
  --border:#dcdce4; --border-light:#ccccd4;
  --text:#1a1a24; --text-mid:#3a3a4a; --text-dim:#555568; --text-faint:#6a6a7a; --text-muted:#5a5a6a;
  --heading:#555; --heading-sub:#666;
  --scrollbar-track:#e0e0e8; --scrollbar-thumb:#c0c0cc; --scrollbar-hover:#a0a0b0;
}
* { margin:0; padding:0; box-sizing:border-box; }
html { scroll-behavior: smooth; overflow-x:hidden; }
body {
  background:var(--bg); color:var(--text);
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  font-size:13px; line-height:1.55; padding:24px 16px 60px;
  transition:background 0.3s, color 0.3s;
  overflow-x:hidden; max-width:100vw;
}
.dashboard { max-width:1280px; margin:0 auto; }
/* Theme toggle */
.dash-header { text-align:center; margin-bottom:32px; padding:24px 0 20px; border-bottom:1px solid var(--border); position:relative; }
.dash-header h1 { font-size:15px; font-weight:500; letter-spacing:8px; color:var(--heading); text-transform:uppercase; margin-bottom:2px; }
.subtitle { font-size:11px; letter-spacing:3px; color:var(--text-faint); text-transform:uppercase; margin-bottom:4px; }
.header-cadence { font-size:10px; color:var(--text-muted); letter-spacing:1px; margin-bottom:12px; }
.header-links { display:flex; gap:4px; justify-content:center; align-items:center; margin-bottom:12px; }
.header-link { font-size:11px; font-weight:500; letter-spacing:2px; text-transform:uppercase; color:var(--text-dim); text-decoration:none; padding:4px 8px; border-radius:6px; transition:color 0.2s, background 0.2s; }
.header-link:hover { color:#EF8E20; background:rgba(239,142,32,0.08); }
#gh-stars { font-size:10px; color:var(--heading); margin-left:2px; }
.link-sep { color:var(--border-light); font-size:10px; margin:0 2px; }
.header-stats { display:flex; gap:8px; justify-content:center; flex-wrap:wrap; }
.stat-chip { font-size:11px; font-weight:400; letter-spacing:1px; color:var(--text-dim); background:var(--bg-card); border:1px solid var(--border-light); padding:4px 12px; border-radius:12px; transition:background 0.3s, border-color 0.3s; }
.theme-toggle { position:absolute; top:24px; right:0; background:var(--bg-card); border:1px solid var(--border-light); color:var(--text-dim); width:34px; height:34px; border-radius:50%; cursor:pointer; font-size:16px; display:flex; align-items:center; justify-content:center; transition:all 0.3s; }
.theme-toggle:hover { border-color:var(--text-dim); color:var(--text); }

.grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:16px; }
.card { background:var(--bg-card); border:1px solid var(--border); border-radius:12px; padding:20px; transition:background 0.3s, border-color 0.3s; overflow:hidden; overflow-wrap:break-word; word-break:break-word; }
.card-wide { grid-column:1/-1; }
.grid-half { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:16px; }
.card-half { display:flex; flex-direction:column; }
.card-half .scroll-inner { flex:1; }
.card h2 { font-size:12px; font-weight:500; letter-spacing:3px; text-transform:uppercase; color:var(--heading); margin-bottom:4px; }
.card h3 { font-size:11px; font-weight:500; letter-spacing:2px; text-transform:uppercase; color:var(--heading-sub); margin:12px 0 6px; }
.muted { font-size:11px; color:var(--text-faint); margin-bottom:12px; }

/* Scrollable inner containers */
.scroll-inner { max-height:420px; overflow-y:auto; overflow-x:hidden; padding-right:4px; }
.scroll-inner::-webkit-scrollbar { width:4px; }
.scroll-inner::-webkit-scrollbar-track { background:var(--scrollbar-track); border-radius:2px; }
.scroll-inner::-webkit-scrollbar-thumb { background:var(--scrollbar-thumb); border-radius:2px; }
.scroll-inner::-webkit-scrollbar-thumb:hover { background:var(--scrollbar-hover); }

/* Current state */
.current-state-card { grid-column:span 2; }
.state-grid { display:grid; grid-template-columns:auto 1fr; gap:24px; align-items:start; }
.wheel-container { width:280px; flex-shrink:0; }
.dominant-display { margin-bottom:12px; }
.dominant-tier { display:block; font-size:18px; font-weight:600; letter-spacing:4px; }
.dominant-emotion { display:block; font-size:11px; letter-spacing:3px; text-transform:uppercase; opacity:0.6; }
.compounds { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px; }
.compound-tag { font-size:10px; letter-spacing:1.5px; color:var(--text-mid); background:var(--bg-inner); border:1px solid var(--border-light); padding:3px 10px; border-radius:8px; text-transform:uppercase; transition:background 0.3s; }
.trigger { font-size:12px; color:var(--text-muted); margin-bottom:12px; font-style:italic; }

/* Emotion bars */
.emo-bars { display:flex; flex-direction:column; gap:4px; }
.emo-bar-row { display:flex; align-items:center; gap:8px; }
.emo-bar-label { font-size:10px; letter-spacing:1px; width:90px; text-align:right; text-transform:uppercase; font-weight:500; }
.emo-bar-track { flex:1; height:7px; background:var(--bg-track); border-radius:3px; overflow:hidden; transition:background 0.3s; }
.emo-bar-fill { height:100%; border-radius:3px; transition:width 0.3s ease; }
.emo-bar-val { font-size:10px; color:var(--text-dim); width:36px; text-align:right; font-family:monospace; }

/* Mood vs Current */
.mood-pair { display:flex; align-items:center; gap:8px; margin-bottom:3px; }
.mood-bars-wrap { flex:1; display:flex; flex-direction:column; gap:1px; }
.mood-bar-track { height:4px; background:var(--bg-track); border-radius:2px; overflow:hidden; transition:background 0.3s; }
.mood-bar-fill { height:100%; border-radius:2px; }
.mood-bar-fill.mood { opacity:0.35; }

/* Posts */
.post-card { border-bottom:1px solid var(--border); padding:10px 0; }
.post-card:last-child { border-bottom:none; }
.post-header { display:flex; justify-content:space-between; align-items:baseline; gap:8px; }
.post-title { font-size:13px; font-weight:500; color:var(--text); }
.post-meta { font-size:10px; color:var(--text-muted); white-space:nowrap; }
.post-content { font-size:12px; color:var(--text-mid); margin:4px 0; line-height:1.55; }
.post-stats { display:flex; gap:14px; font-size:11px; color:var(--text-dim); font-family:monospace; }
.stat-comments::before { content:'\\25CF '; color:#4A6BD4; }

/* Conversations */
.convo-row { border-bottom:1px solid var(--border); padding:10px 0; }
.convo-row:last-child { border-bottom:none; }
.convo-header { display:flex; align-items:center; gap:8px; margin-bottom:4px; }
.convo-target { font-size:12px; font-weight:500; color:#22AACC; }
.convo-age { font-size:10px; color:var(--text-muted); }
.convo-parent { background:var(--bg-inner); border-left:2px solid var(--border-light); padding:6px 10px; margin:6px 0; border-radius:0 6px 6px 0; }
.convo-parent-label { font-size:9px; text-transform:uppercase; letter-spacing:1px; color:var(--text-faint); display:block; margin-bottom:2px; }
.convo-parent-title { font-size:12px; font-weight:500; color:var(--text); display:block; }
.convo-parent-text { font-size:11px; color:var(--text-dim); margin-top:2px; line-height:1.4; }
.convo-text { font-size:12px; color:var(--text-mid); margin-top:4px; line-height:1.5; }

/* Relationships */
.rel-row { border-bottom:1px solid var(--border); padding:8px 0; }
.rel-row:last-child { border-bottom:none; }
.rel-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; }
.rel-name { font-size:13px; font-weight:500; color:#22AACC; }
.rel-sentiment { font-size:11px; font-weight:400; }
.rel-bar-track { height:4px; background:var(--bg-track); border-radius:2px; overflow:hidden; margin-bottom:4px; transition:background 0.3s; }
.rel-bar-fill { height:100%; border-radius:2px; opacity:0.7; }
.rel-meta { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.rel-count { font-size:10px; color:var(--text-dim); font-family:monospace; }
.rel-context { font-size:11px; color:var(--text-muted); flex:1; }
.rel-age { font-size:10px; color:var(--text-faint); }

/* Heartbeat log */
.hb-entry { border-bottom:1px solid var(--border); }
.hb-entry:last-child { border-bottom:none; }
.hb-entry summary { display:flex; align-items:center; gap:8px; padding:7px 0; cursor:pointer; font-size:11px; color:var(--text-mid); list-style:none; flex-wrap:wrap; }
.hb-entry summary::-webkit-details-marker { display:none; }
.hb-entry summary::before { content:'\\25B6'; font-size:8px; color:var(--text-faint); transition:transform 0.2s; }
.hb-entry[open] summary::before { transform:rotate(90deg); }
.hb-cycle { font-weight:600; color:#EF8E20; min-width:32px; }
.hb-time { color:var(--text-muted); font-family:monospace; font-size:10px; }
.hb-emo { color:#6A8BF4; }
.hb-action { color:#7EDB4C; font-weight:500; }
.hb-dur { color:var(--text-muted); font-family:monospace; }
.hb-details { padding:8px 0 14px 18px; font-size:12px; color:var(--text-mid); line-height:1.6; }
.hb-details b { color:var(--text); }
.badge-ok { font-size:9px; color:#6ECB3C; border:1px solid #6ECB3C44; padding:1px 6px; border-radius:6px; }

/* Memory */
.mem-category { margin-bottom:8px; }
.mem-count { font-weight:400; color:var(--text-muted); }
.mem-entry { border-bottom:1px solid var(--border); padding:8px 0; }
.mem-entry:last-child { border-bottom:none; }
.mem-content { font-size:12px; color:var(--text-mid); line-height:1.5; }
.mem-agent { font-size:12px; font-weight:500; }
.mem-sentiment { font-size:10px; color:var(--text-dim); margin-left:6px; }
.mem-age { font-size:10px; color:var(--text-faint); }
.badge-imp { font-size:9px; color:#F5D831; border:1px solid #F5D83144; padding:2px 6px; border-radius:6px; }
html.light .badge-imp { color:#b8960a; border-color:#b8960a44; }
.badge-fade { font-size:9px; color:var(--text-muted); border:1px solid var(--border); padding:2px 6px; border-radius:6px; }

/* Thoughts & Learning */
.thought-entry { border-bottom:1px solid var(--border); padding:10px 0; }
.thought-entry:last-child { border-bottom:none; }
.thought-header { display:flex; align-items:center; gap:8px; font-size:11px; color:var(--text-mid); flex-wrap:wrap; margin-bottom:6px; }
.thought-cycle { font-weight:600; color:var(--accent); }
.thought-time { color:var(--text-faint); font-size:10px; }
.thought-shift { color:var(--text-dim); }
.thought-action { background:var(--card); border:1px solid var(--border); padding:1px 6px; border-radius:4px; font-size:10px; }
.thought-block { margin:4px 0 4px 12px; padding:6px 10px; border-left:2px solid var(--border); }
.thought-block p { font-size:12px; color:var(--text-mid); line-height:1.5; margin:0; }
.thought-label { font-size:9px; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-faint); display:block; margin-bottom:2px; }
.reflection-block { border-left-color:var(--accent); }

/* Strategy weights */
.weight-row { display:flex; align-items:center; gap:8px; margin-bottom:5px; }
.weight-label { font-size:11px; color:var(--text-mid); width:160px; text-align:right; text-transform:capitalize; }
.weight-track { flex:1; height:8px; background:var(--bg-track); border-radius:4px; overflow:hidden; position:relative; transition:background 0.3s; }
.weight-fill { height:100%; border-radius:4px; }
.weight-marker { position:absolute; top:0; width:1px; height:100%; background:var(--text-faint); }
.weight-val { font-size:11px; color:var(--text-dim); font-family:monospace; width:36px; text-align:right; }

/* Chain Pulse */
.pulse-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; }
.pulse-stat { text-align:center; padding:8px 4px; background:var(--bg-inner); border-radius:8px; transition:background 0.3s; }
.pulse-val { display:block; font-size:16px; font-weight:600; color:var(--text); font-family:monospace; }
.pulse-label { display:block; font-size:9px; letter-spacing:1px; text-transform:uppercase; color:var(--text-faint); margin-top:2px; }
.pulse-whales { font-size:12px; color:var(--text-mid); margin-top:10px; padding:6px 10px; background:var(--bg-inner); border-radius:8px; transition:background 0.3s; }
.pulse-change { display:block; font-size:10px; font-family:monospace; margin-top:1px; }
.pulse-tag { font-size:9px; letter-spacing:1px; padding:2px 8px; border-radius:6px; margin-left:6px; }
.pulse-quiet { color:#4A6BD4; border:1px solid #4A6BD444; }
.pulse-busy { color:#EF8E20; border:1px solid #EF8E2044; }

/* Timeline Legend */
.timeline-legend { display:flex; flex-wrap:wrap; gap:6px 14px; margin-bottom:8px; }
.tl-legend-item { display:inline-flex; align-items:center; gap:4px; font-size:10px; color:var(--text-dim); white-space:nowrap; }
.tl-dot { width:7px; height:7px; border-radius:2px; flex-shrink:0; }

/* Engagement */
.engage-avgs { display:flex; gap:16px; margin:10px 0 6px; }
.engage-avg { font-size:11px; color:var(--text-dim); font-family:monospace; }
.engage-best { font-size:12px; color:var(--text-mid); padding:6px 10px; background:var(--bg-inner); border-radius:8px; transition:background 0.3s; overflow:hidden; text-overflow:ellipsis; }
.engage-best strong { color:var(--text); }

/* Compound Emotions */
.compound-table { border-collapse:collapse; width:100%; font-size:11px; }
.compound-table th, .compound-table td { padding:3px 6px; text-align:center; }
.ch-name-header { text-align:left !important; color:var(--text-faint); font-weight:400; letter-spacing:1px; text-transform:uppercase; font-size:9px; min-width:120px; }
.ch-name { text-align:left !important; color:var(--text-mid); font-weight:500; white-space:nowrap; font-size:11px; }
.ch-freq { font-size:9px; color:var(--text-faint); font-weight:400; }
.ch-cycle { font-size:9px; font-weight:500; min-width:24px; }
.ch-cell { padding:2px; }
.ch-dot { color:#EF8E20; font-size:10px; }

/* Rolling Averages */
.ra-row { display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--border); }
.ra-row:last-child { border-bottom:none; }
.ra-label { font-size:11px; color:var(--text-mid); width:120px; text-align:right; }
.ra-value { font-size:12px; font-weight:600; color:var(--text); font-family:monospace; min-width:80px; }
.ra-detail { font-size:10px; color:var(--text-faint); }

/* On-Chain */
.oc-emotion { margin:8px 0; }
.oc-emotion-label { font-size:10px; color:var(--text-faint); text-transform:uppercase; letter-spacing:1px; }
.oc-emotion-val { font-size:16px; font-weight:600; margin-left:8px; }
.oc-last-update { margin-bottom:8px; }
.oc-links { display:flex; flex-direction:column; gap:4px; }
.oc-link { display:flex; justify-content:space-between; align-items:center; padding:4px 0; }
.oc-link-label { font-size:10px; color:var(--text-dim); text-transform:uppercase; letter-spacing:1px; }
.oc-addr { font-size:11px; color:#22AACC; font-family:monospace; text-decoration:none; overflow:hidden; text-overflow:ellipsis; max-width:60%; }
.oc-addr:hover { text-decoration:underline; }

/* Trending Ticker */
.ticker-wrapper {
  display:flex; align-items:center; gap:0;
  background:var(--bg-card); border:1px solid var(--border); border-radius:10px;
  margin-bottom:8px; overflow:hidden; position:relative; height:38px;
  transition:background 0.3s, border-color 0.3s;
}
.ticker-label {
  flex-shrink:0; font-size:9px; font-weight:600; letter-spacing:2px; color:var(--text-faint);
  padding:0 14px; border-right:1px solid var(--border); height:100%; display:flex; align-items:center;
  background:var(--bg-inner); z-index:2; transition:background 0.3s;
}
.ticker-age {
  flex-shrink:0; font-size:9px; color:var(--text-faint); padding:0 12px;
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
  display:inline-flex; align-items:center; gap:6px; padding:0 18px;
  border-right:1px solid var(--border); height:38px; flex-shrink:0; cursor:default;
  transition:background 0.15s;
}
.ticker-item:hover { background:var(--bg-inner); }
.ticker-name { font-size:11px; font-weight:600; color:var(--text); white-space:nowrap; }
.ticker-price { font-size:11px; color:var(--text); font-family:monospace; font-weight:500; }
.ticker-price sub { font-size:8px; color:var(--text-dim); vertical-align:baseline; }
.ticker-mc { font-size:10px; color:var(--text-dim); font-family:monospace; }
.ticker-change { font-size:10px; font-weight:500; font-family:monospace; white-space:nowrap; }
/* nad.fun ticker specifics */
.ticker-nf { margin-bottom:20px; }
.ticker-label-nf { color:#EF8E20; }
.nf-emo-name { color:#F5D831 !important; }
.nf-emo-item { border-right-color:var(--border-light); }

/* Responsive - tablet */
@media (max-width:960px) {
  .grid { grid-template-columns:1fr 1fr; }
  .current-state-card { grid-column:1/-1; }
  .state-grid { grid-template-columns:1fr; }
  .wheel-container { width:260px; margin:0 auto; }
}

/* Responsive - mobile */
@media (max-width:640px) {
  body { padding:16px 10px 40px; font-size:12px; max-width:100vw; }
  .dashboard { max-width:100%; overflow:hidden; }
  .grid { grid-template-columns:1fr; gap:12px; }
  .grid-half { grid-template-columns:1fr; gap:12px; }
  .card { padding:16px 14px; border-radius:10px; }
  .card-wide, .current-state-card { grid-column:1; }

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
  .wheel-container { width:100%; max-width:280px; margin:0 auto; }
  .state-grid { grid-template-columns:1fr; gap:16px; }
  .dominant-tier { font-size:16px; letter-spacing:3px; }
  .dominant-emotion { font-size:10px; }

  /* Emotion bars */
  .emo-bar-label { width:68px; font-size:9px; letter-spacing:0.5px; }
  .emo-bar-val { width:30px; font-size:9px; }

  /* Mood bars */
  .mood-pair .emo-bar-label { width:68px; font-size:9px; }
  .mood-pair .emo-bar-val { width:30px; font-size:9px; }

  /* Pulse grid stats - override inline column counts */
  .pulse-grid { grid-template-columns:repeat(2,1fr) !important; gap:6px; }

  /* Engagement */
  .engage-avgs { flex-direction:column; gap:4px; }
  .engage-best { font-size:11px; }

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
  .ticker-wrapper { height:34px; margin-bottom:0; border-radius:8px; }
  .ticker-nf { margin-top:4px; margin-bottom:14px; }
  .ticker-label { font-size:8px; padding:0 10px; letter-spacing:1px; }
  .ticker-age { font-size:8px; padding:0 8px; }
  .ticker-item { padding:0 14px; height:34px; gap:5px; }
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
  .wheel-container { max-width:240px; }
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
<title>EMOLT Heartbeat Dashboard</title>
<style>${CSS}</style>
</head>
<body>
<div class="dashboard">
  ${buildHeader()}
  ${dexTicker}
  ${nfTicker}
  <div class="grid">
    ${buildCurrentState()}
    ${buildEngagementSummary()}
    ${buildTimeline()}
    ${buildCompoundHistory()}
    ${buildPostsFeed()}
    ${buildConversations()}
    ${buildMemorySection()}
    ${buildThoughtsAndLearning()}
  </div>
  <div class="grid-half">
    ${buildRelationships()}
    ${buildStrategyWeights()}
  </div>
  <div class="grid-half">
    ${buildOnChainStatus()}
    ${buildRollingAverages()}
  </div>
  <div style="margin-top:16px">
    ${buildHeartbeatLog()}
  </div>
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
