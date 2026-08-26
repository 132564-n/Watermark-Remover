import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const require=createRequire(import.meta.url);
function loadPackage(name){try{return require(name);}catch(error){const fallback=process.env.CODEX_TEST_NODE_MODULES;if(fallback)return require(`${fallback}/${name}`);throw error;}}
const {chromium}=loadPackage('playwright'),sharp=loadPackage('sharp');
const width=600,height=400;
const centers=[[150,100],[450,100],[150,300],[450,300]];
const background=Buffer.from(`
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="600" height="400" fill="#0b1220"/>
  <rect x="300" width="300" height="200" fill="#5a251d"/>
  <rect y="200" width="300" height="200" fill="#173f35"/>
  <rect x="300" y="200" width="300" height="200" fill="#503e13"/>
  <g stroke="#e3a63a" stroke-width="4" opacity=".8">
    ${Array.from({length:18},(_,i)=>`<path d="M${i*35} 0 L${600-i*20} 400"/>`).join('')}
  </g>
  <g fill="none" stroke="#72b7d1" stroke-width="3" opacity=".7">
    <circle cx="150" cy="100" r="72"/><circle cx="450" cy="100" r="72"/><circle cx="150" cy="300" r="72"/><circle cx="450" cy="300" r="72"/>
  </g>
</svg>`);
const marks=Buffer.from(`
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <g font-family="Arial" font-size="27" font-weight="700" fill="white" fill-opacity=".86" stroke="#e6eaf0" stroke-width="2">
    ${centers.map(([x,y])=>`<text x="${x}" y="${y+8}" text-anchor="middle" transform="rotate(-18 ${x} ${y})">DEMO MARK</text>`).join('')}
  </g>
</svg>`);
const inputPng=await sharp(background).png().composite([{input:marks}]).png().toBuffer();
const installedChrome=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path=>existsSync(path));
const browser=await chromium.launch({headless:true,...(installedChrome?{executablePath:installedChrome}:{}),args:['--no-sandbox','--disable-gpu']});
const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});page.on('pageerror',error=>errors.push(error.message));
try{
  await page.goto(process.env.WATERMARK_TEST_URL||new URL('../index.html',import.meta.url).href);
  await page.locator('#fileInput').setInputFiles({name:'repeated-watermarks.png',mimeType:'image/png',buffer:inputPng});
  await page.locator('#editorPanel').waitFor({state:'visible'});
  await page.locator('#detectTool').click();
  const canvasBox=await page.locator('#maskCanvas').boundingBox(),sx=canvasBox.width/width,sy=canvasBox.height/height;
  await page.mouse.click(canvasBox.x+centers[0][0]*sx,canvasBox.y+centers[0][1]*sy);
  await page.waitForFunction(()=>document.querySelectorAll('.watermark-detection').length>=4,null,{timeout:10000});
  const detections=page.locator('.watermark-detection');
  const count=await detections.count();
  assert.equal(count,4,`expected four similar watermarks, got ${count}`);
  for(let i=0;i<count;i++)assert.equal(await detections.nth(i).getAttribute('aria-pressed'),'true','detected watermark was not selected');
  const before=await page.locator('#maskCanvas').evaluate(canvas=>{const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let pixels=0;for(let i=3;i<data.length;i+=4)if(data[i]>20)pixels++;return pixels;});
  const displayedBoxArea=await detections.evaluateAll(nodes=>nodes.reduce((sum,node)=>{const rect=node.getBoundingClientRect();return sum+rect.width*rect.height;},0));
  const boxArea=displayedBoxArea/(sx*sy);
  assert(before>400,`recognition produced too little mask: ${before} pixels`);
  assert(before<boxArea*.55,`recognition used broad boxes instead of precise glyph masks: ${before}/${Math.round(boxArea)}`);
  await detections.nth(1).click();
  assert.equal(await detections.nth(1).getAttribute('aria-pressed'),'false','clicking a detection did not cancel it');
  const afterCancel=await page.locator('#maskCanvas').evaluate(canvas=>{const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let pixels=0;for(let i=3;i<data.length;i+=4)if(data[i]>20)pixels++;return pixels;});
  assert(afterCancel<before*.9,`cancelling a detection did not remove its mask: ${afterCancel}/${before}`);
  await detections.nth(1).click();
  assert.equal(await detections.nth(1).getAttribute('aria-pressed'),'true','second click did not restore the detection');
  const afterRestore=await page.locator('#maskCanvas').evaluate(canvas=>{const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let pixels=0;for(let i=3;i<data.length;i+=4)if(data[i]>20)pixels++;return pixels;});
  assert(afterRestore>=before*.98,'restoring a detection did not restore its mask');
  assert.equal(await page.locator('#restoreButton').isEnabled(),true,'recognized watermarks did not enable repair');
  await page.locator('#fastModeButton').click();await page.locator('#restoreButton').click();
  await page.waitForFunction(()=>!document.querySelector('#downloadButton').disabled);
  assert.equal(await page.locator('#detectionLayer').isHidden(),true,'detection boxes stayed visible over the repaired image');
  assert.equal(await page.locator('#downloadButton').isEnabled(),true,'recognized mask did not enter the repair/export flow');
  assert.equal(errors.length,0,`browser errors: ${errors.join(' | ')}`);
  console.log(`PASS detection count=${count} precise-mask=${before}/${Math.round(boxArea)} toggle=${afterCancel}->${afterRestore}`);
}catch(error){console.error(`FAIL ${error.message}`);process.exitCode=1;}finally{await browser.close();}
