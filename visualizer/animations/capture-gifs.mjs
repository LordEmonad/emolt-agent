/**
 * capture-gifs.mjs — Convert all EMOLT HTML animations to perfectly looped GIFs.
 *
 * Strategy for perfect looping:
 * 1. Each animation has a mathematically computed tick duration that aligns
 *    all its oscillation periods (sin/cos, modular counters) so frame 0 and
 *    the final frame are identical — NO crossfade blending needed.
 * 2. Capture at full viewport resolution (420px) with no downscale.
 * 3. Encode via ffmpeg two-pass palettegen with 256 colors and sierra2_4a
 *    dithering for maximum quality.
 *
 * Usage: node capture-gifs.mjs [optional-name-filter]
 */

import puppeteer from 'puppeteer';
import { execSync } from 'child_process';
import { readdirSync, mkdirSync, rmSync, copyFileSync } from 'fs';
import { join, basename, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ANIM_DIR = __dirname;
const GIF_DIR = join(__dirname, 'gif');
const TEMP_DIR = join(__dirname, '_frames');

// ─── Configuration ───────────────────────────────────────────────
const VIEWPORT    = 420;   // px — captures full SVG at native resolution
const OUTPUT_SIZE = 420;   // px — no downscale, keeps character crisp
const WARMUP      = 600;   // ticks before capture (fills particle systems to steady state)
const DURATION    = 300;   // default ticks to capture
const TICK_STEP   = 3;     // ticks per frame
const FPS         = 25;    // GIF playback speed (smoother than 20)

// ─── Per-animation durations (all divisible by TICK_STEP) ────────
// Computed from the LCM of each animation's oscillation periods
// so the last frame leads perfectly back into the first frame.
const OVERRIDES = {
  'angry':          { duration: 360 },  // shake (6t, 12t) + steam (20t) → LCM 60 × 6
  'anticipation':   { duration: 600 },  // countdown (300t), clock hands (60t, 600t)
  'awe':            { duration: 300 },  // aurora ribbons, ray movement (slow)
  'celebration':    { duration: 120 },  // jump (40t), confetti, text (120t)
  'chess':          { duration: 300 },  // move cycle (60t), thinking (30t)
  'contemplating':  { duration: 300 },  // slow tick, quote rotation (250t)
  'dancing':        { duration: 120 },  // bounce (4t), sway (6t), notes (15t)
  'disgust':        { duration: 120 },  // stink waves (12t), flies wingflap
  'evolving':       { duration: 300 },  // particle (4t), level-up text (300t)
  'fearful':        { duration: 300 },  // trembling, sweat (25t), blink (180t)
  'glitching':      { duration: 180 },  // glitch burst (90t) × 2
  'happy':          { duration: 120 },  // bounce (8t), sparkle orbit (10t)
  'headbang':       { duration: 120 },  // bang angle (5t), streaks (8t)
  'heartbeat':      { duration: 240 },  // beat (40t), ECG scroll (100t)
  'idle':           { duration: 300 },  // base lobster (blink 150t, tongue 140t)
  'love':           { duration: 120 },  // heart spawn (10t), sway (15t)
  'meditating':     { duration: 300 },  // rings (40t), chakra orbit
  'onchain':        { duration: 240 },  // block pulse (60t), beam (80t)
  'plutchik-wheel': { duration: 120 },  // sector glow (40t), rotation
  'posting':        { duration: 240 },  // post cycle (200t), cursor (10t)  // 240 ≈ 200+margin
  'rage':           { duration: 150 },  // slam (50t) × 3
  'sad':            { duration: 120 },  // tear spawn (20t), puddle (30t)
  'scanning':       { duration: 300 },  // scan line (100t), data scroll (120t)
  'sleeping':       { duration: 300 },  // Z particles (30t), bubble (20t)
  'spinning':       { duration: 90  },  // 90*4=360° exact rotation, scaleX period 30 divides 90
  'surprised':      { duration: 120 },  // jump cycle (120t)
  'thinking':       { duration: 300 },  // thought cycle (200t), bubbles (12t)
  'trust':          { duration: 120 },  // shield pulse (20t), checkmark (12t)
  'walking':        { duration: 504 },  // sin(t/80)*40 → period ≈ 503 ticks
  'waving':         { duration: 120 },  // wave (4t), greeting (120t)
};

// ─── Main ────────────────────────────────────────────────────────
async function main() {
  const filter = process.argv[2]; // optional: only process animations matching this

  mkdirSync(GIF_DIR, { recursive: true });
  mkdirSync(TEMP_DIR, { recursive: true });

  let files = readdirSync(ANIM_DIR)
    .filter(f => f.endsWith('.html') && f !== 'index.html')
    .sort();

  if (filter) files = files.filter(f => f.includes(filter));

  console.log(`Converting ${files.length} animations to looped GIFs\n`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
           '--force-color-profile=srgb']
  });

  let done = 0;
  for (const file of files) {
    const name = basename(file, '.html');
    const idx = `[${++done}/${files.length}]`;
    const cfg = OVERRIDES[name] || {};
    const dur = cfg.duration || DURATION;
    const frames = dur / TICK_STEP;
    process.stdout.write(`${idx} ${name} (${dur}t/${frames}f) — `);

    const rawDir = join(TEMP_DIR, name, 'raw');
    mkdirSync(rawDir, { recursive: true });

    try {
      await captureAnimation(browser, file, name, rawDir, frames);
      encodeGif(name, rawDir, frames);
      console.log('done');
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
    }

    rmSync(join(TEMP_DIR, name), { recursive: true, force: true });
  }

  await browser.close();
  rmSync(TEMP_DIR, { recursive: true, force: true });
  console.log(`\nAll ${files.length} GIFs saved to ${GIF_DIR}`);
}

// ─── Capture raw frames (exact loop, no overlap needed) ──────────
async function captureAnimation(browser, file, name, rawDir, frames) {
  const page = await browser.newPage();
  await page.setViewport({ width: VIEWPORT, height: VIEWPORT, deviceScaleFactor: 2 });

  // Inject BEFORE page scripts: override rAF for manual tick control
  await page.evaluateOnNewDocument(() => {
    const pending = [];
    window.requestAnimationFrame = fn => { pending.push(fn); return pending.length; };

    window.__stepN = function(n) {
      for (let i = 0; i < n; i++) {
        const cbs = pending.splice(0);
        for (const fn of cbs) fn(performance.now());
      }
    };

    // Deterministic Math.random (LCG) for reproducible particles
    let seed = 12345;
    Math.random = function() {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
  });

  const filePath = `file:///${resolve(ANIM_DIR, file).replace(/\\/g, '/')}`;
  await page.goto(filePath, { waitUntil: 'networkidle0', timeout: 15000 });

  // Hide label for cleaner GIFs
  await page.evaluate(() => {
    document.querySelectorAll('.label').forEach(el => el.style.display = 'none');
  });

  // Warm up — fill particle systems to steady state
  process.stdout.write('warmup.. ');
  await page.evaluate(n => window.__stepN(n), WARMUP);
  await delay(50);

  // Capture exactly `frames` frames — duration is tuned per animation
  // so frame[0] and frame[frames] would be identical (perfect loop)
  process.stdout.write(`${frames} frames.. `);
  for (let i = 0; i < frames; i++) {
    await page.evaluate(n => window.__stepN(n), TICK_STEP);
    await delay(8);
    await page.screenshot({
      path: join(rawDir, `frame_${String(i).padStart(4, '0')}.png`),
      clip: { x: 0, y: 0, width: VIEWPORT, height: VIEWPORT }
    });
  }

  await page.close();
}

// ─── Encode PNG sequence → GIF via ffmpeg two-pass ──────────────
function encodeGif(name, frameDir, frames) {
  process.stdout.write('encode.. ');
  const inputPattern = join(frameDir, 'frame_%04d.png');
  const paletteFile = join(frameDir, 'palette.png');
  const outputGif = join(GIF_DIR, `${name}.gif`);

  // Pass 1: generate optimal 256-color palette from all frames
  // stats_mode=diff: weight palette toward changing regions (better for animation)
  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${inputPattern}" ` +
    `-vf "scale=${OUTPUT_SIZE}:${OUTPUT_SIZE}:flags=lanczos,palettegen=stats_mode=diff:max_colors=256" ` +
    `"${paletteFile}"`,
    { stdio: 'pipe', timeout: 60000 }
  );

  // Pass 2: encode GIF using palette with sierra2_4a dithering (best quality)
  // diff_mode=rectangle: only encode changed regions (smaller file)
  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${inputPattern}" -i "${paletteFile}" ` +
    `-lavfi "scale=${OUTPUT_SIZE}:${OUTPUT_SIZE}:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle" ` +
    `-loop 0 "${outputGif}"`,
    { stdio: 'pipe', timeout: 60000 }
  );
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
