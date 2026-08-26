const $ = (id) => document.getElementById(id);

const els = {
  fileInput: $('fileInput'), dropZone: $('dropZone'), intro: $('introPanel'), editor: $('editorPanel'),
  newImage: $('newImageButton'), imageCanvas: $('imageCanvas'), maskCanvas: $('maskCanvas'),
  canvasShell: $('canvasShell'), viewport: $('canvasViewport'), cursor: $('brushCursor'),
  brush: $('brushTool'), eraser: $('eraserTool'), brushSize: $('brushSize'), brushSizeValue: $('brushSizeValue'),
  undo: $('undoButton'), redo: $('redoButton'), clear: $('clearMaskButton'), restore: $('restoreButton'),
  compare: $('compareButton'), download: $('downloadButton'), coverageText: $('coverageText'),
  coverageDot: document.querySelector('.coverage-dot'), emptyInstruction: $('emptyInstruction'),
  fileName: $('fileName'), imageMeta: $('imageMeta'), zoomValue: $('zoomValue'), toast: $('toast'),
  aiMode: $('aiModeButton'), fastMode: $('fastModeButton'), modelStatus: $('modelStatus')
};

const imageCtx = els.imageCanvas.getContext('2d', { willReadFrequently: true });
const maskCtx = els.maskCanvas.getContext('2d', { willReadFrequently: true });
const state = { original: null, result: null, fileName: '', tool: 'brush', mode: 'ai', drawing: false, processing: false, last: null, zoom: 1, fitZoom: 1, history: [], historyIndex: -1, hasMask: false, restored: false };
const AI_RUNTIME_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.min.js';
const AI_WASM_PATH = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
const AI_MODEL_URL = 'https://huggingface.co/g-ronimo/lama/resolve/main/lama_512_int8.onnx';
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
  [els.brush, els.eraser].forEach(b => { const active = b === (tool === 'brush' ? els.brush : els.eraser); b.classList.toggle('active', active); b.setAttribute('aria-pressed', active); });
}
els.brush.addEventListener('click', () => selectTool('brush'));
els.eraser.addEventListener('click', () => selectTool('eraser'));
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
    state.history=[];state.historyIndex=-1;pushHistory();els.maskCanvas.style.opacity = '1';
  }
  els.maskCanvas.setPointerCapture(e.pointerId); state.drawing=true; state.last=pointFromEvent(e); renderStroke(state.last,state.last); updateUI();
});
els.maskCanvas.addEventListener('pointermove', e => {
  const r = els.canvasShell.getBoundingClientRect(); els.cursor.style.left=`${e.clientX-r.left}px`; els.cursor.style.top=`${e.clientY-r.top}px`;
  if (!state.drawing) return; const p=pointFromEvent(e); renderStroke(state.last,p); state.last=p;
});
els.maskCanvas.addEventListener('pointerenter', () => { els.cursor.style.display='block'; updateCursorSize(); });
els.maskCanvas.addEventListener('pointerleave', () => { if(!state.drawing) els.cursor.style.display='none'; });
function endStroke() { if (!state.drawing) return; state.drawing=false; pushHistory(); updateUI(); }
els.maskCanvas.addEventListener('pointerup', endStroke); els.maskCanvas.addEventListener('pointercancel', endStroke);

function maskHasPixels(data) { for(let i=3;i<data.length;i+=16) if(data[i]>20) return true; return false; }
function pushHistory() {
  const snapshot = maskCtx.getImageData(0,0,els.maskCanvas.width,els.maskCanvas.height);
  state.history = state.history.slice(0,state.historyIndex+1); state.history.push(snapshot); state.historyIndex++;
  if(state.history.length>20){state.history.shift();state.historyIndex--;} state.restored=false; state.result=null;
}
function restoreHistory(index){ if(index<0||index>=state.history.length)return; state.historyIndex=index; maskCtx.putImageData(state.history[index],0,0); state.restored=false; state.result=null; imageCtx.putImageData(state.original,0,0); updateUI(); }
els.undo.addEventListener('click',()=>restoreHistory(state.historyIndex-1)); els.redo.addEventListener('click',()=>restoreHistory(state.historyIndex+1));
els.clear.addEventListener('click',()=>{maskCtx.clearRect(0,0,els.maskCanvas.width,els.maskCanvas.height);pushHistory();updateUI();});

function updateUI(){
  const data=maskCtx.getImageData(0,0,els.maskCanvas.width,els.maskCanvas.height).data; state.hasMask=maskHasPixels(data);
  els.undo.disabled=state.historyIndex<=0; els.redo.disabled=state.historyIndex>=state.history.length-1; els.clear.disabled=!state.hasMask;
  els.restore.disabled=!state.hasMask||state.processing; els.compare.disabled=!state.restored||state.processing; els.download.disabled=!state.restored||state.processing;
  els.aiMode.disabled=state.processing; els.fastMode.disabled=state.processing;
  els.coverageText.textContent=state.hasMask?'选区已就绪':'尚未标记'; els.coverageDot.classList.toggle('ready',state.hasMask);
  els.emptyInstruction.hidden=state.hasMask;
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

async function aiInpaintComponent(session, source, component, w, h) {
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
  binaryMask=dilateMask(binaryMask,modelSize,modelSize,3);

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

els.restore.addEventListener('click',async()=>{
  if(state.processing||!state.hasMask)return;
  state.processing=true;state.restored=false;els.restore.querySelector('span').textContent=state.mode==='ai'?'正在准备 AI…':'正在快速修复…';updateUI();
  await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,20)));
  try{
    const mask=maskCtx.getImageData(0,0,els.maskCanvas.width,els.maskCanvas.height);
    state.result=state.mode==='ai'?await aiInpaint(state.original,mask,els.imageCanvas.width,els.imageCanvas.height):inpaint(state.original,mask,els.imageCanvas.width,els.imageCanvas.height);
    imageCtx.putImageData(state.result,0,0);els.maskCanvas.style.opacity='0';state.restored=true;els.restore.querySelector('span').textContent='重新修复';toast(state.mode==='ai'?'AI 修复完成，可按住按钮对比原图':'快速修复完成，可按住按钮对比原图');
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
  if(e.key==='['){els.brushSize.value=Math.max(4,Number(els.brushSize.value)-4);els.brushSize.dispatchEvent(new Event('input'));}
  if(e.key===']'){els.brushSize.value=Math.min(160,Number(els.brushSize.value)+4);els.brushSize.dispatchEvent(new Event('input'));}
});
window.addEventListener('resize',()=>{if(state.original)fitCanvas();});
