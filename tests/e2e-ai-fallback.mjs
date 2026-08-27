import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';

const require=createRequire(import.meta.url);
function loadPackage(name){try{return require(name);}catch(error){const fallback=process.env.CODEX_TEST_NODE_MODULES;if(fallback)return require(`${fallback}/${name}`);throw error;}}
const {chromium}=loadPackage('playwright'),sharp=loadPackage('sharp');
const width=320,height=200;
const input=await sharp(Buffer.from(`<svg width="320" height="200" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop stop-color="#17365d"/><stop offset="1" stop-color="#c85a38"/></linearGradient></defs><rect width="320" height="200" fill="url(#g)"/><text x="160" y="110" text-anchor="middle" font-family="Arial" font-size="32" font-weight="700" fill="white">WATERMARK</text></svg>`)).png().toBuffer();
const installedChrome=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser=await chromium.launch({headless:true,...(installedChrome?{executablePath:installedChrome}:{}),args:['--no-sandbox','--disable-gpu']});
const page=await browser.newPage({viewport:{width:1100,height:760}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));page.on('crash',()=>errors.push('renderer crashed'));
await page.route(/\.onnx(?:\?|$)/,route=>route.abort('failed'));
try{
  await page.goto(process.env.WATERMARK_TEST_URL||new URL('../index.html',import.meta.url).href);
  await page.locator('#fileInput').setInputFiles({name:'fallback.png',mimeType:'image/png',buffer:input});
  await page.locator('#editorPanel').waitFor({state:'visible'});
  const box=await page.locator('#maskCanvas').boundingBox();
  await page.locator('#brushSize').evaluate(element=>{element.value='60';element.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.mouse.move(box.x+box.width*.35,box.y+box.height*.52);await page.mouse.down();await page.mouse.move(box.x+box.width*.65,box.y+box.height*.52,{steps:8});await page.mouse.up();
  await page.locator('#restoreButton').click();
  await page.waitForFunction(()=>!document.querySelector('#downloadButton').disabled,null,{timeout:45000});
  assert.match(await page.locator('#modelStatus').innerText(),/自动切换轻量修复/,'AI failure did not activate the lightweight fallback');
  assert.equal(errors.length,0,`browser errors: ${errors.join(' | ')}`);
  console.log('PASS AI failure falls back without a page crash');
}catch(error){console.error(`FAIL ${error.message}`);process.exitCode=1;}finally{await browser.close();}
