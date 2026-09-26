// Generates the Android launcher icon set (legacy square mipmap PNGs +
// adaptive-icon foreground layers) from the BillNest brand source images,
// replacing the default Capacitor/Android-Studio placeholder icons (white
// background, generic vector mark) that `cap add android` scaffolds in.
//
// Sources used (already produced by scripts/build-icon-final.cjs, the
// desktop icon pipeline — this script re-targets the same finished artwork
// at Android instead of generating its own):
//   build/icon-512.png           - full square badge (navy rounded-square
//                                   background + logo baked in) used as-is
//                                   for the legacy ic_launcher(.round).png.
//   build/billnest-mark.png      - transparent-background logo mark, used
//                                   for the adaptive-icon foreground layer
//                                   (scaled/centered on a transparent
//                                   canvas — the OS supplies the background
//                                   color from ic_launcher_background.xml).
//
// Run manually after the brand icon changes: `node scripts/generate-android-icons.cjs`
// then `npx cap sync android` to make sure the Android build inputs pick up
// the new files (cap sync copies web assets, not native res/ files, but
// running it afterwards keeps the usual "always sync after Android-adjacent
// changes" habit — see AGENTS.md Rule 1).
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SOURCE_BADGE = path.join(ROOT, 'build', 'icon-512.png');
const SOURCE_MARK = path.join(ROOT, 'build', 'billnest-mark.png');
const RES_DIR = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');

// density -> { launcher (legacy square icon size), foreground (adaptive-icon
// canvas size — larger than `launcher` to leave safe-zone padding, since
// circle/squircle/rounded-square OS masks can clip the outer ring) }
const DENSITIES = {
  'mipmap-mdpi': { launcher: 48, foreground: 108 },
  'mipmap-hdpi': { launcher: 72, foreground: 162 },
  'mipmap-xhdpi': { launcher: 96, foreground: 216 },
  'mipmap-xxhdpi': { launcher: 144, foreground: 324 },
  'mipmap-xxxhdpi': { launcher: 192, foreground: 432 },
};

// Adaptive-icon foreground safe zone is the inner ~66% of the canvas.
const FOREGROUND_MARK_RATIO = 0.62;

async function makeCircularMask(size) {
  const svg = Buffer.from(
    `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`
  );
  return sharp(svg).png().toBuffer();
}

async function generateLegacyIcon(size, outFile, round) {
  const resized = await sharp(SOURCE_BADGE).resize(size, size).toBuffer();
  if (!round) {
    await sharp(resized).png().toFile(outFile);
    return;
  }
  const mask = await makeCircularMask(size);
  await sharp(resized).composite([{ input: mask, blend: 'dest-in' }]).png().toFile(outFile);
}

async function generateForeground(canvasSize, outFile) {
  const markSize = Math.round(canvasSize * FOREGROUND_MARK_RATIO);
  const mark = await sharp(SOURCE_MARK).resize(markSize, markSize, { fit: 'inside' }).toBuffer();
  const offset = Math.round((canvasSize - markSize) / 2);
  await sharp({
    create: { width: canvasSize, height: canvasSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: mark, top: offset, left: offset }])
    .png()
    .toFile(outFile);
}

async function main() {
  for (const [dir, sizes] of Object.entries(DENSITIES)) {
    const densityDir = path.join(RES_DIR, dir);
    await generateLegacyIcon(sizes.launcher, path.join(densityDir, 'ic_launcher.png'), false);
    await generateLegacyIcon(sizes.launcher, path.join(densityDir, 'ic_launcher_round.png'), true);
    await generateForeground(sizes.foreground, path.join(densityDir, 'ic_launcher_foreground.png'));
    console.log(`Generated icons for ${dir} (${sizes.launcher}px / ${sizes.foreground}px)`);
  }
  console.log('Done. Remember to `npx cap sync android` after this (AGENTS.md Rule 1).');
}

main().catch((err) => {
  console.error('Android icon generation failed:', err);
  process.exit(1);
});
