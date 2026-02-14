/**
 * EMOLT Lobster — Shared SVG drawing module for all animations.
 * Each animation HTML file loads this and calls drawLobster() per frame.
 */

const rd='#cc3333', rl='#e04545', rk='#8b1a1a', rp='#5c1010', bl='#e86655', hr='#0a0a12', pp='#7c3aed';

/**
 * Draw the EMOLT lobster as SVG markup string.
 * @param {object} opts
 * @param {number} opts.t - tick counter
 * @param {boolean} opts.walking - enable walking animation
 * @param {string} opts.mood - 'neutral'|'happy'|'sad'|'angry'|'surprised'|'fearful'
 * @param {boolean} opts.showHair - show emo hair (default true)
 * @param {string} opts.color - override body color
 * @param {number} opts.extraBob - extra vertical offset
 * @param {number} opts.extraRotate - extra body rotation
 * @param {number} opts.clawOpenL - extra left claw open angle
 * @param {number} opts.clawOpenR - extra right claw open angle
 * @param {number} opts.squash - vertical squash factor (1=normal)
 * @param {number} opts.stretch - horizontal stretch factor (1=normal)
 * @param {boolean} opts.flipX - flip horizontally
 * @returns {string} SVG markup
 */
function drawLobster(opts = {}) {
  const {
    t = 0, walking = false, mood = 'neutral', showHair = true,
    color, extraBob = 0, extraRotate = 0, clawOpenL = 0, clawOpenR = 0,
    squash = 1, stretch = 1, flipX = false
  } = opts;

  const c_rd = color || rd;
  const c_rl = color ? lighten(color) : rl;
  const c_rk = color ? darken(color) : rk;
  const c_rp = color ? darken(color, 0.3) : rp;
  const c_bl = color ? lighten(color, 0.3) : bl;

  const w = walking;
  const bob = (w ? Math.sin(t/2.8)*2.5 : Math.sin(t/18)*0.8) + extraBob;
  const br = Math.sin(t/24)*0.5;
  const cs = w ? Math.sin(t/4.4)*12 : Math.sin(t/28)*4;
  const ht = Math.sin(t/35)*1.2;
  const aL = Math.sin(t/9)*3+Math.sin(t/23);
  const aR = Math.cos(t/11)*3+Math.cos(t/19);
  const hs = Math.sin(t/22)*1.8+Math.sin(t/41)*0.6;
  const bc = t%150;
  // Blink: fast close (4t), hold (3t), smooth open (12t), rest (131t)
  const bk = bc<4 ? Math.sin(bc/4*Math.PI/2)        // close: sine ease-in (fast snap shut)
           : bc<7 ? 1                                 // hold closed
           : bc<19 ? (function(p){return 1-p*p*(3-2*p)})((bc-7)/12)  // open: smoothstep
           : 0;

  let eyeOpenness = 1-bk;
  let mouthCurve = 0;
  let eyeScale = 1;
  if(mood==='sad'){eyeOpenness*=0.7;mouthCurve=1.5;}
  if(mood==='surprised'){eyeScale=1.25;}
  if(mood==='angry'){eyeOpenness*=0.85;mouthCurve=-1;}
  if(mood==='happy'){mouthCurve=-0.8;}
  if(mood==='fearful'){eyeScale=1.15;eyeOpenness*=0.85;}

  const eo = eyeOpenness;
  const elx = Math.sin(t/40);
  const ely = Math.cos(t/50)*0.5;
  const tc = (t%140)/140;
  const tp = tc<0.3?0:tc<0.7?(tc-0.3)/0.4:1;
  const tf = tc>0.85?(1-tc)/0.15:tc<0.3?0:1;
  const td = tp*tp;
  const cf = Math.sin(t/45)*2+(Math.sin(t/7)>0.95?3:0);
  const leftClawR = -18+cs+cf*0.3+clawOpenL;
  const rightClawR = 18-cs-cf*0.3+clawOpenR;

  const sx = flipX ? -stretch : stretch;

  let svg = `<g transform="translate(0,${bob}) scale(${sx},${squash}) rotate(${extraRotate})">`;
  // shadow
  svg += `<ellipse cx="0" cy="33" rx="${19-bob*0.4}" ry="${4.5+bob*0.2}" fill="#000" opacity="0.14"/>`;
  // tail
  svg += `<path d="M-6,20 C${-8+Math.sin(t/30)*0.4},23 -9,25 -7,28 C-5,30 -3,29 -1.5,28 C-0.5,29.5 0.5,29.5 1.5,28 C3,29 5,30 7,28 C9,25 ${8+Math.sin(t/30)*0.4},23 6,20 C3,21.5 -3,21.5 -6,20 Z" fill="${c_rd}" stroke="${c_rk}" stroke-width="0.4"/>`;
  svg += `<path d="M-3.5,21.5 C-4,24 -3.5,26 -3,27.5" fill="none" stroke="${c_rk}" stroke-width="0.3" opacity="0.2"/>`;
  svg += `<path d="M0,21.5 C0,24 0,26 0,28" fill="none" stroke="${c_rk}" stroke-width="0.3" opacity="0.2"/>`;
  svg += `<path d="M3.5,21.5 C4,24 3.5,26 3,27.5" fill="none" stroke="${c_rk}" stroke-width="0.3" opacity="0.2"/>`;
  // antennae
  svg += `<path d="M-2,-17 C${-4+aL*0.2},-22 ${-6+aL*0.5},-28 ${-9+aL},-35" fill="none" stroke="${c_rd}" stroke-width="1.3" stroke-linecap="round"/>`;
  svg += `<circle cx="${-9+aL}" cy="-35.5" r="5" fill="${pp}" fill-opacity="${(0.45+Math.sin(t/7)*0.25)*0.2}"/>`;
  svg += `<circle cx="${-9+aL}" cy="-35.5" r="2.3" fill="${pp}" fill-opacity="${0.45+Math.sin(t/7)*0.25}"/>`;
  svg += `<path d="M7,-15 C${9+aR*0.2},-20 ${11+aR*0.5},-26 ${13+aR},-32" fill="none" stroke="${c_rd}" stroke-width="1.3" stroke-linecap="round"/>`;
  svg += `<circle cx="${13+aR}" cy="-32.5" r="5" fill="${pp}" fill-opacity="${(0.45+Math.cos(t/8)*0.25)*0.2}"/>`;
  svg += `<circle cx="${13+aR}" cy="-32.5" r="2.3" fill="${pp}" fill-opacity="${0.45+Math.cos(t/8)*0.25}"/>`;
  // legs
  [-10,-5,5,10].forEach((lx,i) => {
    const ph = w ? Math.sin(t/1.8+i*1.5) : Math.sin(t/40+i*2)*0.5;
    const ex = lx+ph*(w?6:1)+(lx<0?-5:5);
    const ey = 29+Math.abs(ph)*(w?2.5:0.3);
    svg += `<path d="M${lx},17 Q${lx+(lx<0?-2:2)+ph*(w?2:0.3)},23 ${ex},${ey}" fill="none" stroke="${c_rd}" stroke-width="2.2" stroke-linecap="round"/>`;
    svg += `<circle cx="${ex}" cy="${ey+0.8}" r="1.3" fill="${c_rk}"/>`;
  });
  // left claw
  svg += `<g transform="rotate(${leftClawR},-14,2)">`;
  svg += `<path d="M-14,2 C-17,1 -20,0 -26,-1" fill="none" stroke="${c_rd}" stroke-width="4" stroke-linecap="round"/>`;
  svg += `<ellipse cx="-32" cy="-1" rx="9" ry="6" fill="${c_rd}" stroke="${c_rk}" stroke-width="0.7"/>`;
  svg += `<ellipse cx="-31" cy="-2.5" rx="5" ry="3" fill="${c_rl}" opacity="0.15"/>`;
  svg += `<path d="M-37,-5 C-40,-9 -43,-8 -42,-5 C-41,-3 -39,-1 -37,-1" fill="${c_rd}" stroke="${c_rk}" stroke-width="0.5"/>`;
  svg += `<path d="M-37,3 C-40,7 -43,6 -42,3 C-41,1 -39,-1 -37,-1" fill="${c_rd}" stroke="${c_rk}" stroke-width="0.5"/>`;
  svg += `</g>`;
  // right claw
  svg += `<g transform="rotate(${rightClawR},14,2)">`;
  svg += `<path d="M14,2 C17,1 20,0 26,-1" fill="none" stroke="${c_rd}" stroke-width="4" stroke-linecap="round"/>`;
  svg += `<ellipse cx="32" cy="-1" rx="9" ry="6" fill="${c_rd}" stroke="${c_rk}" stroke-width="0.7"/>`;
  svg += `<ellipse cx="31" cy="-2.5" rx="5" ry="3" fill="${c_rl}" opacity="0.15"/>`;
  svg += `<path d="M37,-5 C40,-9 43,-8 42,-5 C41,-3 39,-1 37,-1" fill="${c_rd}" stroke="${c_rk}" stroke-width="0.5"/>`;
  svg += `<path d="M37,3 C40,7 43,6 42,3 C41,1 39,-1 37,-1" fill="${c_rd}" stroke="${c_rk}" stroke-width="0.5"/>`;
  svg += `</g>`;
  // body
  svg += `<ellipse cx="0" cy="4" rx="${15+br}" ry="${19+br*0.5}" fill="${c_rd}"/>`;
  svg += `<ellipse cx="3" cy="0" rx="8" ry="11" fill="${c_rl}" opacity="0.12"/>`;
  svg += `<ellipse cx="1" cy="9" rx="6" ry="8" fill="${c_bl}" opacity="0.08"/>`;
  svg += `<path d="M${-13-br*0.5},-3 C-6,-6 6,-6 ${13+br*0.5},-3" fill="none" stroke="${c_rk}" stroke-width="0.35" opacity="0.18"/>`;
  svg += `<path d="M${-14-br*0.5},4 C-6,1 6,1 ${14+br*0.5},4" fill="none" stroke="${c_rk}" stroke-width="0.35" opacity="0.18"/>`;
  svg += `<path d="M${-13-br*0.5},11 C-6,8 6,8 ${13+br*0.5},11" fill="none" stroke="${c_rk}" stroke-width="0.35" opacity="0.18"/>`;
  svg += `<ellipse cx="0" cy="4" rx="${15+br}" ry="${19+br*0.5}" fill="none" stroke="${c_rk}" stroke-width="0.5" opacity="0.22"/>`;
  // face
  svg += `<g transform="rotate(${ht},0,-5)">`;
  // --- LEFT EYE (mostly under hair) ---
  svg += `<circle cx="-5" cy="-7" r="${4.5*eyeScale}" fill="#0d0815"/>`;
  svg += `<circle cx="-5" cy="-7" r="${3.5*eyeScale}" fill="#15102a"/>`;
  svg += `<ellipse cx="${-4.5+elx}" cy="${-7.8+ely}" rx="1.8" ry="${Math.max(0.2,1.8*eo)}" fill="#c4b5fd"/>`;
  if(eo>0.3){const ho=Math.min(1,(eo-0.3)/0.4);svg+=`<circle cx="${-4+elx*0.7}" cy="${-8.5+ely*0.7}" r="0.6" fill="#fff" opacity="${ho}"/>`;}
  if(eo<0.99){const bl=1-eo;svg+=`<ellipse cx="-5" cy="${-16.5+bl*9.5}" rx="${5.2*eyeScale}" ry="5" fill="${c_rd}"/>`;}
  // --- RIGHT EYE (main visible) ---
  svg += `<circle cx="7" cy="-7" r="${5.2*eyeScale}" fill="#0d0815"/>`;
  svg += `<circle cx="7" cy="-7" r="${4.2*eyeScale}" fill="#15102a"/>`;
  svg += `<ellipse cx="${7.5+elx}" cy="${-8+ely}" rx="2.3" ry="${Math.max(0.3,2.8*eo)}" fill="#c4b5fd"/>`;
  if(eo>0.3){const ho=Math.min(1,(eo-0.3)/0.4);svg+=`<circle cx="${8+elx*0.7}" cy="${-8.8+ely*0.7}" r="0.9" fill="#fff" opacity="${ho}"/>`;}
  if(eo<0.99){const bl=1-eo;svg+=`<ellipse cx="7" cy="${-17.5+bl*10.5}" rx="${6.2*eyeScale}" ry="5.5" fill="${c_rd}"/>`;}

  svg += `<path d="M3,${-13+Math.sin(t/60)*0.3} C6,-14.5 10,-14 ${12.5+Math.sin(t/60)*0.2},${-12.5+Math.sin(t/60)*0.5}" stroke="${c_rp}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`;
  svg += `<path d="M2,${2+br*0.2+mouthCurve} C4.5,${0.5+br*0.1+mouthCurve*0.5} 7.5,${0.5+br*0.1+mouthCurve*0.5} 10,${2+br*0.2+mouthCurve}" stroke="${c_rp}" stroke-width="1" fill="none" stroke-linecap="round"/>`;
  svg += `<ellipse cx="10.5" cy="${-2+td*8}" rx="${0.6+tp*0.4}" ry="${0.8+tp*0.8+td*0.3}" fill="#7caae8" opacity="${tf*0.4}"/>`;
  svg += `</g>`;
  // hair
  if(showHair) {
    svg += `<path d="M-14,-10 C-14,-17 -10,-25 -4,-29 C0,-32 6,-31 10,-27 C13,-24 15.5,-18 15.5,-12 C15.5,-8 15,${-5+hs*0.2} 14.5,${-3+hs*0.3} C13,-5 11,-8 8,-10 C4,-10 -10,-10 -14,-10 Z" fill="${hr}"/>`;
    svg += `<path d="M14.5,${-3+hs*0.3} C15.5,-5 15.5,-9 14.5,-12 C13,-16 10,-21 6,-26 C2,-29 -3,-30 -7,-28 C-12,-26 -16,-22 -18,-16 C-20,-10 -20.5,-3 -20.5,${3+hs*0.4} C-20.5,${8+hs*0.8} -19.5,${12+hs} -17,${15+hs*1.1} C-15,${12+hs*0.7} -12,${6+hs*0.4} -8,${hs*0.2} C-5,-4 -3,-8 -1,-11 C1,-14 4,-15.5 7,-15.5 C9,-15 12,-14 13.5,-12 C14.5,-9 14.5,${-6+hs*0.2} 14.5,${-3+hs*0.3} Z" fill="${hr}"/>`;
  }
  svg += `</g>`;
  return svg;
}

function darken(hex, factor=0.4) {
  const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
  return '#'+[r,g,b].map(v=>Math.round(v*factor).toString(16).padStart(2,'0')).join('');
}

function lighten(hex, factor=0.3) {
  const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
  return '#'+[r,g,b].map(v=>Math.round(v+(255-v)*factor).toString(16).padStart(2,'0')).join('');
}

/** Standard page setup: dark bg, centered SVG */
function setupPage(title) {
  document.title = `EMOLT — ${title}`;
}

/** Mulberry32 seeded PRNG — deterministic random for loopable animations */
function mulberry32(a) {
  return function() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** Deterministic particle age for looping animations.
 *  Returns age in ticks (0..lifetime-1) or -1 if particle is dead. */
function particleAge(lt, spawnT, lifetime, LOOP) {
  const age = ((lt - spawnT) % LOOP + LOOP) % LOOP;
  return age < lifetime ? age : -1;
}

/** Smoothstep easing 0→1 */
function smoothstep(x) {
  x = Math.max(0, Math.min(1, x));
  return x * x * (3 - 2 * x);
}

/** Ease-out cubic */
function easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }

/** Clamp value between min and max */
function clamp(v, mn, mx) { return Math.max(mn, Math.min(mx, v)); }

/** Start animation loop at ~60fps calling fn(tick) each frame */
function startLoop(fn) {
  let tick = 0;
  function loop() {
    tick++;
    fn(tick);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  return { getTick: () => tick };
}
