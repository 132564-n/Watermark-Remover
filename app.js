const $ = (id) => document.getElementById(id);

const els = {
  fileInput: $('fileInput'), dropZone: $('dropZone'), intro: $('introPanel'), editor: $('editorPanel'),
  newImage: $('newImageButton'), imageCanvas: $('imageCanvas'), maskCanvas: $('maskCanvas'),
  canvasShell: $('canvasShell'), viewport: $('canvasViewport'), cursor: $('brushCursor'),
  brush: $('brushTool'), eraser: $('eraserTool'), brushSize: $('brushSize'), brushSizeValue: $('brushSizeValue'),
  undo: $('undoButton'), redo: $('redoButton'), clear: $('clearMaskButton'), restore: $('restoreButton'),
  compare: $('compareButton'), download: $('downloadButton'), coverageText: $('coverageText'),
  coverageDot: document.querySelector('.coverage-dot'), emptyInstruction: $('emptyInstruction'),
  fileName: $('fileName'), imageMeta: $('imageMeta'), zoomValue: $('zoomValue'), toast: $('toast')
};

const imageCtx = els.imageCanvas.getContext('2d', { willReadFrequently: true });
const maskCtx = els.maskCanvas.getContext('2d', { willReadFrequently: true });
const state = { original: null, result: null, fileName: '', tool: 'brush', drawing: false, last: null, zoom: 1, fitZoom: 1, history: [], historyIndex: -1, hasMask: false, restored: false };

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
    state.restored = false; state.result = null;
    imageCtx.putImageData(state.original, 0, 0); els.maskCanvas.style.opacity = '1';
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
  els.restore.disabled=!state.hasMask; els.compare.disabled=!state.restored; els.download.disabled=!state.restored;
  els.coverageText.textContent=state.hasMask?'选区已就绪':'尚未标记'; els.coverageDot.classList.toggle('ready',state.hasMask);
  els.emptyInstruction.hidden=state.hasMask; if(!state.restored) { els.maskCanvas.style.opacity='1'; els.restore.querySelector('span').textContent='开始修复'; }
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

els.restore.addEventListener('click',()=>{
  els.restore.disabled=true; els.restore.querySelector('span').textContent='正在修复…';
  setTimeout(()=>{
    const mask=maskCtx.getImageData(0,0,els.maskCanvas.width,els.maskCanvas.height);
    state.result=inpaint(state.original,mask,els.imageCanvas.width,els.imageCanvas.height); imageCtx.putImageData(state.result,0,0);
    els.maskCanvas.style.opacity='0';state.restored=true;els.restore.querySelector('span').textContent='重新修复';updateUI();toast('修复完成，可按住按钮对比原图');
  },30);
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
