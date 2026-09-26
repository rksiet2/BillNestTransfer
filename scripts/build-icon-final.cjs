// Final BillNest icon pipeline — uses the user's own finished logo artwork
// (1000569004.png = clean mark w/ fake-checker "transparency" now matted to
// real alpha via remove-checker-bg.cjs) composited onto a rounded-square navy
// badge (color sampled from the user's 1000569005.png reference) to produce
// the installable app icon (.ico + all PNG sizes), plus an unframed mark PNG
// for use inside in-app UI cards (login/setup screens).
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { default: pngToIco } = require('png-to-ico');

const buildDir = path.join(__dirname, '..', 'build');
const markPath = path.join(buildDir, 'billnest-mark-trimmed.png');

const BADGE = 512;
const RADIUS = 108;
const NAVY_TOP = '#132a4d';
const NAVY_BOTTOM = '#0a1730';

function badgeSvg(size, radius) {
  return Buffer.from(`
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${NAVY_TOP}"/>
          <stop offset="100%" stop-color="${NAVY_BOTTOM}"/>
        </linearGradient>
      </defs>
      <rect width="${size}" height="${size}" rx="${radius}" fill="url(#g)"/>
    </svg>`);
}

async function main() {
  // 1) Unframed mark for in-app UI (no badge, transparent background).
  await sharp(markPath).resize(340, 340, { fit: 'inside' }).png()
    .toFile(path.join(buildDir, 'billnest-mark.png'));

  // 2) Master 512px badge with mark composited on top, sized to leave a
  //    comfortable margin around the artwork.
  const badgeBuf = badgeSvg(BADGE, RADIUS);
  const markResized = await sharp(markPath).resize(384, 384, { fit: 'inside' }).toBuffer();
  const markMeta = await sharp(markResized).metadata();
  const left = Math.round((BADGE - markMeta.width) / 2);
  const top = Math.round((BADGE - markMeta.height) / 2) + 8; // nudge down slightly for optical centering

  const masterBuf = await sharp(badgeBuf)
    .composite([{ input: markResized, left, top }])
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(buildDir, 'icon-master.png'), masterBuf);

  // 3) Generate every required icon size from the master.
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const s of sizes) {
    const outPath = path.join(buildDir, `icon-${s}.png`);
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
  fs.copyFileSync(path.join(buildDir, 'icon-512.png'), path.join(buildDir, 'icon.png'));

  // 4) .ico (multi-size) for Windows build + window title bar.
  const icoBuf = await pngToIco([
    path.join(buildDir, 'icon-16.png'),
    path.join(buildDir, 'icon-24.png'),
    path.join(buildDir, 'icon-32.png'),
    path.join(buildDir, 'icon-48.png'),
    path.join(buildDir, 'icon-64.png'),
    path.join(buildDir, 'icon-128.png'),
    path.join(buildDir, 'icon-256.png'),
  ]);
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), icoBuf);

  console.log('Icon set generated from user-provided logo.');
}

main().catch((e) => { console.error(e); process.exit(1); });
