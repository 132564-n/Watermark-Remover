import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
function loadPackage(name) {
  try { return require(name); }
  catch (error) {
    const fallback = process.env.CODEX_TEST_NODE_MODULES;
    if (fallback) return require(`${fallback}/${name}`);
    throw error;
  }
}

const { chromium } = loadPackage('playwright');
const sharp = loadPackage('sharp');
const width = 384, height = 680;

const rays = Array.from({ length: 42 }, (_, i) => {
  const x = 8 + i * 9;
  return `<path d="M${x} 80 L${width - x / 2} 610"/>`;
}).join('');
const tiles = Array.from({ length: 22 }, (_, i) => {
  const x = 12 + (i % 11) * 34, y = 170 + Math.floor(i / 11) * 285;
  return `<rect x="${x}" y="${y}" width="20" height="95"/>`;
}).join('');
const cleanSvg = Buffer.from(`
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x2="1" y2="1"><stop stop-color="#02050b"/><stop offset=".55" stop-color="#14202b"/><stop offset="1" stop-color="#030306"/></linearGradient>
    <pattern id="grid" width="17" height="17" patternUnits="userSpaceOnUse"><path d="M17 0H0V17" fill="none" stroke="#69727d" stroke-width="1" opacity=".55"/></pattern>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <rect y="92" width="${width}" height="520" fill="url(#grid)"/>
  <g stroke="#d89a32" stroke-width="2" opacity=".72">${rays}</g>
  <g fill="#131b25" stroke="#e8b34b" stroke-width="2">${tiles}</g>
  <circle cx="192" cy="322" r="104" fill="#18130b" stroke="#f4c357" stroke-width="7"/>
  <circle cx="192" cy="322" r="64" fill="none" stroke="#d78d21" stroke-width="13"/>
  <path d="M0 493 Q192 428 384 493" fill="none" stroke="#d4262d" stroke-width="28"/>
  <path d="M0 493 Q192 437 384 493" fill="none" stroke="#ff8f3e" stroke-width="3"/>
  <g fill="#f7d46c">${Array.from({length: 36}, (_, i) => `<circle cx="${42 + (i * 47) % 304}" cy="${205 + (i * 71) % 236}" r="${2 + i % 4}"/>`).join('')}</g>
</svg>`);

const marks = [
  { x: 35, y: 135, text: 'SAVE CLEAN' },
  { x: 225, y: 244, text: 'NO MARK' },
  { x: 12, y: 406, text: 'SAVE CLEAN' },
  { x: 225, y: 546, text: 'NO MARK' },
  { x: 104, y: 82, text: 'CLEAN' }
];
const watermarkSvg = Buffer.from(`
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <g font-family="Arial" font-size="17" font-weight="700" fill="white" fill-opacity=".82" stroke="#dfe4eb" stroke-width="2">
    ${marks.map(mark => `<text x="${mark.x}" y="${mark.y}" transform="rotate(-24 ${mark.x} ${mark.y})">${mark.text}</text>`).join('')}
  </g>
</svg>`);

const cleanPng = await sharp(cleanSvg).png().toBuffer();
const inputPng = await sharp(cleanPng).composite([{ input: watermarkSvg }]).png().toBuffer();
const clean = await sharp(cleanPng).ensureAlpha().raw().toBuffer();

const strokes = [
  [20, 144, 152, 88],
  [214, 270, 382, 196],
  [0, 430, 142, 371],
  [235, 576, 383, 514],
  [96, 98, 208, 52]
];
const brushRadius = 29;
function segmentDistance(x, y, [x1, y1, x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}
const insideMask = (x, y) => strokes.some(stroke => segmentDistance(x, y, stroke) <= brushRadius - 4);

function metrics(actual) {
  let cleanEdge = 0, outputEdge = 0, squareError = 0, channels = 0, pixels = 0;
  const gray = (buffer, x, y) => { const i = (y * width + x) * 4; return buffer[i] * .299 + buffer[i + 1] * .587 + buffer[i + 2] * .114; };
  for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) {
    if (!insideMask(x, y)) continue;
    cleanEdge += Math.abs(gray(clean, x + 1, y) - gray(clean, x - 1, y)) + Math.abs(gray(clean, x, y + 1) - gray(clean, x, y - 1));
    outputEdge += Math.abs(gray(actual, x + 1, y) - gray(actual, x - 1, y)) + Math.abs(gray(actual, x, y + 1) - gray(actual, x, y - 1));
    const i = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) { const d = actual[i + c] - clean[i + c]; squareError += d * d; channels++; }
    pixels++;
  }
  return { retention: outputEdge / cleanEdge, rmse: Math.sqrt(squareError / channels), pixels };
}

const installedChrome = [process.env.WATERMARK_TEST_CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path => path && existsSync(path));
const browser = await chromium.launch({ headless: true, ...(installedChrome ? { executablePath: installedChrome } : {}), args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const browserErrors = [];
page.on('console', msg => { if (msg.type() === 'error') browserErrors.push(msg.text()); });
page.on('pageerror', error => browserErrors.push(error.message));

try {
  await page.goto(process.env.WATERMARK_TEST_URL || new URL('../index.html', import.meta.url).href);
  await page.locator('#fileInput').setInputFiles({ name: 'multi-region-poster.png', mimeType: 'image/png', buffer: inputPng });
  await page.locator('#editorPanel').waitFor({ state: 'visible' });
  await page.locator('#aiModeButton').click();
  await page.locator('#brushSize').evaluate(el => { el.value = '58'; el.dispatchEvent(new Event('input')); });
  const box = await page.locator('#maskCanvas').boundingBox();
  assert(box, 'mask canvas is not visible');
  const sx = box.width / width, sy = box.height / height;
  for (const [x1, y1, x2, y2] of strokes) {
    await page.mouse.move(box.x + x1 * sx, box.y + y1 * sy);
    await page.mouse.down();
    await page.mouse.move(box.x + x2 * sx, box.y + y2 * sy, { steps: 24 });
    await page.mouse.up();
  }
  await page.locator('#restoreButton').click();
  await page.waitForFunction(() => !document.querySelector('#downloadButton').disabled, null, { timeout: 180000 });
  const output = Buffer.from(await page.locator('#imageCanvas').evaluate(canvas => Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data)));
  const result = metrics(output);
  console.log(`METRICS multi-region edge=${(result.retention * 100).toFixed(1)}% rmse=${result.rmse.toFixed(1)} pixels=${result.pixels}`);
  assert.equal(browserErrors.length, 0, `browser errors: ${browserErrors.join(' | ')}`);
  assert(result.retention > .92, `multi-region repair blurred fine detail: edge retention ${(result.retention * 100).toFixed(1)}%`);
  assert(result.rmse < 58, `multi-region repair differs too much from clean image: RMSE ${result.rmse.toFixed(1)}`);
  console.log(`PASS multi-region edge-retention=${(result.retention * 100).toFixed(1)}% rmse=${result.rmse.toFixed(1)}`);
} catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
