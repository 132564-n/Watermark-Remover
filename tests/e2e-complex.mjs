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

const width = 512, height = 512;
const lines = Array.from({ length: 15 }, (_, i) => `<path d="M${40 + i * 29} 175 L${90 + i * 29} 330"/>`).join('');
const blocks = Array.from({ length: 10 }, (_, i) => `<rect x="${55 + i * 42}" y="${205 + (i % 2) * 42}" width="26" height="70"/>`).join('');
const cleanSvg = Buffer.from(`
<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#07111f"/><stop offset=".55" stop-color="#152a38"/><stop offset="1" stop-color="#03060d"/></linearGradient></defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <g stroke="#d79b35" stroke-width="5" opacity=".95">${lines}</g>
  <g fill="#b72228" stroke="#ffdb73" stroke-width="3">${blocks}</g>
  <circle cx="256" cy="256" r="102" fill="none" stroke="#f5b93f" stroke-width="12"/>
  <circle cx="256" cy="256" r="54" fill="#251309" stroke="#f8d36a" stroke-width="8"/>
  <path d="M30 345 Q256 245 482 345" fill="none" stroke="#df3038" stroke-width="28"/>
  <path d="M35 345 Q256 260 477 345" fill="none" stroke="#ff8b3e" stroke-width="4"/>
</svg>`);
const watermarkSvg = Buffer.from(`
<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
  <g transform="rotate(-9 256 256)">
    <text x="256" y="272" text-anchor="middle" font-family="Arial" font-size="52" font-weight="700"
      fill="white" fill-opacity=".88" stroke="#d9dde5" stroke-width="5">SAVE WITHOUT MARK</text>
  </g>
</svg>`);
const cleanPng = await sharp(cleanSvg).png().toBuffer();
const watermarkedPng = await sharp(cleanPng).composite([{ input: watermarkSvg }]).png().toBuffer();
const clean = await sharp(cleanPng).ensureAlpha().raw().toBuffer();

function edgeEnergy(buffer, box, include = () => true) {
  let energy = 0, count = 0;
  for (let y = box.y + 1; y < box.y + box.h - 1; y++) for (let x = box.x + 1; x < box.x + box.w - 1; x++) {
    if (!include(x, y)) continue;
    const gray = (px, py) => { const i = (py * width + px) * 4; return buffer[i] * .299 + buffer[i + 1] * .587 + buffer[i + 2] * .114; };
    energy += Math.abs(gray(x + 1, y) - gray(x - 1, y)) + Math.abs(gray(x, y + 1) - gray(x, y - 1)); count++;
  }
  return energy / count;
}

function regionMetrics(actual, expected, box, include) {
  let squareError=0,channels=0,whitePixels=0,pixels=0;
  for(let y=box.y;y<box.y+box.h;y++)for(let x=box.x;x<box.x+box.w;x++){
    if(!include(x,y))continue;const i=(y*width+x)*4;pixels++;
    if(actual[i]>185&&actual[i+1]>185&&actual[i+2]>185)whitePixels++;
    for(let c=0;c<3;c++){const d=actual[i+c]-expected[i+c];squareError+=d*d;channels++;}
  }
  return {rmse:Math.sqrt(squareError/channels),whiteRatio:whitePixels/pixels};
}

const installedChrome = [process.env.WATERMARK_TEST_CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path => path && existsSync(path));
const browser = await chromium.launch({ headless: true, ...(installedChrome ? { executablePath: installedChrome } : {}), args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const browserErrors = [];
page.on('console', msg => { if (msg.type() === 'error') browserErrors.push(msg.text()); });
page.on('pageerror', error => browserErrors.push(error.message));

try {
  await page.goto(process.env.WATERMARK_TEST_URL || new URL('../index.html', import.meta.url).href);
  await page.locator('#fileInput').setInputFiles({ name: 'complex-watermark.png', mimeType: 'image/png', buffer: watermarkedPng });
  await page.locator('#editorPanel').waitFor({ state: 'visible' });
  const mode = process.env.WATERMARK_COMPLEX_MODE === 'fast' ? 'fast' : 'ai';
  await page.locator(mode === 'ai' ? '#aiModeButton' : '#fastModeButton').click();
  await page.locator('#brushSize').evaluate(el => { el.value = '38'; el.dispatchEvent(new Event('input')); });
  const box = await page.locator('#maskCanvas').boundingBox();
  const sx = box.width / width, sy = box.height / height;
  for (const offset of [-38, -5]) {
    await page.mouse.move(box.x, box.y + (312 + offset) * sy);
    await page.mouse.down();
    await page.mouse.move(box.x + 512 * sx, box.y + (232 + offset) * sy, { steps: 40 });
    await page.mouse.up();
  }
  await page.locator('#restoreButton').click();
  await page.waitForFunction(() => !document.querySelector('#downloadButton').disabled, null, { timeout: 120000 });
  const output = Buffer.from(await page.locator('#imageCanvas').evaluate(canvas => Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data)));
  const roi = { x: 1, y: 185, w: 510, h: 155 };
  const insideMaskBand = (x, y) => Math.abs(y - (290.5 - x * (80 / 512))) < 43;
  const cleanEdges = edgeEnergy(clean, roi, insideMaskBand), outputEdges = edgeEnergy(output, roi, insideMaskBand);
  const retention = outputEdges / cleanEdges;
  const metrics=regionMetrics(output,clean,roi,insideMaskBand);
  console.log(`METRICS mode=${mode} edge=${(retention*100).toFixed(1)} rmse=${metrics.rmse.toFixed(1)} white=${(metrics.whiteRatio*100).toFixed(2)}%`);
  assert.equal(browserErrors.length, 0, `browser errors: ${browserErrors.join(' | ')}`);
  assert(metrics.whiteRatio < .005, `watermark-colored pixels remain: ${(metrics.whiteRatio*100).toFixed(2)}%`);
  assert(metrics.rmse < 58, `reconstruction differs too much from clean structure: RMSE ${metrics.rmse.toFixed(1)}`);
  assert(retention > .85, `complex structures collapsed: edge retention ${(retention * 100).toFixed(1)}%`);
  console.log(`PASS complex mode=${mode} edge-retention=${(retention * 100).toFixed(1)}% rmse=${metrics.rmse.toFixed(1)} white=${(metrics.whiteRatio*100).toFixed(2)}%`);
} catch (error) {
  console.error(`FAIL ${error.message}`); process.exitCode = 1;
} finally { await browser.close(); }
