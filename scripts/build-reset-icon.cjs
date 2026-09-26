// Generates a visually-distinct icon for the standalone "BillNest Reset"
// shortcut/tool (electron/factoryReset.cjs) — the same navy BillNest badge
// as the main app icon, with a small red "reset" corner badge (circular
// arrow) composited on top, so the two desktop icons are unmistakably
// different at a glance despite launching the same .exe.
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { default: pngToIco } = require('png-to-ico');

const buildDir = path.join(__dirname, '..', 'build');
const baseIconPath = path.join(buildDir, 'icon-512.png');

const BADGE_SIZE = 220; // corner badge diameter, relative to the 512px master
const RED = '#dc2626';
const RED_DARK = '#991b1b';

function cornerBadgeSvg(size) {
  const r = size / 2;
  // Simple circular counter-clockwise "reset/refresh" arrow glyph, drawn as
  // an open ring with one end turned into an arrowhead.
  return Buffer.from(`
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="rg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${RED}"/>
          <stop offset="100%" stop-color="${RED_DARK}"/>
        </linearGradient>
      </defs>
      <circle cx="${r}" cy="${r}" r="${r - 4}" fill="url(#rg)" stroke="white" stroke-width="8"/>
      <path d="M ${r} ${r * 0.42}
               A ${r * 0.58} ${r * 0.58} 0 1 1 ${r * 0.5} ${r * 1.02}"
            fill="none" stroke="white" stroke-width="${size * 0.09}" stroke-linecap="round"/>
      <path d="M ${r} ${r * 0.42} L ${r * 0.72} ${r * 0.2} L ${r * 1.2} ${r * 0.34} Z" fill="white"/>
    </svg>`);
}

async function main() {
  if (!fs.existsSync(baseIconPath)) {
    console.error('build/icon-512.png not found — run build-icon-final.cjs first.');
    process.exit(1);
  }
  const badgeBuf = await sharp(cornerBadgeSvg(BADGE_SIZE)).png().toBuffer();
  const masterBuf = await sharp(baseIconPath)
    .composite([{ input: badgeBuf, left: 512 - BADGE_SIZE - 10, top: 512 - BADGE_SIZE - 10 }])
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(buildDir, 'icon-reset-master.png'), masterBuf);

  const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const s of sizes) {
    const outPath = path.join(buildDir, `icon-reset-${s}.png`);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await sharp(masterBuf).resize(s, s).png().toFile(outPath);
        break;
      } catch (e) {
        if (attempt === 4) throw e;
        await sleep(300);
      }
    }
  }

  const icoBuf = await pngToIco([
    path.join(buildDir, 'icon-reset-16.png'),
    path.join(buildDir, 'icon-reset-24.png'),
    path.join(buildDir, 'icon-reset-32.png'),
    path.join(buildDir, 'icon-reset-48.png'),
    path.join(buildDir, 'icon-reset-64.png'),
    path.join(buildDir, 'icon-reset-128.png'),
    path.join(buildDir, 'icon-reset-256.png'),
  ]);
  fs.writeFileSync(path.join(buildDir, 'icon-reset.ico'), icoBuf);

  // Clean up intermediate per-size PNGs — only icon-reset.ico + the master
  // PNG (kept for reference/future re-touching) need to stick around.
  for (const s of sizes) {
    try { fs.unlinkSync(path.join(buildDir, `icon-reset-${s}.png`)); } catch { /* ignore */ }
  }

  console.log('icon-reset.ico generated.');
}

main().catch((e) => { console.error(e); process.exit(1); });
