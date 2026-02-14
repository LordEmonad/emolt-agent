const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// All 29 animations with their LOOP values
const anims = [
  { file: 'happy.html', name: 'happy', loop: 240 },
  { file: 'sad.html', name: 'sad', loop: 300 },
  { file: 'angry.html', name: 'angry', loop: 180 },
  { file: 'fearful.html', name: 'fearful', loop: 300 },
  { file: 'trust.html', name: 'trust', loop: 240, width: 500 },
  { file: 'disgust.html', name: 'disgust', loop: 180 },
  { file: 'surprised.html', name: 'surprised', loop: 240 },
  { file: 'anticipation.html', name: 'anticipation', loop: 300 },
  { file: 'love.html', name: 'love', loop: 240 },
  { file: 'awe.html', name: 'awe', loop: 300 },
  { file: 'rage.html', name: 'rage', loop: 250 },
  { file: 'contemplating.html', name: 'contemplating', loop: 300 },
  { file: 'idle.html', name: 'idle', loop: 360 },
  { file: 'walking.html', name: 'walking', loop: 300 },
  { file: 'waving.html', name: 'waving', loop: 120 },
  { file: 'dancing.html', name: 'dancing', loop: 180 },
  { file: 'celebration.html', name: 'celebration', loop: 240 },
  { file: 'spinning.html', name: 'spinning', loop: 360 },
  { file: 'headbang.html', name: 'headbang', loop: 180 },
  { file: 'sleeping.html', name: 'sleeping', loop: 300 },
  { file: 'meditating.html', name: 'meditating', loop: 240 },
  { file: 'heartbeat.html', name: 'heartbeat', loop: 200 },
  { file: 'evolving.html', name: 'evolving', loop: 300 },
  { file: 'scanning.html', name: 'scanning', loop: 300 },
  { file: 'posting.html', name: 'posting', loop: 240 },
  { file: 'onchain.html', name: 'onchain', loop: 240 },
  { file: 'thinking.html', name: 'thinking', loop: 300 },
  { file: 'chess.html', name: 'chess', loop: 240 },
  { file: 'glitching.html', name: 'glitching', loop: 180 },
];

const STEP = 3;          // Capture every 3rd tick → 20fps (faster capture, smaller GIFs)
const GIF_FPS = 20;      // Output GIF framerate
const BASE_DIR = __dirname;
const GIF_DIR = path.join(BASE_DIR, 'gif');
const TMP_BASE = path.join(BASE_DIR, '_tmp_frames');
const FFMPEG = 'ffmpeg';

// For LOOPs not divisible by 3, use step=2
function getStep(loop) {
  return loop % 3 === 0 ? 3 : 2;
}
function getFps(loop) {
  return loop % 3 === 0 ? 20 : 30;
}

async function captureAnimation(page, anim) {
  const tag = `[${anim.name}]`;
  const frameDir = path.join(TMP_BASE, anim.name);
  fs.mkdirSync(frameDir, { recursive: true });

  const vpWidth = anim.width || 400;
  const vpHeight = 400;
  const step = getStep(anim.loop);
  const fps = getFps(anim.loop);

  await page.setViewport({ width: vpWidth, height: vpHeight });

  const filePath = `file:///${path.join(BASE_DIR, anim.file).replace(/\\/g, '/')}`;
  await page.goto(filePath, { waitUntil: 'load', timeout: 30000 });

  // Hide the label for clean GIFs
  await page.addStyleTag({ content: '.label { display: none !important; }' });

  // Wait for initial render
  await new Promise(r => setTimeout(r, 200));

  const frameCount = anim.loop / step;
  console.log(`${tag} Capturing ${frameCount} frames (LOOP=${anim.loop}, step=${step}, ${fps}fps)...`);

  for (let i = 0; i < frameCount; i++) {
    // Advance 'step' ticks
    await page.evaluate((n) => { for (let s = 0; s < n; s++) window.__step(); }, step);

    // Wait for SVG render
    await new Promise(r => setTimeout(r, 16));

    await page.screenshot({
      path: path.join(frameDir, `frame_${String(i).padStart(5, '0')}.png`),
      clip: { x: 0, y: 0, width: vpWidth, height: vpHeight },
    });

    // Progress indicator every 25%
    if (i > 0 && i % Math.floor(frameCount / 4) === 0) {
      console.log(`${tag}   ${Math.round(i/frameCount*100)}%`);
    }
  }

  // Encode GIF using ffmpeg 2-pass palettegen
  const outputGif = path.join(GIF_DIR, `${anim.name}.gif`);
  const paletteFile = path.join(frameDir, 'palette.png');
  const inputPattern = path.join(frameDir, 'frame_%05d.png');

  console.log(`${tag} Encoding GIF...`);

  execSync(
    `"${FFMPEG}" -y -framerate ${fps} -i "${inputPattern}" -vf "palettegen=stats_mode=diff:max_colors=256" "${paletteFile}"`,
    { stdio: 'pipe' }
  );

  execSync(
    `"${FFMPEG}" -y -framerate ${fps} -i "${inputPattern}" -i "${paletteFile}" -lavfi "[0:v][1:v] paletteuse=dither=sierra2_4a:diff_mode=rectangle" -loop 0 "${outputGif}"`,
    { stdio: 'pipe' }
  );

  // Clean up
  const files = fs.readdirSync(frameDir);
  files.forEach(f => fs.unlinkSync(path.join(frameDir, f)));
  fs.rmdirSync(frameDir);

  const gifSize = (fs.statSync(outputGif).size / 1024).toFixed(0);
  console.log(`${tag} Done → ${anim.name}.gif (${frameCount} frames, ${gifSize} KB)`);
  return gifSize;
}

async function main() {
  console.log(`\nEMOLT GIF Capture — ${anims.length} animations\n`);

  fs.mkdirSync(GIF_DIR, { recursive: true });
  fs.mkdirSync(TMP_BASE, { recursive: true });

  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 300000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  // Use a SINGLE page, reused for each animation (avoids multi-page resource pressure)
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);

  // Override rAF once — it persists across navigations via evaluateOnNewDocument
  await page.evaluateOnNewDocument(() => {
    window.__rafQueue = [];
    window.requestAnimationFrame = (cb) => {
      window.__rafQueue.push(cb);
      return window.__rafQueue.length;
    };
    window.__step = () => {
      const cbs = [...window.__rafQueue];
      window.__rafQueue = [];
      const now = performance.now();
      cbs.forEach(cb => cb(now));
    };
  });

  let completed = 0;
  for (const anim of anims) {
    try {
      await captureAnimation(page, anim);
      completed++;
    } catch (err) {
      console.error(`[${anim.name}] FAILED: ${err.message}`);
    }
  }

  await page.close();
  await browser.close();

  // Clean up temp directory
  try { fs.rmdirSync(TMP_BASE); } catch(e) {}

  // Summary
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Completed: ${completed}/${anims.length} GIFs → ${GIF_DIR}`);
  const gifs = fs.readdirSync(GIF_DIR).filter(f => f.endsWith('.gif'));
  let totalSize = 0;
  gifs.forEach(g => { totalSize += fs.statSync(path.join(GIF_DIR, g)).size; });
  console.log(`Total: ${gifs.length} GIFs, ${(totalSize/1024/1024).toFixed(1)} MB`);
  console.log(`${'='.repeat(50)}\n`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
