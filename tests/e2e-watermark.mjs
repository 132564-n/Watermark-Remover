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

const width = 480;
const height = 280;

function cleanPixel(x, y) {
  const grain = ((x * 17 + y * 29) % 11) - 5;
  return [48 + Math.round(x * 0.18) + grain, 102 + Math.round(y * 0.16) + grain, 151 + Math.round(x * 0.08) + grain];
}

const clean = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const [r, g, b] = cleanPixel(x, y);
    clean[i] = r; clean[i + 1] = g; clean[i + 2] = b; clean[i + 3] = 255;
  }
}

const watermarkSvg = Buffer.from(`
  <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <text x="240" y="148" text-anchor="middle" font-family="Arial" font-size="42" font-weight="700"
      fill="white" fill-opacity="0.86" stroke="#13233a" stroke-opacity="0.28" stroke-width="2">DEMO 2026</text>
  </svg>`);
const inputPng = await sharp(clean, { raw: { width, height, channels: 4 } }).composite([{ input: watermarkSvg }]).png().toBuffer();
const cornerSvg = Buffer.from(`
  <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <text x="468" y="256" text-anchor="end" font-family="Arial" font-size="30" font-weight="700"
      fill="white" fill-opacity="0.9" stroke="#13233a" stroke-opacity="0.3" stroke-width="2">© DEMO</text>
  </svg>`);
const cornerPng = await sharp(clean, { raw: { width, height, channels: 4 } }).composite([{ input: cornerSvg }]).png().toBuffer();

function rmse(actual, expected, box) {
  let total = 0, count = 0;
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
    const i = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) { const d = actual[i + c] - expected[i + c]; total += d * d; count++; }
  }
  return Math.sqrt(total / count);
}

const inputRaw = await sharp(inputPng).ensureAlpha().raw().toBuffer();
const roi = { x: 105, y: 108, w: 270, h: 55 };
const beforeError = rmse(inputRaw, clean, roi);
const cornerRaw = await sharp(cornerPng).ensureAlpha().raw().toBuffer();
const cornerRoi = { x: 330, y: 218, w: 145, h: 48 };
const cornerBeforeError = rmse(cornerRaw, clean, cornerRoi);

const installedChrome = [
  process.env.WATERMARK_TEST_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find(path => path && existsSync(path));
const browser = await chromium.launch({ headless: true, ...(installedChrome ? { executablePath: installedChrome } : {}), args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const consoleErrors = [];
page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', err => consoleErrors.push(err.message));

try {
  const targetUrl = process.env.WATERMARK_TEST_URL || new URL('../index.html', import.meta.url).href;
  await page.goto(targetUrl);
  await page.locator('#fileInput').setInputFiles({ name: 'watermarked.png', mimeType: 'image/png', buffer: inputPng });
  await page.locator('#editorPanel').waitFor({ state: 'visible' });
  if (process.env.WATERMARK_UI_SCREENSHOT) await page.screenshot({ path: process.env.WATERMARK_UI_SCREENSHOT, fullPage: true });
  await page.locator('#fastModeButton').click();
  await page.locator('#brushSize').evaluate(el => { el.value = '32'; el.dispatchEvent(new Event('input')); });

  const box = await page.locator('#maskCanvas').boundingBox();
  assert(box, 'mask canvas is not visible');
  const sx = box.width / width, sy = box.height / height;
  for (const y of [116, 136, 156]) {
    await page.mouse.move(box.x + 96 * sx, box.y + y * sy);
    await page.mouse.down();
    await page.mouse.move(box.x + 384 * sx, box.y + y * sy, { steps: 24 });
    await page.mouse.up();
  }

  const probe = await page.locator('#maskCanvas').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let alphaPixels = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 20) alphaPixels++;
    return { alphaPixels, disabled: document.querySelector('#restoreButton').disabled, rect: canvas.getBoundingClientRect().toJSON() };
  });
  const target = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id || document.elementFromPoint(x, y)?.className, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  console.log(`PROBE box=${JSON.stringify(box)} target=${target} alphaPixels=${probe.alphaPixels} disabled=${probe.disabled}`);
  assert(probe.alphaPixels > 0, 'drawing produced no mask pixels');
  assert.equal(probe.disabled, false, 'restore button stayed disabled after drawing');

  await page.locator('#clearMaskButton').click();
  assert.equal(await page.locator('#restoreButton').isDisabled(), true, 'clear selection did not disable restore');
  await page.locator('#undoButton').click();
  assert.equal(await page.locator('#restoreButton').isEnabled(), true, 'undo did not restore the cleared selection');

  await page.locator('#restoreButton').click();
  await page.waitForFunction(() => !document.querySelector('#downloadButton').disabled);
  const output = Buffer.from(await page.locator('#imageCanvas').evaluate(canvas => Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data)));
  const afterError = rmse(output, clean, roi);
  const improvement = 1 - afterError / beforeError;
  assert.equal(consoleErrors.length, 0, `browser errors: ${consoleErrors.join(' | ')}`);
  assert(afterError < 18, `watermark remains too visible: RMSE ${afterError.toFixed(2)}`);
  assert(improvement > 0.7, `repair improved only ${(improvement * 100).toFixed(1)}%`);
  assert(await page.locator('#downloadButton').isEnabled(), 'download is not enabled after repair');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#downloadButton').click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /-已修复\.png$/, 'download filename is incorrect');
  const downloadPath = await download.path();
  const metadata = await sharp(downloadPath).metadata();
  assert.equal(metadata.width, width, 'download width changed');
  assert.equal(metadata.height, height, 'download height changed');

  // Starting another selection must keep the previous repair instead of reverting to the first upload.
  await page.mouse.move(box.x + 38 * sx, box.y + 38 * sy);
  await page.mouse.down(); await page.mouse.up();
  const committedBase = Buffer.from(await page.locator('#imageCanvas').evaluate(canvas => Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data)));
  assert.equal(Buffer.compare(committedBase, output), 0, 'starting a second repair discarded the previous result');

  // Regression: a watermark touching the bottom-right area has clean pixels on fewer sides.
  await page.locator('#fileInput').setInputFiles({ name: 'corner-watermark.png', mimeType: 'image/png', buffer: cornerPng });
  await page.waitForFunction(() => document.querySelector('#fileName').textContent === 'corner-watermark.png');
  await page.locator('#brushSize').evaluate(el => { el.value = '30'; el.dispatchEvent(new Event('input')); });
  const cornerBox = await page.locator('#maskCanvas').boundingBox();
  const csx = cornerBox.width / width, csy = cornerBox.height / height;
  for (const y of [225, 244, 263]) {
    await page.mouse.move(cornerBox.x + 315 * csx, cornerBox.y + y * csy);
    await page.mouse.down();
    await page.mouse.move(cornerBox.x + 478 * csx, cornerBox.y + y * csy, { steps: 18 });
    await page.mouse.up();
  }
  assert.equal(await page.locator('#restoreButton').isEnabled(), true, 'corner mask was not detected');
  await page.locator('#restoreButton').click();
  await page.waitForFunction(() => !document.querySelector('#downloadButton').disabled);
  const cornerOutput = Buffer.from(await page.locator('#imageCanvas').evaluate(canvas => Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data)));
  const cornerAfterError = rmse(cornerOutput, clean, cornerRoi);
  const cornerImprovement = 1 - cornerAfterError / cornerBeforeError;
  assert(cornerAfterError < 18, `corner watermark remains visible: RMSE ${cornerAfterError.toFixed(2)}`);
  assert(cornerImprovement > 0.65, `corner repair improved only ${(cornerImprovement * 100).toFixed(1)}%`);
  assert.equal(consoleErrors.length, 0, `browser errors: ${consoleErrors.join(' | ')}`);
  console.log(`PASS center=${(improvement * 100).toFixed(1)}% corner=${(cornerImprovement * 100).toFixed(1)}% export=${metadata.width}x${metadata.height}`);
} catch (error) {
  console.error(`FAIL before=${beforeError.toFixed(2)}: ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
