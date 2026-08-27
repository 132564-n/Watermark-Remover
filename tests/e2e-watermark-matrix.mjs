import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const require=createRequire(import.meta.url);
function loadPackage(name){try{return require(name);}catch(error){const fallback=process.env.CODEX_TEST_NODE_MODULES;if(fallback)return require(`${fallback}/${name}`);throw error;}}
const {chromium}=loadPackage('playwright'),sharp=loadPackage('sharp');
const width=600,height=400,centers=[[150,100],[450,100],[150,300],[450,300]];
const background=Buffer.from(`<svg width="600" height="400" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#071426"/><stop offset=".5" stop-color="#9b311f"/><stop offset="1" stop-color="#0b5b4a"/></linearGradient></defs>
  <rect width="600" height="400" fill="url(#g)"/>
  <g fill="none" stroke-width="4">${Array.from({length:22},(_,i)=>`<path d="M${i*31-80} 0 L${620-i*13} 400" stroke="${i%2?'#f7be4a':'#58c9e8'}" opacity=".72"/>`).join('')}</g>
  <g fill="none" stroke="#f5f7fb" stroke-width="3" opacity=".65"><circle cx="150" cy="100" r="70"/><rect x="365" y="30" width="165" height="135" rx="22"/><path d="M55 340 Q150 205 245 340"/><path d="M350 360 L450 225 L555 360 Z"/></g>
</svg>`);
const watermark=Buffer.from(`<svg width="600" height="400" xmlns="http://www.w3.org/2000/svg"><g font-family="Arial" font-size="20" font-weight="700" fill="#eef2f7" fill-opacity=".58" stroke="#667085" stroke-opacity=".4" stroke-width="1.2">${centers.map(([x,y])=>`<text x="${x}" y="${y+7}" text-anchor="middle" transform="rotate(-18 ${x} ${y})">SAMPLE MARK</text>`).join('')}</g></svg>`);
const cleanPng=await sharp(background).png().toBuffer(),inputPng=await sharp(cleanPng).composite([{input:watermark}]).png().toBuffer();
const clean=await sharp(cleanPng).ensureAlpha().raw().toBuffer(),before=await sharp(inputPng).ensureAlpha().raw().toBuffer();

function metrics(after){
  let beforeError=0,afterError=0,count=0,edgeAfter=0,edgeClean=0,unchanged=0,cleanPixels=0;
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
    const i=(y*width+x)*4;let affected=false;
    for(let c=0;c<3;c++)if(Math.abs(before[i+c]-clean[i+c])>2)affected=true;
    if(affected){
      for(let c=0;c<3;c++){
        beforeError+=(before[i+c]-clean[i+c])**2;afterError+=(after[i+c]-clean[i+c])**2;count++;
        edgeAfter+=Math.abs(after[i+c]-after[i-4+c])+Math.abs(after[i+c]-after[i-width*4+c]);
        edgeClean+=Math.abs(clean[i+c]-clean[i-4+c])+Math.abs(clean[i+c]-clean[i-width*4+c]);
      }
    }else{
      cleanPixels++;if(after[i]===before[i]&&after[i+1]===before[i+1]&&after[i+2]===before[i+2])unchanged++;
    }
  }
  return {beforeRmse:Math.sqrt(beforeError/count),rmse:Math.sqrt(afterError/count),edgeRatio:edgeAfter/edgeClean,unchangedRatio:unchanged/cleanPixels};
}

const installedChrome=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser=await chromium.launch({headless:true,...(installedChrome?{executablePath:installedChrome}:{}),args:['--no-sandbox','--disable-gpu']});
const page=await browser.newPage({viewport:{width:1280,height:900}}),heavyRequests=[],errors=[];
page.on('request',request=>{if(/\.onnx|\.wasm|ort\.min\.js/.test(request.url()))heavyRequests.push(request.url());});
page.on('pageerror',error=>errors.push(error.message));page.on('crash',()=>errors.push('renderer crashed'));
try{
  await page.goto(process.env.WATERMARK_TEST_URL||new URL('../index.html',import.meta.url).href);
  await page.locator('#fileInput').setInputFiles({name:'watermark-matrix.png',mimeType:'image/png',buffer:inputPng});
  await page.locator('#editorPanel').waitFor({state:'visible'});await page.locator('#detectTool').click();
  const box=await page.locator('#maskCanvas').boundingBox(),sx=box.width/width,sy=box.height/height;
  await page.mouse.click(box.x+centers[0][0]*sx,box.y+centers[0][1]*sy);
  await page.waitForFunction(()=>document.querySelectorAll('.watermark-detection').length>=4,null,{timeout:10000});
  assert.equal(await page.locator('.watermark-detection').count(),4,'recognition produced false-positive watermark boxes');
  await page.locator('#fastModeButton').click();await page.locator('#restoreButton').click();
  await page.waitForFunction(()=>!document.querySelector('#downloadButton').disabled,null,{timeout:30000});
  const after=Buffer.from(await page.locator('#imageCanvas').evaluate(canvas=>Array.from(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data)));
  const result=metrics(after);
  console.log(`MATRIX repeated-transparent rmse=${result.rmse.toFixed(2)}/${result.beforeRmse.toFixed(2)} edge=${(result.edgeRatio*100).toFixed(1)}% unchanged=${(result.unchangedRatio*100).toFixed(3)}% heavy=${heavyRequests.length}`);
  assert(result.rmse<result.beforeRmse*.62,`transparent watermark was not reduced enough: ${result.rmse.toFixed(2)}/${result.beforeRmse.toFixed(2)}`);
  assert(result.edgeRatio>.78&&result.edgeRatio<1.9,`covered detail was blurred or over-sharpened: ${(result.edgeRatio*100).toFixed(1)}%`);
  assert(result.unchangedRatio>.998,'too many pixels outside the watermark changed');
  assert.equal(heavyRequests.length,0,'repeated transparent watermark unexpectedly loaded the heavyweight AI runtime');
  assert.equal(errors.length,0,`browser errors: ${errors.join(' | ')}`);
  console.log('PASS watermark matrix');
}catch(error){console.error(`FAIL ${error.message}`);process.exitCode=1;}finally{await browser.close();}
