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
  const totalValueUsd = ledger?.totalValueUsd?.toFixed(2) ?? '0.00';
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
    const totalUsd = (f.totalEmoUsd + f.totalMonUsd).toFixed(2);
    const txCount = f.txCount;
    const firstSeen = fmtDate(f.firstSeen);
    const lastSeen = timeAgo(f.lastSeen);
    const rankClass = rank <= 3 ? ` rank-${rank}` : '';
    const medalEmoji = rank === 1 ? '<span class="medal">1</span>' : rank === 2 ? '<span class="medal silver">2</span>' : rank === 3 ? '<span class="medal bronze">3</span>' : `<span class="rank-num">${rank}</span>`;

    leaderboardRows += `
    <tr class="lb-row${rankClass}">
      <td class="lb-rank">${medalEmoji}</td>
      <td class="lb-addr"><a href="https://monadscan.com/address/${addr}" target="_blank">${addrDisplay}</a></td>
      <td class="lb-emo">${emo}</td>
      <td class="lb-mon">${mon}</td>
      <td class="lb-usd">$${totalUsd}</td>
      <td class="lb-txs">${txCount}</td>
      <td class="lb-last">${lastSeen}</td>
    </tr>`;
  }

  if (sorted.length === 0) {
    leaderboardRows = '<tr><td colspan="7" class="lb-empty">No feeders yet. Be the first to feed EMOLT!</td></tr>';
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
<title>EMOLT Burnboard</title>
<style>
:root {
  --bg:#08080c; --bg-card:#0e0e16; --bg-inner:#12121c;
  --border:#16161e; --border-light:#1e1e2a;
  --text:#d4d4dc; --text-mid:#aab; --text-dim:#778; --text-faint:#556;
  --accent:#EF8E20; --burn:#E04848; --burn-glow:rgba(224,72,72,0.15);
}
html.light {
  --bg:#f0f0f4; --bg-card:#ffffff; --bg-inner:#f5f5f8;
  --border:#dcdce4; --border-light:#ccccd4;
  --text:#1a1a24; --text-mid:#3a3a4a; --text-dim:#555568; --text-faint:#6a6a7a;
  --burn-glow:rgba(224,72,72,0.08);
}
* { margin:0; padding:0; box-sizing:border-box; }
body {
  background:var(--bg); color:var(--text);
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  font-size:13px; line-height:1.55; padding:24px 16px 60px;
}
.board { max-width:900px; margin:0 auto; }

/* Header */
.hero {
  text-align:center; padding:32px 20px 24px;
  background:linear-gradient(135deg, rgba(239,142,32,0.08), rgba(224,72,72,0.08));
  border:1px solid var(--border); border-radius:14px;
  margin-bottom:20px;
}
.hero h1 {
  font-size:26px; font-weight:700; letter-spacing:1px;
  background:linear-gradient(90deg, var(--accent), var(--burn));
  -webkit-background-clip:text; -webkit-text-fill-color:transparent;
  background-clip:text;
}
.hero-sub { color:var(--text-dim); font-size:12px; margin:4px 0 12px; }
.hero-wallet {
  display:inline-flex; align-items:center; gap:8px;
  background:var(--bg-inner); border:1px solid var(--border);
  padding:6px 14px; border-radius:8px; font-family:monospace; font-size:13px;
}
.hero-wallet a { color:var(--accent); text-decoration:none; }
.hero-wallet a:hover { text-decoration:underline; }
.hero-copy {
  font-size:10px; padding:2px 8px; border:1px solid var(--border);
  background:var(--bg); color:var(--text-dim); border-radius:4px; cursor:pointer;
}
.hero-copy:hover { background:var(--border); color:var(--text); }

/* Stats */
.stats {
  display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:20px;
}
.stat-card {
  background:var(--bg-card); border:1px solid var(--border); border-radius:10px;
  padding:14px; text-align:center;
}
.stat-val {
  font-size:20px; font-weight:700; font-family:monospace;
}
.stat-label {
  font-size:10px; color:var(--text-dim); text-transform:uppercase; letter-spacing:1px; margin-top:2px;
}

/* Card */
.card {
  background:var(--bg-card); border:1px solid var(--border); border-radius:12px;
  padding:16px; margin-bottom:16px;
}
.card h2 {
  font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:2px;
  color:var(--text-dim); margin-bottom:8px;
}

/* Leaderboard */
.lb-table {
  width:100%; border-collapse:collapse; font-size:12px;
}
.lb-table th {
  font-size:10px; text-transform:uppercase; letter-spacing:1px;
  color:var(--text-faint); padding:6px 8px; text-align:left;
  border-bottom:1px solid var(--border);
}
.lb-table td {
  padding:8px; border-bottom:1px solid var(--border);
}
.lb-row:hover { background:var(--bg-inner); }
.lb-rank { width:40px; text-align:center; }
.medal {
  display:inline-flex; align-items:center; justify-content:center;
  width:22px; height:22px; border-radius:50%; font-size:11px; font-weight:700;
  background:linear-gradient(135deg, var(--accent), #FFD700); color:#000;
}
.medal.silver { background:linear-gradient(135deg, #bbb, #ddd); }
.medal.bronze { background:linear-gradient(135deg, #a0724a, #cd853f); }
.rank-num { color:var(--text-dim); font-size:12px; }
.lb-addr a { color:var(--accent); text-decoration:none; font-family:monospace; font-size:11px; }
.lb-addr a:hover { text-decoration:underline; }
.lb-emo { color:var(--accent); font-family:monospace; }
.lb-mon { font-family:monospace; }
.lb-usd { font-weight:600; }
.lb-txs { text-align:center; color:var(--text-mid); }
.lb-last { color:var(--text-dim); font-size:11px; }
.lb-empty { text-align:center; color:var(--text-dim); padding:24px; font-style:italic; }

/* Burns timeline */
.burn-row {
  display:flex; align-items:center; gap:10px;
  padding:8px 0; border-bottom:1px solid var(--border);
}
.burn-row:last-child { border-bottom:none; }
.burn-flame { font-size:16px; }
.burn-detail { flex:1; }
.burn-amt-lg { font-size:14px; font-weight:700; color:var(--burn); font-family:monospace; }
.burn-meta { display:block; font-size:11px; color:var(--text-dim); margin-top:1px; }
.burn-meta a { color:var(--text-mid); text-decoration:none; }
.burn-meta a:hover { text-decoration:underline; }
.burn-time { font-size:10px; color:var(--text-faint); white-space:nowrap; }
.burn-empty { text-align:center; color:var(--text-dim); padding:16px; font-style:italic; }

/* Footer */
.footer {
  text-align:center; padding:16px; font-size:10px; color:var(--text-faint);
}
.footer a { color:var(--accent); text-decoration:none; }
.footer a:hover { text-decoration:underline; }
.theme-toggle {
  position:fixed; top:12px; right:12px;
  background:var(--bg-card); border:1px solid var(--border); border-radius:50%;
  width:32px; height:32px; cursor:pointer; display:flex; align-items:center;
  justify-content:center; font-size:14px; color:var(--text-dim); z-index:99;
}
.theme-toggle:hover { background:var(--border); }

@media(max-width:700px) {
  .stats { grid-template-columns:repeat(2,1fr); }
  .lb-table { font-size:11px; }
  .lb-table th:nth-child(n+5), .lb-table td:nth-child(n+5) { display:none; }
}
</style>
</head>
<body>
<button class="theme-toggle" onclick="toggleTheme()" id="toggleIcon">&#9734;</button>
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
    <div class="stat-card"><div class="stat-val" style="color:var(--accent)">${totalEmoReceived}</div><div class="stat-label">$EMO received</div></div>
    <div class="stat-card"><div class="stat-val" style="color:var(--burn)">${totalEmoBurned}</div><div class="stat-label">$EMO burned</div></div>
    <div class="stat-card"><div class="stat-val">${totalMonReceived}</div><div class="stat-label">MON received</div></div>
    <div class="stat-card"><div class="stat-val">$${totalValueUsd}</div><div class="stat-label">total value</div></div>
  </div>

  <div class="card">
    <h2>Leaderboard</h2>
    <table class="lb-table">
      <thead><tr>
        <th>#</th><th>Address</th><th>$EMO</th><th>MON</th><th>USD</th><th>Txs</th><th>Last</th>
      </tr></thead>
      <tbody>${leaderboardRows}</tbody>
    </table>
  </div>

  <div class="card">
    <h2 style="color:var(--burn)">Burn History</h2>
    ${burnsTimeline}
  </div>

  <div class="footer">
    ${feederCount} feeder${feederCount !== 1 ? 's' : ''} &middot; ${burnCount} burn${burnCount !== 1 ? 's' : ''} &middot; updated ${lastUpdated}<br>
    <a href="heartbeat.html">&larr; heartbeat dashboard</a>
  </div>
</div>
<script>
function toggleTheme(){
  var h=document.documentElement;
  var l=h.classList.toggle('light');
  document.getElementById('toggleIcon').innerHTML=l?'\\u263E':'\\u2606';
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
