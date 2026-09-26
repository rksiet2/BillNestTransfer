// Removes the fake checkerboard "transparency" pattern baked into the
// user-provided 1000569004.png (common artifact from some AI image
// generators — the pixels are literally gray/white checker squares, not
// real alpha). We flood-fill from the border only through grayish,
// low-saturation pixels (the checker), leaving the colorful/cream
// artwork untouched, then trim to the tight content bounding box.
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const buildDir = path.join(__dirname, '..', 'build');
const srcPath = path.join(buildDir, 'source-logo', 'logo-transparent.png');

function isCheckerPixel(r, g, b) {
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const sat = maxc - minc;
  // grayish (low color saturation) and mid-to-light brightness => checker square
  return sat <= 10 && maxc >= 150 && maxc <= 250;
}

async function main() {
  const { data, info } = await sharp(srcPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const isBg = new Uint8Array(width * height);

  function idx(x, y) { return y * width + x; }
  function getRGB(x, y) {
    const o = idx(x, y) * channels;
    return [data[o], data[o + 1], data[o + 2]];
  }

  const stack = [];
  for (let x = 0; x < width; x++) {
    for (const y of [0, height - 1]) {
      const [r, g, b] = getRGB(x, y);
      if (isCheckerPixel(r, g, b) && !isBg[idx(x, y)]) { isBg[idx(x, y)] = 1; stack.push([x, y]); }
    }
  }
  for (let y = 0; y < height; y++) {
    for (const x of [0, width - 1]) {
      const [r, g, b] = getRGB(x, y);
      if (isCheckerPixel(r, g, b) && !isBg[idx(x, y)]) { isBg[idx(x, y)] = 1; stack.push([x, y]); }
    }
  }
  while (stack.length) {
    const [x, y] = stack.pop();
    const neighbors = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = idx(nx, ny);
      if (isBg[ni]) continue;
      const [r, g, b] = getRGB(nx, ny);
      if (isCheckerPixel(r, g, b)) { isBg[ni] = 1; stack.push([nx, ny]); }
    }
  }

  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(x, y);
      if (isBg[i]) {
        data[i * channels + 3] = 0;
      } else {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const full = await sharp(data, { raw: { width, height, channels } }).png().toBuffer();
  fs.writeFileSync(path.join(buildDir, 'billnest-mark-raw.png'), full);

  const pad = 10;
  const cropLeft = Math.max(0, minX - pad);
  const cropTop = Math.max(0, minY - pad);
  const cropW = Math.min(width - cropLeft, maxX - minX + pad * 2);
  const cropH = Math.min(height - cropTop, maxY - minY + pad * 2);

  await sharp(full)
    .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
    .png()
    .toFile(path.join(buildDir, 'billnest-mark-trimmed.png'));

  console.log('bbox', { minX, minY, maxX, maxY, cropW, cropH });
}

main().catch((e) => { console.error(e); process.exit(1); });
