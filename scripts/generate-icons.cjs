// Generates icon.png (512x512, for Linux/general use), a set of PNG sizes,
// and icon.ico (multi-resolution, for Windows/electron-builder) from the
// BillNest source SVG.
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { default: pngToIco } = require('png-to-ico');

const buildDir = path.join(__dirname, '..', 'build');
const svgPath = path.join(buildDir, 'icon-source.svg');
const sizes = [16, 24, 32, 48, 64, 128, 256, 512];

async function main() {
  const svgBuffer = fs.readFileSync(svgPath);
  const pngPaths = [];

  for (const size of sizes) {
    const outPath = path.join(buildDir, `icon-${size}.png`);
    await sharp(svgBuffer, { density: 384 }).resize(size, size).png().toFile(outPath);
    pngPaths.push(outPath);
    console.log('Generated', outPath);
  }

  // Main app icon (used by electron-builder's mac/linux targets + BrowserWindow icon)
  fs.copyFileSync(path.join(buildDir, 'icon-512.png'), path.join(buildDir, 'icon.png'));

  // Windows .ico needs only a handful of standard sizes bundled together
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoBuffer = await pngToIco(icoSizes.map((s) => path.join(buildDir, `icon-${s}.png`)));
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), icoBuffer);
  console.log('Generated', path.join(buildDir, 'icon.ico'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
