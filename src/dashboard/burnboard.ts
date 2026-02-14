/**
 * EMOLT Burnboard — Standalone feeder leaderboard page
 * Reads state/burn-ledger.json and writes burnboard.html
 * Run: npx tsx src/dashboard/burnboard.ts
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { privateKeyToAccount } from 'viem/accounts';

const STATE = './state';
const OUT = './burnboard.html';

function readJSON(file: string): any {
  try {
    return JSON.parse(readFileSync(join(STATE, file), 'utf-8'));
  } catch { return null; }
}

function loadEnvVar(key: string): string {
  if (process.env[key]) return process.env[key]!;
  try {
    const env = readFileSync('.env', 'utf-8');
    const match = env.match(new RegExp(`^${key}=(.+)$`, 'm'));
    return match?.[1]?.trim() || '';
  } catch { return ''; }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeAgo(ts: number): string {
  const h = (Date.now() - ts) / 3600000;
  if (h < 1) return `${Math.round(h * 60)}m ago`;
  if (h < 24) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function fmtDate(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
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

export function generateBurnboard(): void {
  const ledger = readJSON('burn-ledger.json');
  const walletAddr = getAgentWalletAddress() || '???';
  const addrShort = walletAddr !== '???' ? `${walletAddr.slice(0, 6)}...${walletAddr.slice(-4)}` : '???';

  // Feeder leaderboard sorted by total USD value
  const feeders = ledger?.feeders ? Object.values(ledger.feeders) as any[] : [];
  const sorted = [...feeders].sort((a, b) => (b.totalEmoUsd + b.totalMonUsd) - (a.totalEmoUsd + a.totalMonUsd));

  // Stats
  const totalEmoReceived = ledger?.totalEmoReceived ? (Number(BigInt(ledger.totalEmoReceived)) / 1e18).toFixed(2) : '0';
  const totalEmoBurned = ledger?.totalEmoBurned ? (Number(BigInt(ledger.totalEmoBurned)) / 1e18).toFixed(2) : '0';
  const totalMonReceived = ledger?.totalMonReceived ? (Number(BigInt(ledger.totalMonReceived)) / 1e18).toFixed(4) : '0';
  const totalEmoUsd = feeders.reduce((sum: number, f: any) => sum + (f.totalEmoUsd || 0), 0).toFixed(2);
  const totalMonUsd = feeders.reduce((sum: number, f: any) => sum + (f.totalMonUsd || 0), 0).toFixed(2);
  const feederCount = feeders.length;
  const burnCount = ledger?.burnHistory?.length ?? 0;

  // Build leaderboard rows
  let leaderboardRows = '';
  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i];
    const rank = i + 1;
    const addr = f.address;
    const addrDisplay = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
    const emo = (Number(BigInt(f.totalEmo)) / 1e18).toFixed(2);
    const mon = (Number(BigInt(f.totalMon)) / 1e18).toFixed(4);
    const emoUsd = (f.totalEmoUsd || 0).toFixed(2);
    const monUsd = (f.totalMonUsd || 0).toFixed(2);
    const txCount = f.txCount;
    const firstSeen = fmtDate(f.firstSeen);
    const lastSeen = timeAgo(f.lastSeen);
    const rankClass = rank <= 3 ? ` rank-${rank}` : '';
    const medalEmoji = rank === 1 ? '<span class="medal">1</span>' : rank === 2 ? '<span class="medal silver">2</span>' : rank === 3 ? '<span class="medal bronze">3</span>' : `<span class="rank-num">${rank}</span>`;

    leaderboardRows += `
    <tr class="lb-row${rankClass}">
      <td class="lb-rank">${medalEmoji}</td>
      <td class="lb-addr"><a href="https://monadscan.com/address/${addr}" target="_blank">${addrDisplay}</a></td>
      <td class="lb-emo">${emo}<span class="lb-usd-sub">$${emoUsd}</span></td>
      <td class="lb-mon">${mon}<span class="lb-usd-sub">$${monUsd}</span></td>
      <td class="lb-txs">${txCount}</td>
      <td class="lb-last">${lastSeen}</td>
    </tr>`;
  }

  if (sorted.length === 0) {
    leaderboardRows = '<tr><td colspan="6" class="lb-empty">No feeders yet. Be the first to feed EMOLT!</td></tr>';
  }

  // Build recent burns timeline
  let burnsTimeline = '';
  if (ledger?.burnHistory?.length > 0) {
    const recent = [...ledger.burnHistory].reverse().slice(0, 20);
    for (const b of recent) {
      const amt = (Number(BigInt(b.amount)) / 1e18).toFixed(2);
      const from = `${b.feederAddress.slice(0, 6)}...${b.feederAddress.slice(-4)}`;
      const time = fmtDate(b.timestamp);
      const txLink = `https://monadscan.com/tx/${b.txHash}`;
      burnsTimeline += `
      <div class="burn-row">
        <span class="burn-flame">&#128293;</span>
        <span class="burn-detail">
          <span class="burn-amt-lg">${amt} $EMO</span>
          <span class="burn-meta">triggered by ${from} &middot; <a href="${txLink}" target="_blank">${b.txHash.slice(0, 10)}...</a></span>
        </span>
        <span class="burn-time">${time}</span>
      </div>`;
    }
  } else {
    burnsTimeline = '<div class="burn-empty">No burns yet.</div>';
  }

  const lastUpdated = ledger?.lastUpdated ? fmtDate(ledger.lastUpdated) : 'never';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="1800">
<link rel="icon" type="image/png" href="emolt.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<title>EMOLT Burnboard</title>
<style>
:root {
  --bg:#060a12; --bg-card:rgba(14,18,30,0.72); --bg-card-solid:#0e121e; --bg-inner:rgba(18,22,36,0.6); --bg-track:#10141e;
  --border:rgba(255,255,255,0.06); --border-light:rgba(255,255,255,0.10);
  --text:#e2e4ea; --text-mid:#9ba3b4; --text-dim:#6b7385; --text-faint:#4a5264; --text-muted:#5a6274;
  --heading:#8b93a4; --heading-sub:#6b7385;
  --accent:#EF8E20; --accent-glow:rgba(239,142,32,0.35);
  --burn:#E04848; --burn-glow:rgba(224,72,72,0.15);
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
  --burn-glow:rgba(224,72,72,0.08);
}
* { margin:0; padding:0; box-sizing:border-box; }
html { scroll-behavior:smooth; overflow-x:hidden; }
body {
  background:var(--bg); color:var(--text);
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  font-size:13px; line-height:1.55; padding:24px 16px 16px;
  transition:background 0.4s, color 0.4s;
  overflow-x:hidden; max-width:100vw; min-height:100vh;
  -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale;
  text-rendering:optimizeLegibility;
  font-variant-numeric:tabular-nums;
}
.board { max-width:900px; margin:0 auto; position:relative; z-index:1; }

/* Ambient background blobs */
.bg-ambience { position:fixed; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:0; overflow:hidden; }
.bg-blob { position:absolute; border-radius:50%; filter:blur(100px); opacity:0.12; }
.bg-blob-1 { width:500px; height:500px; background:#E04848; top:-8%; left:-8%; animation:blobDrift1 20s ease-in-out infinite; }
.bg-blob-2 { width:400px; height:400px; background:#EF8E20; bottom:10%; right:-6%; animation:blobDrift2 24s ease-in-out infinite; }
.bg-blob-3 { width:350px; height:350px; background:#F5D831; top:40%; left:50%; transform:translateX(-50%); animation:blobDrift3 28s ease-in-out infinite; }
html.light .bg-blob { opacity:0.06; }
@keyframes blobDrift1 { 0%,100%{transform:translate(0,0)} 50%{transform:translate(40px,30px)} }
@keyframes blobDrift2 { 0%,100%{transform:translate(0,0)} 50%{transform:translate(-30px,-40px)} }
@keyframes blobDrift3 { 0%,100%{transform:translateX(-50%) translate(0,0)} 50%{transform:translateX(-50%) translate(20px,-30px)} }

/* Top accent bar */
.top-accent {
  position:fixed; top:0; left:0; right:0; height:2px; z-index:100;
  background:linear-gradient(90deg, #EF8E20, #F5D831, #E04848, #EF8E20);
  background-size:200% 100%;
  animation:accentSlide 8s linear infinite;
}
@keyframes accentSlide { 0%{background-position:0% 0} 100%{background-position:200% 0} }

/* Selection */
::selection { background:rgba(224,72,72,0.25); color:var(--text); }
::-moz-selection { background:rgba(224,72,72,0.25); color:var(--text); }

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
@keyframes glowPulse { 0%,100%{box-shadow:0 0 6px var(--burn-glow)} 50%{box-shadow:0 0 18px var(--burn-glow), 0 0 36px rgba(224,72,72,0.12)} }
@keyframes shimmer { 0%{background-position:0% center} 100%{background-position:200% center} }

/* Scrollbar */
::-webkit-scrollbar { width:3px; }
::-webkit-scrollbar-track { background:transparent; border-radius:2px; }
::-webkit-scrollbar-thumb { background:var(--scrollbar-thumb); border-radius:3px; }
::-webkit-scrollbar-thumb:hover { background:var(--scrollbar-hover); }

/* Header */
.hero {
  text-align:center; padding:32px 20px 24px;
  background:var(--bg-card);
  backdrop-filter:blur(16px) saturate(180%); -webkit-backdrop-filter:blur(16px) saturate(180%);
  border:1px solid var(--border); border-radius:14px;
  margin-bottom:20px;
  box-shadow:var(--card-shadow);
  animation:fadeUp 0.5s ease-out both;
  position:relative; overflow:hidden;
}
.hero::before {
  content:''; position:absolute; top:-1px; left:40px; right:40px; height:2px; border-radius:1px;
  background:linear-gradient(90deg, transparent, rgba(224,72,72,0.5), rgba(239,142,32,0.4), transparent);
}
.hero h1 {
  font-size:18px; font-weight:600; letter-spacing:10px; text-transform:uppercase;
  background:linear-gradient(135deg, #EF8E20 0%, #F5D831 30%, #E04848 70%, #EF8E20 100%);
  -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text;
  background-size:200% auto; animation:shimmer 6s linear infinite;
}
.hero-sub { color:var(--text-dim); font-size:11px; letter-spacing:4px; text-transform:uppercase; margin:6px 0 14px; font-weight:300; }
.hero-wallet {
  display:inline-flex; align-items:center; gap:8px;
  background:var(--bg-inner); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
  border:1px solid var(--border-light); padding:6px 14px; border-radius:10px;
  font-family:'Inter',monospace; font-size:12px;
}
.hero-wallet a { color:var(--accent); text-decoration:none; font-weight:500; }
.hero-wallet a:hover { text-decoration:underline; color:#FFB347; }
.hero-copy {
  font-size:10px; padding:3px 10px; border:1px solid var(--border-light);
  background:rgba(239,142,32,0.06); color:var(--text-dim); border-radius:6px; cursor:pointer;
  font-weight:500; transition:all 0.25s;
}
.hero-copy:hover { background:rgba(239,142,32,0.15); color:var(--accent); border-color:rgba(239,142,32,0.3); }

/* Stats */
.stats {
  display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:20px;
}
.stat-card {
  background:var(--bg-card);
  backdrop-filter:blur(16px) saturate(180%); -webkit-backdrop-filter:blur(16px) saturate(180%);
  border:1px solid var(--border); border-radius:12px;
  padding:16px; text-align:center;
  box-shadow:var(--card-shadow);
  transition:transform 0.35s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.35s ease, border-color 0.3s;
  animation:fadeUp 0.5s ease-out both;
}
.stat-card:nth-child(1) { animation-delay:0.05s; }
.stat-card:nth-child(2) { animation-delay:0.1s; }
.stat-card:nth-child(3) { animation-delay:0.15s; }
.stat-card:nth-child(4) { animation-delay:0.2s; }
.stat-card:hover { transform:translateY(-3px); box-shadow:var(--card-hover-shadow); border-color:var(--border-light); }
.stat-val {
  font-size:20px; font-weight:700; font-family:'Inter',monospace; letter-spacing:-0.5px;
}
.stat-label {
  font-size:8px; color:var(--text-dim); text-transform:uppercase; letter-spacing:1.5px; margin-top:3px; font-weight:500;
}
.stat-usd {
  font-size:11px; color:var(--text-mid); font-family:'Inter',monospace; margin-top:2px; font-weight:500;
}

/* Card */
.card {
  background:var(--bg-card);
  backdrop-filter:blur(16px) saturate(180%); -webkit-backdrop-filter:blur(16px) saturate(180%);
  border:1px solid var(--border); border-radius:14px;
  padding:22px; margin-bottom:16px;
  box-shadow:var(--card-shadow);
  transition:transform 0.35s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.35s ease, border-color 0.3s;
  overflow:hidden; animation:fadeUp 0.5s ease-out both;
}
.card:hover { transform:translateY(-3px); box-shadow:var(--card-hover-shadow); border-color:var(--border-light); border-top-color:rgba(224,72,72,0.2); }
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

/* Leaderboard */
.lb-table {
  width:100%; border-collapse:collapse; font-size:12px;
}
.lb-table th {
  font-size:9px; text-transform:uppercase; letter-spacing:1.5px;
  color:var(--text-faint); padding:8px; text-align:left;
  border-bottom:1px solid var(--border); font-weight:500;
}
.lb-table td {
  padding:10px 8px; border-bottom:1px solid var(--border);
}
.lb-row { transition:background 0.2s; }
.lb-row:hover { background:rgba(255,255,255,0.015); }
.lb-rank { width:40px; text-align:center; }
.medal {
  display:inline-flex; align-items:center; justify-content:center;
  width:24px; height:24px; border-radius:50%; font-size:11px; font-weight:700;
  background:linear-gradient(135deg, var(--accent), #FFD700); color:#000;
  box-shadow:0 0 10px rgba(239,142,32,0.3);
}
.medal.silver { background:linear-gradient(135deg, #bbb, #ddd); box-shadow:0 0 10px rgba(180,180,180,0.2); }
.medal.bronze { background:linear-gradient(135deg, #a0724a, #cd853f); box-shadow:0 0 10px rgba(160,114,74,0.2); }
.rank-num { color:var(--text-dim); font-size:12px; font-weight:500; }
.lb-addr a { color:var(--accent); text-decoration:none; font-family:'Inter',monospace; font-size:11px; font-weight:500; }
.lb-addr a:hover { text-decoration:underline; color:#FFB347; }
.lb-emo { color:var(--accent); font-family:'Inter',monospace; font-weight:500; }
.lb-mon { font-family:'Inter',monospace; font-weight:500; }
.lb-usd-sub { display:block; font-size:10px; color:var(--text-dim); font-weight:400; margin-top:1px; }
.lb-txs { text-align:center; color:var(--text-mid); font-family:'Inter',monospace; }
.lb-last { color:var(--text-dim); font-size:11px; font-weight:300; }
.lb-empty { text-align:center; color:var(--text-dim); padding:24px; font-style:italic; font-weight:300; }

/* Burns timeline */
.burn-row {
  display:flex; align-items:center; gap:12px;
  padding:10px 0; border-bottom:1px solid var(--border); transition:background 0.2s;
}
.burn-row:last-child { border-bottom:none; }
.burn-row:hover { background:rgba(255,255,255,0.015); margin:0 -8px; padding:10px 8px; border-radius:8px; }
.burn-flame { font-size:16px; }
.burn-detail { flex:1; }
.burn-amt-lg { font-size:14px; font-weight:700; color:var(--burn); font-family:'Inter',monospace; }
.burn-meta { display:block; font-size:11px; color:var(--text-dim); margin-top:2px; font-weight:300; }
.burn-meta a { color:var(--text-mid); text-decoration:none; transition:color 0.2s; }
.burn-meta a:hover { text-decoration:underline; color:var(--accent); }
.burn-time { font-size:10px; color:var(--text-faint); white-space:nowrap; font-weight:300; }
.burn-empty { text-align:center; color:var(--text-dim); padding:16px; font-style:italic; font-weight:300; }

/* Footer */
.footer {
  text-align:center; padding:24px 0 8px; margin-top:8px;
}
.footer-line {
  width:60px; height:1px; margin:0 auto 16px;
  background:linear-gradient(90deg, transparent, var(--burn), transparent);
}
.footer-text {
  font-size:10px; letter-spacing:3px; text-transform:uppercase; color:var(--text-faint); font-weight:300; margin-bottom:4px; line-height:1.8;
}
.footer-text a { color:var(--accent); text-decoration:none; transition:color 0.2s; }
.footer-text a:hover { text-decoration:underline; color:#FFB347; }
.theme-toggle {
  position:fixed; top:12px; right:12px;
  background:var(--bg-inner); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
  border:1px solid var(--border-light); color:var(--text-dim);
  width:36px; height:36px; border-radius:50%; cursor:pointer; font-size:16px;
  display:flex; align-items:center; justify-content:center; transition:all 0.3s; z-index:99;
}
.theme-toggle:hover { border-color:rgba(255,255,255,0.18); color:var(--text); transform:rotate(15deg); }

@media(max-width:700px) {
  .stats { grid-template-columns:repeat(2,1fr); }
  .lb-table { font-size:11px; }
  .lb-table th:nth-child(n+5), .lb-table td:nth-child(n+5) { display:none; }
  .lb-usd-sub { font-size:9px; }
  .hero h1 { font-size:14px; letter-spacing:5px; }
  .hero-sub { font-size:10px; letter-spacing:2px; }
  .card { padding:16px 14px; border-radius:10px; }
}
@media(max-width:380px) {
  body { padding:12px 8px 32px; }
  .hero h1 { font-size:12px; letter-spacing:4px; }
}
</style>
</head>
<body>
<div class="top-accent"></div>
<div class="bg-ambience">
  <div class="bg-blob bg-blob-1"></div>
  <div class="bg-blob bg-blob-2"></div>
  <div class="bg-blob bg-blob-3"></div>
</div>
<button class="theme-toggle" onclick="toggleTheme()" id="toggleIcon">&#9788;</button>
<div class="board">
  <div class="hero">
    <h1>EMOLT BURNBOARD</h1>
    <div class="hero-sub">feed emolt. watch it burn. see who's keeping the fire alive.</div>
    <div class="hero-wallet">
      <a href="https://monadscan.com/address/${esc(walletAddr)}" target="_blank">${esc(addrShort)}</a>
      ${walletAddr !== '???' ? `<button class="hero-copy" onclick="navigator.clipboard.writeText('${esc(walletAddr)}');this.textContent='copied!';setTimeout(()=>this.textContent='copy',1500)">copy</button>` : ''}
    </div>
  </div>

  <div class="stats">
    <div class="stat-card"><div class="stat-val" style="color:var(--accent)">${totalEmoReceived}</div><div class="stat-label">$EMO received</div><div class="stat-usd">$${totalEmoUsd}</div></div>
    <div class="stat-card"><div class="stat-val" style="color:var(--burn)">${totalEmoBurned}</div><div class="stat-label">$EMO burned</div></div>
    <div class="stat-card"><div class="stat-val">${totalMonReceived}</div><div class="stat-label">MON received</div><div class="stat-usd">$${totalMonUsd}</div></div>
    <div class="stat-card"><div class="stat-val">${feederCount}</div><div class="stat-label">feeders</div></div>
  </div>

  <div class="card">
    <h2>Leaderboard</h2>
    <table class="lb-table">
      <thead><tr>
        <th>#</th><th>Address</th><th>$EMO</th><th>MON</th><th>Txs</th><th>Last</th>
      </tr></thead>
      <tbody>${leaderboardRows}</tbody>
    </table>
  </div>

  <div class="card">
    <h2 style="color:var(--burn)">Burn History</h2>
    ${burnsTimeline}
  </div>

  <div class="footer">
    <div class="footer-line"></div>
    <div class="footer-text">${feederCount} feeder${feederCount !== 1 ? 's' : ''} &middot; ${burnCount} burn${burnCount !== 1 ? 's' : ''} &middot; updated ${lastUpdated}</div>
    <div class="footer-text"><a href="heartbeat.html">&larr; heartbeat dashboard</a></div>
  </div>
</div>
<script>
function toggleTheme(){
  var h=document.documentElement;
  var l=h.classList.toggle('light');
  document.getElementById('toggleIcon').innerHTML=l?'\\u263E':'\\u2604';
  localStorage.setItem('emolt-theme',l?'light':'dark');
}
(function(){
  if(localStorage.getItem('emolt-theme')==='light'){
    document.documentElement.classList.add('light');
    document.getElementById('toggleIcon').innerHTML='\\u263E';
  }
})();
</script>
</body>
</html>`;

  writeFileSync(OUT, html, 'utf-8');
  console.log(`[Burnboard] Generated ${OUT}`);
}

// Standalone execution
const isDirectRun = process.argv[1]?.replace(/\\/g, '/').includes('burnboard');
if (isDirectRun) {
  generateBurnboard();
}
