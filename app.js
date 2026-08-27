const $ = (id) => document.getElementById(id);

const els = {
  fileInput: $('fileInput'), dropZone: $('dropZone'), intro: $('introPanel'), editor: $('editorPanel'),
  newImage: $('newImageButton'), imageCanvas: $('imageCanvas'), maskCanvas: $('maskCanvas'),
  canvasShell: $('canvasShell'), viewport: $('canvasViewport'), cursor: $('brushCursor'),
  brush: $('brushTool'), eraser: $('eraserTool'), detect: $('detectTool'), detectionLayer: $('detectionLayer'), instructionText: $('instructionText'),
  brushSize: $('brushSize'), brushSizeValue: $('brushSizeValue'),
  undo: $('undoButton'), redo: $('redoButton'), clear: $('clearMaskButton'), restore: $('restoreButton'),
  compare: $('compareButton'), download: $('downloadButton'), coverageText: $('coverageText'),
  coverageDot: document.querySelector('.coverage-dot'), emptyInstruction: $('emptyInstruction'),
  fileName: $('fileName'), imageMeta: $('imageMeta'), zoomValue: $('zoomValue'), toast: $('toast'),
  aiMode: $('aiModeButton'), fastMode: $('fastModeButton'), modelStatus: $('modelStatus')
};

const imageCtx = els.imageCanvas.getContext('2d', { willReadFrequently: true });
const maskCtx = els.maskCanvas.getContext('2d', { willReadFrequently: true });
const state = { original: null, result: null, fileName: '', tool: 'brush', mode: 'ai', drawing: false, processing: false, recognizing: false, last: null, zoom: 1, fitZoom: 1, history: [], historyIndex: -1, hasMask: false, restored: false, detections: [], detectionTemplate: null };
const AI_RUNTIME_URL = './vendor/ort.min.js';
const AI_WASM_PATH = {
  'ort-wasm-simd-threaded.jsep.mjs': new URL('./vendor/ort-wasm-simd-threaded.jsep.js',window.location.href).href,
  'ort-wasm-simd-threaded.jsep.wasm': new URL('./vendor/ort-wasm-simd-threaded.jsep.wasm',window.location.href).href
};
const AI_MODEL_URL = './models/lama_512_int8.onnx';
let aiSession = null;
let aiSessionPromise = null;

function toast(message) {
  els.toast.textContent = message; els.toast.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => els.toast.classList.remove('show'), 2100);
}

function openPicker() { els.fileInput.click(); }
els.dropZone.addEventListener('click', openPicker);
els.newImage.addEventListener('click', openPicker);
els.fileInput.addEventListener('change', (e) => loadFile(e.target.files[0]));
['dragenter','dragover'].forEach(type => els.dropZone.addEventListener(type, e => { e.preventDefault(); els.dropZone.classList.add('dragover'); }));
['dragleave','drop'].forEach(type => els.dropZone.addEventListener(type, e => { e.preventDefault(); els.dropZone.classList.remove('dragover'); }));
els.dropZone.addEventListener('drop', e => loadFile(e.dataTransfer.files[0]));

function loadFile(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return toast('请选择 JPG、PNG 或 WebP 图片');
  if (file.size > 20 * 1024 * 1024) return toast('图片超过 20 MB，请压缩后重试');
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => setupImage(img, file.name);
    img.onerror = () => toast('无法读取这张图片');
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function setupImage(img, name) {
  const maxSide = 3200;
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  [els.imageCanvas, els.maskCanvas].forEach(c => { c.width = w; c.height = h; });
  imageCtx.clearRect(0,0,w,h); imageCtx.drawImage(img,0,0,w,h);
  state.original = imageCtx.getImageData(0,0,w,h); state.result = null; state.fileName = name;
  maskCtx.clearRect(0,0,w,h); state.history = []; state.historyIndex = -1; state.hasMask = false; state.restored = false;
  clearDetectionState();
  els.fileName.textContent = name; els.imageMeta.textContent = `${w} × ${h}${scale < 1 ? ' · 已优化尺寸' : ''}`;
  els.intro.hidden = true; els.editor.hidden = false; els.newImage.disabled = false;
  requestAnimationFrame(() => { fitCanvas(); pushHistory(); updateUI(); });
}

function fitCanvas() {
  if (!state.original) return;
  const availableW = els.viewport.clientWidth - 70, availableH = els.viewport.clientHeight - 70;
  state.fitZoom = Math.min(1, availableW / els.imageCanvas.width, availableH / els.imageCanvas.height);
  setZoom(state.fitZoom);
}
function setZoom(value) {
  state.zoom = Math.max(.1, Math.min(3, value));
  els.canvasShell.style.width = `${els.imageCanvas.width * state.zoom}px`;
  els.canvasShell.style.height = `${els.imageCanvas.height * state.zoom}px`;
  els.zoomValue.value = `${Math.round(state.zoom * 100)}%`;
}
$('zoomIn').addEventListener('click', () => setZoom(state.zoom * 1.2));
$('zoomOut').addEventListener('click', () => setZoom(state.zoom / 1.2));
$('fitButton').addEventListener('click', fitCanvas);

function selectTool(tool) {
  state.tool = tool;
  const activeButton={brush:els.brush,eraser:els.eraser,detect:els.detect}[tool];
  [els.brush,els.eraser,els.detect].forEach(button=>{const active=button===activeButton;button.classList.toggle('active',active);button.setAttribute('aria-pressed',active);});
  els.canvasShell.classList.toggle('detecting',tool==='detect');
  els.detectionLayer.classList.toggle('active',tool==='detect');
  els.cursor.style.display='none';
  els.instructionText.innerHTML=tool==='detect'?'点击一处水印中心<br />自动查找相似字码':'用画笔完整覆盖水印<br />可多涂出一点边缘';
  updateUI();
}
els.brush.addEventListener('click', () => selectTool('brush'));
els.eraser.addEventListener('click', () => selectTool('eraser'));
els.detect.addEventListener('click', () => selectTool('detect'));
els.brushSize.addEventListener('input', () => { els.brushSizeValue.value = `${els.brushSize.value} px`; updateCursorSize(); });
function updateCursorSize() { const size = Number(els.brushSize.value) * state.zoom; els.cursor.style.width = `${size}px`; els.cursor.style.height = `${size}px`; }

function selectMode(mode) {
  if (state.processing) return;
  state.mode = mode;
  [els.aiMode, els.fastMode].forEach(button => {
    const active = button === (mode === 'ai' ? els.aiMode : els.fastMode);
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', active);
  });
  updateModelStatus(); updateUI();
}
els.aiMode.addEventListener('click', () => selectMode('ai'));
els.fastMode.addEventListener('click', () => selectMode('fast'));

function updateModelStatus(message, kind) {
  els.modelStatus.className = `model-status${kind ? ` ${kind}` : ''}`;
  if (message) els.modelStatus.lastChild.textContent = message;
  else if (state.mode === 'fast') els.modelStatus.lastChild.textContent = '无需加载模型，适合简单背景';
  else if (aiSession) { els.modelStatus.classList.add('ready'); els.modelStatus.lastChild.textContent = 'AI 模型已就绪，图片仍在本机处理'; }
  else els.modelStatus.lastChild.textContent = '首次使用需加载约 62 MB 模型';
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.ort) return resolve();
    const script = document.createElement('script'); script.src = src; script.async = true;
    script.onload = resolve; script.onerror = () => reject(new Error('推理组件加载失败'));
    document.head.appendChild(script);
  });
}

async function getAiSession() {
  if (aiSession) return aiSession;
  if (aiSessionPromise) return aiSessionPromise;
  aiSessionPromise = (async () => {
    updateModelStatus('正在加载 AI 推理组件…', 'loading');
    await loadScript(AI_RUNTIME_URL);
    window.ort.env.wasm.wasmPaths = AI_WASM_PATH;
    window.ort.env.wasm.numThreads = 1;
    updateModelStatus('正在下载并初始化模型（约 62 MB）…', 'loading');
    aiSession = await window.ort.InferenceSession.create(AI_MODEL_URL, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    updateModelStatus('AI 模型已就绪，图片仍在本机处理', 'ready');
    return aiSession;
  })().catch(error => { aiSessionPromise = null; updateModelStatus('AI 模型加载失败，请重试或使用快速填充', 'error'); throw error; });
  return aiSessionPromise;
}

function clearDetectionState() {
  state.detections=[];state.detectionTemplate=null;
  if(els.detectionLayer){els.detectionLayer.replaceChildren();els.detectionLayer.hidden=true;}
}

function recognitionData(source,w,h) {
  const scale=Math.min(1,900/Math.max(w,h)),workW=Math.max(1,Math.round(w*scale)),workH=Math.max(1,Math.round(h*scale));
  const sourceCanvas=document.createElement('canvas');sourceCanvas.width=w;sourceCanvas.height=h;sourceCanvas.getContext('2d').putImageData(source,0,0);
  const workCanvas=document.createElement('canvas');workCanvas.width=workW;workCanvas.height=workH;
  const workCtx=workCanvas.getContext('2d',{willReadFrequently:true});workCtx.drawImage(sourceCanvas,0,0,workW,workH);
  const pixels=workCtx.getImageData(0,0,workW,workH).data,gray=new Float32Array(workW*workH),chroma=new Uint8Array(workW*workH);
  for(let i=0;i<gray.length;i++){
    const r=pixels[i*4],g=pixels[i*4+1],b=pixels[i*4+2];
    gray[i]=r*.299+g*.587+b*.114;chroma[i]=Math.max(r,g,b)-Math.min(r,g,b);
  }
  const integral=new Float64Array((workW+1)*(workH+1));
  for(let y=0;y<workH;y++){
    let row=0;
    for(let x=0;x<workW;x++){row+=gray[y*workW+x];integral[(y+1)*(workW+1)+x+1]=integral[y*(workW+1)+x+1]+row;}
  }
  const highPass=new Float32Array(gray.length),radius=3;
  for(let y=0;y<workH;y++)for(let x=0;x<workW;x++){
    const x1=Math.max(0,x-radius),y1=Math.max(0,y-radius),x2=Math.min(workW-1,x+radius),y2=Math.min(workH-1,y+radius);
    const sum=integral[(y2+1)*(workW+1)+x2+1]-integral[y1*(workW+1)+x2+1]-integral[(y2+1)*(workW+1)+x1]+integral[y1*(workW+1)+x1];
    highPass[y*workW+x]=gray[y*workW+x]-sum/((x2-x1+1)*(y2-y1+1));
  }
  return {scale,workW,workH,highPass,gray,chroma};
}

function templateFeatures(data,x0,y0,tw,th,neutralOnly=true) {
  const ranked=[];
  for(let y=2;y<th-2;y++)for(let x=2;x<tw-2;x++){
    if(Math.abs(y-th/2+(x-tw/2)*.45)>th*.32)continue;
    const index=(y0+y)*data.workW+x0+x;
    if(neutralOnly&&(data.chroma[index]>52||data.gray[index]<82))continue;
    const value=data.highPass[index],strength=Math.abs(value);
    if(strength>3)ranked.push({x,y,value,strength});
  }
  ranked.sort((a,b)=>b.strength-a.strength);
  const features=[];
  for(const feature of ranked){
    if(features.some(chosen=>Math.abs(chosen.x-feature.x)<=1&&Math.abs(chosen.y-feature.y)<=1))continue;
    features.push(feature);if(features.length>=320)break;
  }
  return features;
}

function templateScore(features,highPass,workW,workH,x,y) {
  let dot=0,templateEnergy=0,energy=0,visible=0;
  for(const feature of features){
    const px=x+feature.x,py=y+feature.y;if(px<0||py<0||px>=workW||py>=workH)continue;
    const value=highPass[py*workW+px];dot+=feature.value*value;templateEnergy+=feature.value*feature.value;energy+=value*value;visible++;
  }
  return visible>=features.length*.55&&energy?dot/Math.sqrt(templateEnergy*energy):-1;
}

function neutralTemplateScore(features,data,seedX,seedY,x,y) {
  let matched=0,total=0;
  for(const feature of features){
    const seed=(seedY+feature.y)*data.workW+seedX+feature.x;
    if(data.chroma[seed]>=68||data.gray[seed]<=72)continue;
    const px=x+feature.x,py=y+feature.y;if(px<0||py<0||px>=data.workW||py>=data.workH)continue;
    total++;
    const index=py*data.workW+px,value=data.highPass[index];
    if(data.chroma[index]<68&&data.gray[index]>72&&Math.sign(value)===Math.sign(feature.value))matched++;
  }
  return total?matched/total:0;
}

function dilateBinary(mask,w,h,passes=2) {
  let current=mask;
  for(let pass=0;pass<passes;pass++){
    const next=current.slice();
    for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
      const i=y*w+x;if(!current[i]&&(current[i-1]||current[i+1]||current[i-w]||current[i+w]))next[i]=1;
    }
    current=next;
  }
  return current;
}

function createRecognitionMask(highPass,gray,chroma,workW,detections,tw,th) {
  let mask=new Uint8Array(tw*th),count=0;
  const needed=Math.max(1,Math.ceil(detections.length*.6));
  for(let y=1;y<th-1;y++)for(let x=1;x<tw-1;x++){
    if(Math.abs(y-th/2+(x-tw/2)*.45)>th*.32)continue;
    const values=[];let neutral=0;
    for(const detection of detections){
      const index=(detection.y+y)*workW+detection.x+x,value=highPass[index];
      values.push(value);
      if(chroma[index]<68&&gray[index]>72)neutral++;
    }
    values.sort((a,b)=>a-b);const middle=values.length>>1,center=values.length%2?values[middle]:(values[middle-1]+values[middle])/2;
    const deviations=values.map(value=>Math.abs(value-center)).sort((a,b)=>a-b),deviation=deviations.length%2?deviations[middle]:(deviations[middle-1]+deviations[middle])/2;
    if(neutral>=needed&&Math.abs(center)>1.25&&Math.abs(center)/(deviation+2)>.28){mask[y*tw+x]=1;count++;}
  }
  if(count<tw*th*.012){
    for(let y=1;y<th-1;y++)for(let x=1;x<tw-1;x++){
      const index=(detections[0].y+y)*workW+detections[0].x+x;
      if(Math.abs(highPass[index])>8&&chroma[index]<68&&gray[index]>72)mask[y*tw+x]=1;
    }
  }
  mask=dilateBinary(mask,tw,th,1);
  const canvas=document.createElement('canvas');canvas.width=tw;canvas.height=th;
  const ctx=canvas.getContext('2d'),image=ctx.createImageData(tw,th);
  for(let i=0;i<mask.length;i++)if(mask[i]){image.data[i*4]=47;image.data[i*4+1]=103;image.data[i*4+2]=246;image.data[i*4+3]=122;}
  ctx.putImageData(image,0,0);
  return canvas;
}

function findSimilarWatermarks(source,w,h,point) {
  const data=recognitionData(source,w,h),shortSide=Math.min(data.workW,data.workH),longSide=Math.max(data.workW,data.workH);
  const tw=Math.max(108,Math.min(180,Math.round(Math.min(shortSide*.34,longSide*.19)))),th=Math.max(40,Math.round(tw*.38));
  const seedX=Math.max(0,Math.min(data.workW-tw,Math.round(point.x*data.scale-tw/2)));
  const seedY=Math.max(0,Math.min(data.workH-th,Math.round(point.y*data.scale-th/2)));
  let features=templateFeatures(data,seedX,seedY,tw,th);
  if(features.length<40)features=templateFeatures(data,seedX,seedY,tw,th,false);
  if(features.length<40)throw new Error('这里的字形特征太少，请点击水印文字中心');
  const step=Math.max(2,Math.round(shortSide/260));
  const candidates=[{x:seedX,y:seedY,score:1,selected:true}];
  const minX=-Math.round(tw*.45),maxX=data.workW-Math.round(tw*.55),minY=-Math.round(th*.45),maxY=data.workH-Math.round(th*.55);
  for(let y=minY;y<=maxY;y+=step)for(let x=minX;x<=maxX;x+=step){
    const score=templateScore(features,data.highPass,data.workW,data.workH,x,y);
    if(score>.24)candidates.push({x,y,score,selected:true});
  }
  candidates.sort((a,b)=>b.score-a.score);
  const detections=[];
  for(const candidate of candidates){
    if(candidate.score<.32)break;
    let refined=candidate;
    if(candidate.score<1){
      for(let y=candidate.y-step;y<=candidate.y+step;y++)for(let x=candidate.x-step;x<=candidate.x+step;x++){
        const score=templateScore(features,data.highPass,data.workW,data.workH,x,y);
        if(score>refined.score)refined={x,y,score,selected:true};
      }
    }
    if(refined.score<.5&&neutralTemplateScore(features,data,seedX,seedY,refined.x,refined.y)<.55)continue;
    const overlaps=detections.some(item=>Math.abs(item.x-refined.x)<tw*.7&&Math.abs(item.y-refined.y)<th*.7);
    if(!overlaps){detections.push(refined);if(detections.length>=24)break;}
  }
  const seedPresent=detections.some(item=>Math.abs(item.x-seedX)<tw*.35&&Math.abs(item.y-seedY)<th*.35);
  if(!seedPresent)detections.unshift({x:seedX,y:seedY,score:1,selected:true});
  const maskSources=detections.filter(item=>item.x>=0&&item.y>=0&&item.x+tw<=data.workW&&item.y+th<=data.workH);
  const templateCanvas=createRecognitionMask(data.highPass,data.gray,data.chroma,data.workW,maskSources.length?maskSources:[{x:seedX,y:seedY}],tw,th);
  return {detections,template:{canvas:templateCanvas,workW:data.workW,workH:data.workH,tw,th,scale:data.scale}};
}

function renderDetectionBoxes() {
  els.detectionLayer.replaceChildren();
  if(!state.detectionTemplate||!state.detections.length){els.detectionLayer.hidden=true;return;}
  const {workW,workH,tw,th}=state.detectionTemplate;
  state.detections.forEach((detection,index)=>{
    const button=document.createElement('button');button.type='button';button.className='watermark-detection';
    button.setAttribute('aria-label',`识别到的水印 ${index+1}`);button.setAttribute('aria-pressed',String(detection.selected));
    button.title=`相似度 ${Math.round(detection.score*100)}% · 点击${detection.selected?'取消':'恢复'}`;
    const left=Math.max(0,detection.x),top=Math.max(0,detection.y),right=Math.min(workW,detection.x+tw),bottom=Math.min(workH,detection.y+th);
    button.style.left=`${left/workW*100}%`;button.style.top=`${top/workH*100}%`;
    button.style.width=`${Math.max(0,right-left)/workW*100}%`;button.style.height=`${Math.max(0,bottom-top)/workH*100}%`;
    button.addEventListener('click',event=>{
      event.stopPropagation();detection.selected=!detection.selected;
      button.setAttribute('aria-pressed',String(detection.selected));button.title=`点击${detection.selected?'取消':'恢复'}这处水印`;
      renderDetectionMask(true);
    });
    els.detectionLayer.appendChild(button);
  });
  els.detectionLayer.hidden=state.restored;
}

function renderDetectionMask(addHistory=false) {
  if(!state.detectionTemplate)return;
  const template=state.detectionTemplate,workCanvas=document.createElement('canvas');workCanvas.width=template.workW;workCanvas.height=template.workH;
  const workCtx=workCanvas.getContext('2d');
  for(const detection of state.detections)if(detection.selected)workCtx.drawImage(template.canvas,detection.x,detection.y);
  maskCtx.clearRect(0,0,els.maskCanvas.width,els.maskCanvas.height);maskCtx.save();maskCtx.imageSmoothingEnabled=false;
  maskCtx.drawImage(workCanvas,0,0,els.maskCanvas.width,els.maskCanvas.height);maskCtx.restore();
  if(addHistory)pushHistory();
  updateUI();
}

async function recognizeFromPoint(point) {
  if(state.recognizing||state.processing)return;
  state.recognizing=true;updateUI();
  await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,20)));
  try{
    const result=findSimilarWatermarks(state.original,els.imageCanvas.width,els.imageCanvas.height,point);
    state.detections=result.detections;state.detectionTemplate=result.template;
    renderDetectionBoxes();renderDetectionMask(true);
    toast(`识别到 ${state.detections.length} 处相似水印，可点击虚线框取消`);
  }catch(error){toast(error.message||'没有识别到相似水印');}
  finally{state.recognizing=false;updateUI();}
}

function pointFromEvent(e) {
  const r = els.maskCanvas.getBoundingClientRect();
  return { x:(e.clientX-r.left) * els.maskCanvas.width/r.width, y:(e.clientY-r.top) * els.maskCanvas.height/r.height };
}
function renderStroke(a,b) {
  maskCtx.save(); maskCtx.globalCompositeOperation = state.tool === 'brush' ? 'source-over' : 'destination-out';
  maskCtx.strokeStyle = state.tool === 'brush' ? 'rgba(47,103,246,.48)' : 'rgba(0,0,0,1)';
  maskCtx.lineWidth = Number(els.brushSize.value); maskCtx.lineCap = 'round'; maskCtx.lineJoin = 'round';
  maskCtx.beginPath(); maskCtx.moveTo(a.x,a.y); maskCtx.lineTo(b.x,b.y); maskCtx.stroke(); maskCtx.restore();
}
els.maskCanvas.addEventListener('pointerdown', e => {
  e.preventDefault();
  if (state.restored) {
    // Accept the previous repair as the new base so distant watermarks can be fixed in several passes.
    state.original = new ImageData(new Uint8ClampedArray(state.result.data), state.result.width, state.result.height);
    imageCtx.putImageData(state.original, 0, 0); maskCtx.clearRect(0,0,els.maskCanvas.width,els.maskCanvas.height);
    clearDetectionState();state.history=[];state.historyIndex=-1;pushHistory();els.maskCanvas.style.opacity = '1';
  }
  if(state.tool==='detect'){recognizeFromPoint(pointFromEvent(e));return;}
  if(state.detections.length)clearDetectionState();
  els.maskCanvas.setPointerCapture(e.pointerId); state.drawing=true; state.last=pointFromEvent(e); renderStroke(state.last,state.last); updateUI();
});
els.maskCanvas.addEventListener('pointermove', e => {
  const r = els.canvasShell.getBoundingClientRect(); els.cursor.style.left=`${e.clientX-r.left}px`; els.cursor.style.top=`${e.clientY-r.top}px`;
  if (!state.drawing||state.tool==='detect') return; const p=pointFromEvent(e); renderStroke(state.last,p); state.last=p;
});
els.maskCanvas.addEventListener('pointerenter', () => { if(state.tool!=='detect'){els.cursor.style.display='block';updateCursorSize();} });
els.maskCanvas.addEventListener('pointerleave', () => { if(!state.drawing) els.cursor.style.display='none'; });
function endStroke() { if (!state.drawing) return; state.drawing=false; pushHistory(); updateUI(); }
els.maskCanvas.addEventListener('pointerup', endStroke); els.maskCanvas.addEventListener('pointercancel', endStroke);

function maskHasPixels(data) { for(let i=3;i<data.length;i+=16) if(data[i]>20) return true; return false; }
function pushHistory() {
  const snapshot = maskCtx.getImageData(0,0,els.maskCanvas.width,els.maskCanvas.height);
  state.history = state.history.slice(0,state.historyIndex+1); state.history.push(snapshot); state.historyIndex++;
  if(state.history.length>20){state.history.shift();state.historyIndex--;} state.restored=false; state.result=null;
}
function restoreHistory(index){ if(index<0||index>=state.history.length)return; state.historyIndex=index; maskCtx.putImageData(state.history[index],0,0); clearDetectionState();state.restored=false; state.result=null; imageCtx.putImageData(state.original,0,0); updateUI(); }
els.undo.addEventListener('click',()=>restoreHistory(state.historyIndex-1)); els.redo.addEventListener('click',()=>restoreHistory(state.historyIndex+1));
els.clear.addEventListener('click',()=>{clearDetectionState();maskCtx.clearRect(0,0,els.maskCanvas.width,els.maskCanvas.height);pushHistory();updateUI();});

function updateUI(){
  const data=maskCtx.getImageData(0,0,els.maskCanvas.width,els.maskCanvas.height).data; state.hasMask=maskHasPixels(data);
  els.undo.disabled=state.historyIndex<=0; els.redo.disabled=state.historyIndex>=state.history.length-1; els.clear.disabled=!state.hasMask;
  els.restore.disabled=!state.hasMask||state.processing||state.recognizing; els.compare.disabled=!state.restored||state.processing; els.download.disabled=!state.restored||state.processing;
  els.aiMode.disabled=state.processing; els.fastMode.disabled=state.processing;els.detect.disabled=state.processing;els.brushSize.disabled=state.processing||state.tool==='detect';
  const selectedDetections=state.detections.filter(detection=>detection.selected).length;
  els.coverageText.textContent=state.recognizing?'正在识别相似水印…':state.detections.length?`已选择 ${selectedDetections}/${state.detections.length} 处水印`:state.hasMask?'选区已就绪':'尚未标记';
  els.coverageDot.classList.toggle('ready',state.hasMask&&!state.recognizing);
  els.emptyInstruction.hidden=state.hasMask||state.recognizing;
  if(state.detections.length)els.detectionLayer.hidden=state.restored;
  if(!state.restored && !state.processing) { els.maskCanvas.style.opacity='1'; els.restore.querySelector('span').textContent=state.mode==='ai'?'开始 AI 修复':'开始快速修复'; }
}

function inpaint(source, maskData, w, h) {
  const size = w * h;
  const out = new Uint8ClampedArray(source.data);
  let masked = new Uint8Array(size);
  for (let i = 0; i < size; i++) if (maskData.data[i * 4 + 3] > 20) masked[i] = 1;

  // Expand the user's stroke by two pixels so anti-aliased watermark edges are not sampled as clean color.
  for (let pass = 0; pass < 2; pass++) {
    const expanded = masked.slice();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (masked[i]) continue;
      if (masked[i - 1] || masked[i + 1] || masked[i - w] || masked[i + w]) expanded[i] = 1;
    }
    masked = expanded;
  }

  // Precompute the nearest clean source pixel in all four directions.
  const left = new Int32Array(size), right = new Int32Array(size), top = new Int32Array(size), bottom = new Int32Array(size);
  left.fill(-1); right.fill(-1); top.fill(-1); bottom.fill(-1);
  for (let y = 0; y < h; y++) {
    let known = -1;
    for (let x = 0; x < w; x++) { const i = y * w + x; if (!masked[i]) known = i; else left[i] = known; }
    known = -1;
    for (let x = w - 1; x >= 0; x--) { const i = y * w + x; if (!masked[i]) known = i; else right[i] = known; }
  }
  for (let x = 0; x < w; x++) {
    let known = -1;
    for (let y = 0; y < h; y++) { const i = y * w + x; if (!masked[i]) known = i; else top[i] = known; }
    known = -1;
    for (let y = h - 1; y >= 0; y--) { const i = y * w + x; if (!masked[i]) known = i; else bottom[i] = known; }
  }

  const interpolate = (a, b, distanceA, distanceB, channel) => {
    const total = distanceA + distanceB;
    return (source.data[a * 4 + channel] * distanceB + source.data[b * 4 + channel] * distanceA) / total;
  };

  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!masked[i]) continue;
    const li = left[i], ri = right[i], ti = top[i], bi = bottom[i];
    const horizontalSpan = li >= 0 && ri >= 0 ? (ri % w) - (li % w) : 0;
    const verticalSpan = ti >= 0 && bi >= 0 ? ((bi / w) | 0) - ((ti / w) | 0) : 0;

    for (let c = 0; c < 4; c++) {
      let sum = 0, weight = 0;
      if (horizontalSpan) {
        const dl = x - (li % w), dr = (ri % w) - x;
        const pairWeight = 1 / horizontalSpan;
        sum += interpolate(li, ri, dl, dr, c) * pairWeight; weight += pairWeight;
      }
      if (verticalSpan) {
        const dt = y - ((ti / w) | 0), db = ((bi / w) | 0) - y;
        const pairWeight = 1 / verticalSpan;
        sum += interpolate(ti, bi, dt, db, c) * pairWeight; weight += pairWeight;
      }
      if (!weight) {
        const candidates = [li, ri, ti, bi].filter(v => v >= 0);
        if (candidates.length) sum = source.data[candidates[0] * 4 + c], weight = 1;
      }
      if (weight) out[i * 4 + c] = sum / weight;
    }
  }

  return new ImageData(out, w, h);
}

function exemplarInpaint(source,maskData,w,h) {
  const size=w*h,out=new Uint8ClampedArray(source.data),masked=new Uint8Array(size),filled=new Uint8Array(size),distance=new Int16Array(size),bestSources=new Int32Array(size),queue=[];
  distance.fill(-1);bestSources.fill(-1);
  for(let pixel=0;pixel<size;pixel++)masked[pixel]=maskData.data[pixel*4+3]>20?1:0;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const pixel=y*w+x;if(!masked[pixel])continue;
    if((x&& !masked[pixel-1])||(x<w-1&&!masked[pixel+1])||(y&&!masked[pixel-w])||(y<h-1&&!masked[pixel+w])){distance[pixel]=1;queue.push(pixel);}
  }
  for(let head=0;head<queue.length;head++){
    const pixel=queue[head],x=pixel%w,y=(pixel/w)|0;
    for(const next of [x?pixel-1:-1,x<w-1?pixel+1:-1,y?pixel-w:-1,y<h-1?pixel+w:-1])if(next>=0&&masked[next]&&distance[next]<0){distance[next]=distance[pixel]+1;queue.push(next);}
  }
  const searchRadius=18,patchRadius=2;
  for(const pixel of queue){
    const x=pixel%w,y=(pixel/w)|0,context=[];
    for(let oy=-patchRadius;oy<=patchRadius;oy++)for(let ox=-patchRadius;ox<=patchRadius;ox++){
      if(!ox&&!oy)continue;const nx=x+ox,ny=y+oy;if(nx<0||ny<0||nx>=w||ny>=h)continue;
      const neighbor=ny*w+nx;if(!masked[neighbor]||filled[neighbor])context.push({ox,oy,index:neighbor*4});
    }
    let best=-1,bestScore=Infinity;
    const evaluate=candidate=>{
      if(candidate<0||candidate>=size||masked[candidate]||context.length<5)return;
      const cx=candidate%w,cy=(candidate/w)|0;
      let score=(cx-x)*(cx-x)+(cy-y)*(cy-y),count=0;
      for(const sample of context){
        const sx=cx+sample.ox,sy=cy+sample.oy;if(sx<0||sy<0||sx>=w||sy>=h)continue;
        const sourceIndex=(sy*w+sx)*4;
        for(let channel=0;channel<3;channel++){const difference=out[sample.index+channel]-source.data[sourceIndex+channel];score+=difference*difference;}
        count++;
      }
      if(count>=5&&(score/=count)<bestScore){bestScore=score;best=candidate;}
    };
    for(const sample of context){
      const neighbor=(sample.index/4)|0,sourceNeighbor=bestSources[neighbor];
      if(sourceNeighbor>=0)evaluate(sourceNeighbor+pixel-neighbor);
    }
    for(let cy=Math.max(0,y-searchRadius);cy<=Math.min(h-1,y+searchRadius);cy+=2)for(let cx=Math.max(0,x-searchRadius);cx<=Math.min(w-1,x+searchRadius);cx+=2)evaluate(cy*w+cx);
    const target=pixel*4;
    if(best>=0){const sourceIndex=best*4;for(let channel=0;channel<3;channel++)out[target+channel]=source.data[sourceIndex+channel];bestSources[pixel]=best;}
    else if(context.length){for(let channel=0;channel<3;channel++){let sum=0;for(const sample of context)sum+=out[sample.index+channel];out[target+channel]=sum/context.length;}}
    filled[pixel]=1;
  }
  const directional=inpaint(source,maskData,w,h).data;
  for(let pixel=0;pixel<size;pixel++)if(masked[pixel]){
    const index=pixel*4;
    for(let channel=0;channel<3;channel++)out[index+channel]=Math.round(out[index+channel]*.58+directional[index+channel]*.42);
  }
  return new ImageData(out,w,h);
}

async function removeRecognizedWatermarks(source,maskData,w,h) {
  updateModelStatus('正在进行局部纹理匹配修复…','loading');
  await new Promise(resolve=>requestAnimationFrame(resolve));
  const repaired=exemplarInpaint(source,maskData,w,h);
  updateModelStatus('局部纹理修复已完成','ready');
  return repaired;
}
function maskComponents(maskData, w, h) {
  const selected=new Uint8Array(w*h);
  for(let i=0;i<selected.length;i++)if(maskData.data[i*4+3]>20)selected[i]=1;
  const components=[];
  for(let start=0;start<selected.length;start++){
    if(!selected[start])continue;
    const stack=[start],pixels=[];selected[start]=0;
    let minX=w,minY=h,maxX=-1,maxY=-1;
    while(stack.length){
      const index=stack.pop(),x=index%w,y=(index/w)|0;pixels.push(index);
      minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);
      for(let ny=Math.max(0,y-1);ny<=Math.min(h-1,y+1);ny++)for(let nx=Math.max(0,x-1);nx<=Math.min(w-1,x+1);nx++){
        const next=ny*w+nx;if(selected[next]){selected[next]=0;stack.push(next);}
      }
    }
    components.push({pixels,minX,minY,maxX,maxY});
  }
  return components.sort((a,b)=>b.pixels.length-a.pixels.length);
}

function componentBounds(component, w, h) {
  const selectionSize=Math.max(component.maxX-component.minX+1,component.maxY-component.minY+1);
  const padding=Math.max(48,Math.round(selectionSize*.42));
  const targetSize=selectionSize+padding*2;
  const cropW=Math.min(w,targetSize),cropH=Math.min(h,targetSize);
  const centerX=(component.minX+component.maxX+1)/2,centerY=(component.minY+component.maxY+1)/2;
  const x=Math.max(0,Math.min(w-cropW,Math.round(centerX-cropW/2)));
  const y=Math.max(0,Math.min(h-cropH,Math.round(centerY-cropH/2)));
  return {x,y,right:x+cropW,bottom:y+cropH};
}

function dilateMask(mask, w, h, passes=2) {
  let current=mask;
  for(let pass=0;pass<passes;pass++){
    const next=current.slice();
    for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){const i=y*w+x;if(!current[i]&&(current[i-1]||current[i+1]||current[i-w]||current[i+w]))next[i]=1;}
    current=next;
  }
  return current;
}

function erodeMask(mask, w, h, passes) {
  let current=mask;
  for(let pass=0;pass<passes;pass++){
    const next=current.slice();
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const i=y*w+x;
      if(!current[i])continue;
      if(x===0||y===0||x===w-1||y===h-1||!current[i-1]||!current[i+1]||!current[i-w]||!current[i+w])next[i]=0;
    }
    current=next;
  }
  return current;
}

async function aiInpaintComponent(session, source, component, w, h, modelDilation=3) {
  const bounds=componentBounds(component,w,h);
  const cropW=bounds.right-bounds.x,cropH=bounds.bottom-bounds.y,modelSize=512,pixels=modelSize*modelSize;
  const sourceCanvas=document.createElement('canvas');sourceCanvas.width=w;sourceCanvas.height=h;
  const sourceCtx=sourceCanvas.getContext('2d',{willReadFrequently:true});sourceCtx.putImageData(source,0,0);
  const inputCanvas=document.createElement('canvas');inputCanvas.width=modelSize;inputCanvas.height=modelSize;
  const inputCtx=inputCanvas.getContext('2d',{willReadFrequently:true});inputCtx.drawImage(sourceCanvas,bounds.x,bounds.y,cropW,cropH,0,0,modelSize,modelSize);
  const inputImage=inputCtx.getImageData(0,0,modelSize,modelSize);
  let localMask=new Uint8Array(cropW*cropH);
  for(const index of component.pixels){
    const x=index%w-bounds.x,y=((index/w)|0)-bounds.y;
    if(x>=0&&x<cropW&&y>=0&&y<cropH)localMask[y*cropW+x]=1;
  }
  const contraction=Math.max(0,Math.round((Number(els.brushSize.value)-42)*.5));
  const guidedMask=erodeMask(localMask,cropW,cropH,contraction);
  if(guidedMask.some(value=>value))localMask=guidedMask;
  const localMaskCanvas=document.createElement('canvas');localMaskCanvas.width=cropW;localMaskCanvas.height=cropH;
  const localMaskCtx=localMaskCanvas.getContext('2d',{willReadFrequently:true}),localMaskImage=localMaskCtx.createImageData(cropW,cropH);
  for(let i=0;i<localMask.length;i++)if(localMask[i])localMaskImage.data[i*4+3]=255;
  localMaskCtx.putImageData(localMaskImage,0,0);
  const scaledMaskCanvas=document.createElement('canvas');scaledMaskCanvas.width=modelSize;scaledMaskCanvas.height=modelSize;
  const scaledMaskCtx=scaledMaskCanvas.getContext('2d',{willReadFrequently:true});scaledMaskCtx.imageSmoothingEnabled=false;scaledMaskCtx.drawImage(localMaskCanvas,0,0,cropW,cropH,0,0,modelSize,modelSize);
  const scaledMaskData=scaledMaskCtx.getImageData(0,0,modelSize,modelSize).data;
  let binaryMask=new Uint8Array(pixels);
  for(let i=0;i<pixels;i++)if(scaledMaskData[i*4+3]>20)binaryMask[i]=1;
  binaryMask=dilateMask(binaryMask,modelSize,modelSize,modelDilation);

  const tensorData=new Float32Array(pixels*4);
  for(let i=0;i<pixels;i++){
    const selected=binaryMask[i];
    tensorData[i]=selected?0:inputImage.data[i*4]/255;
    tensorData[pixels+i]=selected?0:inputImage.data[i*4+1]/255;
    tensorData[pixels*2+i]=selected?0:inputImage.data[i*4+2]/255;
    tensorData[pixels*3+i]=selected;
  }
  updateModelStatus('AI 正在重建选区内容…','loading');
  const feeds={[session.inputNames[0]]:new window.ort.Tensor('float32',tensorData,[1,4,modelSize,modelSize])};
  const outputs=await session.run(feeds),output=outputs[session.outputNames[0]].data;
  const patchImage=inputCtx.createImageData(modelSize,modelSize);
  for(let i=0;i<pixels;i++){
    patchImage.data[i*4]=Math.max(0,Math.min(255,Math.round(output[i]*255)));
    patchImage.data[i*4+1]=Math.max(0,Math.min(255,Math.round(output[pixels+i]*255)));
    patchImage.data[i*4+2]=Math.max(0,Math.min(255,Math.round(output[pixels*2+i]*255)));
    patchImage.data[i*4+3]=255;
  }
  inputCtx.putImageData(patchImage,0,0);
  const nativePatch=document.createElement('canvas');nativePatch.width=cropW;nativePatch.height=cropH;
  const nativeCtx=nativePatch.getContext('2d',{willReadFrequently:true});nativeCtx.drawImage(inputCanvas,0,0,cropW,cropH);
  const nativeData=nativeCtx.getImageData(0,0,cropW,cropH).data;
  const innerMask=dilateMask(localMask,cropW,cropH,2);
  const featherOne=dilateMask(innerMask,cropW,cropH,1),featherTwo=dilateMask(featherOne,cropW,cropH,1);
  const result=new ImageData(new Uint8ClampedArray(source.data),w,h);
  for(let y=0;y<cropH;y++)for(let x=0;x<cropW;x++){
    const maskIndex=y*cropW+x,blend=innerMask[maskIndex]?1:featherOne[maskIndex]?.55:featherTwo[maskIndex]?.25:0;
    if(!blend)continue;const target=(bounds.y+y)*w+bounds.x+x,from=maskIndex*4,to=target*4;
    for(let channel=0;channel<3;channel++)result.data[to+channel]=Math.round(source.data[to+channel]*(1-blend)+nativeData[from+channel]*blend);
  }
  return result;
}

async function aiInpaint(source, maskData, w, h) {
  const session=await getAiSession(),components=maskComponents(maskData,w,h);
  if(!components.length)throw new Error('没有可修复的选区');
  const combined={pixels:[],minX:w,minY:h,maxX:-1,maxY:-1};
  for(const component of components){
    for(const index of component.pixels)combined.pixels.push(index);
    combined.minX=Math.min(combined.minX,component.minX);combined.minY=Math.min(combined.minY,component.minY);
    combined.maxX=Math.max(combined.maxX,component.maxX);combined.maxY=Math.max(combined.maxY,component.maxY);
  }
  updateModelStatus('AI 正在重建选区内容…','loading');
  const result=await aiInpaintComponent(session,source,combined,w,h);
  updateModelStatus('AI 模型已就绪，图片仍在本机处理','ready');
  return result;
}

async function aiInpaintRecognized(source,maskData,w,h) {
  const template=state.detectionTemplate,selected=state.detections.filter(item=>item.selected);
  if(!template||!selected.length)throw new Error('没有可修复的识别选区');
  const components=[];
  for(const detection of selected){
    const minX=Math.max(0,Math.floor(detection.x/template.scale)),minY=Math.max(0,Math.floor(detection.y/template.scale));
    const maxX=Math.min(w-1,Math.ceil((detection.x+template.tw)/template.scale)-1),maxY=Math.min(h-1,Math.ceil((detection.y+template.th)/template.scale)-1);
    const pixels=[];let actualMinX=w,actualMinY=h,actualMaxX=-1,actualMaxY=-1;
    for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
      const index=y*w+x;if(maskData.data[index*4+3]<=20)continue;
      pixels.push(index);actualMinX=Math.min(actualMinX,x);actualMinY=Math.min(actualMinY,y);actualMaxX=Math.max(actualMaxX,x);actualMaxY=Math.max(actualMaxY,y);
    }
    if(pixels.length)components.push({pixels,minX:actualMinX,minY:actualMinY,maxX:actualMaxX,maxY:actualMaxY});
  }
  const session=await getAiSession();let result=source;
  for(let index=0;index<components.length;index++){
    updateModelStatus(`AI 正在逐处重建水印（${index+1}/${components.length}）…`,'loading');
    result=await aiInpaintComponent(session,result,components[index],w,h,12);
  }
  const clipped=new ImageData(new Uint8ClampedArray(result.data),w,h);
  for(let i=0;i<w*h;i++)if(maskData.data[i*4+3]<=20){
    clipped.data[i*4]=source.data[i*4];clipped.data[i*4+1]=source.data[i*4+1];clipped.data[i*4+2]=source.data[i*4+2];
  }
  updateModelStatus('AI 模型已就绪，图片仍在本机处理','ready');
  return clipped;
}

async function repairSelection(source,mask,w,h) {
  if(state.detections.length)return removeRecognizedWatermarks(source,mask,w,h);
  if(state.mode!=='ai')return inpaint(source,mask,w,h);
  try{return await aiInpaint(source,mask,w,h);}
  catch(error){
    updateModelStatus('AI 不可用，已自动切换轻量修复','error');
    toast('AI 组件不可用，已自动完成轻量修复');
    return inpaint(source,mask,w,h);
  }
}

els.restore.addEventListener('click',async()=>{
  if(state.processing||!state.hasMask)return;
  state.processing=true;state.restored=false;els.restore.querySelector('span').textContent=state.mode==='ai'?'正在准备 AI…':'正在快速修复…';updateUI();
  await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,20)));
  try{
    const mask=maskCtx.getImageData(0,0,els.maskCanvas.width,els.maskCanvas.height);
    state.result=await repairSelection(state.original,mask,els.imageCanvas.width,els.imageCanvas.height);
    imageCtx.putImageData(state.result,0,0);els.maskCanvas.style.opacity='0';state.restored=true;els.restore.querySelector('span').textContent='重新修复';toast(state.detections.length?'相似水印修复完成，可按住按钮对比原图':state.mode==='ai'?'AI 修复完成，可按住按钮对比原图':'快速修复完成，可按住按钮对比原图');
  }catch(error){updateModelStatus(error.message||'AI 修复失败','error');toast('AI 修复失败，请重试或切换快速填充');}
  finally{state.processing=false;updateUI();}
});
function showOriginal(show){if(!state.restored)return;imageCtx.putImageData(show?state.original:state.result,0,0);els.compare.textContent=show?'正在查看原图':'按住查看原图';}
['pointerdown','pointerenter'].forEach(t=>els.compare.addEventListener(t,e=>{if(t==='pointerenter'&&e.buttons!==1)return;showOriginal(true);}));
['pointerup','pointerleave','pointercancel'].forEach(t=>els.compare.addEventListener(t,()=>showOriginal(false)));
els.download.addEventListener('click',()=>{showOriginal(false);els.imageCanvas.toBlob(blob=>{const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`${state.fileName.replace(/\.[^.]+$/,'')}-已修复.png`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);toast('PNG 已导出');},'image/png');});

window.addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();restoreHistory(state.historyIndex+(e.shiftKey?1:-1));}
  if(!e.ctrlKey&&!e.metaKey&&e.key.toLowerCase()==='b')selectTool('brush');
  if(!e.ctrlKey&&!e.metaKey&&e.key.toLowerCase()==='e')selectTool('eraser');
  if(!e.ctrlKey&&!e.metaKey&&e.key.toLowerCase()==='d')selectTool('detect');
  if(e.key==='['){els.brushSize.value=Math.max(4,Number(els.brushSize.value)-4);els.brushSize.dispatchEvent(new Event('input'));}
  if(e.key===']'){els.brushSize.value=Math.min(160,Number(els.brushSize.value)+4);els.brushSize.dispatchEvent(new Event('input'));}
});
window.addEventListener('resize',()=>{if(state.original)fitCanvas();});
