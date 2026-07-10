/**
 * ClickMatch — Canvas Engine
 * 1920×1440 pixel canvas rendered via OffscreenCanvas + ImageData
 * Supports zoom (scroll), pan (drag), and pixel placement (click)
 */

const CM = window.ClickMatch || {};

CM.CANVAS_WIDTH = 1920;
CM.CANVAS_HEIGHT = 1440;

// ── State ────────────────────────────────────────────
CM.canvasState = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  minScale: 0.05,
  maxScale: 20,
  dragging: false,
  dragStartX: 0,
  dragStartY: 0,
  dragOrigOffX: 0,
  dragOrigOffY: 0,
  selectedColor: '#FF4444',
  frozen: false,
};

// ── Init ─────────────────────────────────────────────
CM.initCanvas = function () {
  const canvas = document.getElementById('pixelCanvas');
  if (!canvas) return console.error('Canvas element not found');
  CM.el = canvas;
  CM.ctx = canvas.getContext('2d', { willReadFrequently: false });

  // Offscreen buffer for the 1920×1440 pixel grid
  CM.offscreen = new OffscreenCanvas(CM.CANVAS_WIDTH, CM.CANVAS_HEIGHT);
  CM.offCtx = CM.offscreen.getContext('2d');

  // ImageData — direct pixel manipulation (RGBA: ~11MB)
  CM.imageData = CM.offCtx.createImageData(CM.CANVAS_WIDTH, CM.CANVAS_HEIGHT);
  // Fill white
  const data = CM.imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;     // R
    data[i + 1] = 255; // G
    data[i + 2] = 255; // B
    data[i + 3] = 255; // A
  }
  CM.offCtx.putImageData(CM.imageData, 0, 0);

  // Size canvas to fit viewport
  CM._resize();

  // Set initial transform to fit entire canvas
  CM._fitToViewport();

  // Events
  canvas.addEventListener('mousedown', CM._onMouseDown);
  canvas.addEventListener('mousemove', CM._onMouseMove);
  canvas.addEventListener('mouseup', CM._onMouseUp);
  canvas.addEventListener('mouseleave', CM._onMouseUp);
  canvas.addEventListener('wheel', CM._onWheel, { passive: false });
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  // Touch events for mobile
  canvas.addEventListener('touchstart', CM._onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', CM._onTouchMove, { passive: false });
  canvas.addEventListener('touchend', CM._onTouchEnd);

  window.addEventListener('resize', CM._onResize);

  CM._draw();
};

// ── Resize ───────────────────────────────────────────
CM._resize = function () {
  const topBar = document.getElementById('topBar');
  const bottomBar = document.getElementById('bottomBar');
  const topH = topBar ? topBar.offsetHeight : 48;
  const bottomH = bottomBar ? bottomBar.offsetHeight : 56;
  const w = window.innerWidth;
  const h = window.innerHeight - topH - bottomH;

  CM.el.width = w;
  CM.el.height = h;
  CM.el.style.width = w + 'px';
  CM.el.style.height = h + 'px';
};

CM._onResize = function () {
  CM._resize();
  CM._draw();
};

CM._fitToViewport = function () {
  const { width, height } = CM.el;
  const scaleX = width / CM.CANVAS_WIDTH;
  const scaleY = height / CM.CANVAS_HEIGHT;
  const s = Math.min(scaleX, scaleY) * 0.95;

  CM.canvasState.scale = s;
  CM.canvasState.offsetX = (width - CM.CANVAS_WIDTH * s) / 2;
  CM.canvasState.offsetY = (height - CM.CANVAS_HEIGHT * s) / 2;
  CM.canvasState.minScale = s * 0.5;
};

// ── Render ───────────────────────────────────────────
CM._draw = function () {
  const { scale, offsetX, offsetY } = CM.canvasState;
  const ctx = CM.ctx;
  const w = CM.el.width;
  const h = CM.el.height;

  // Background
  ctx.fillStyle = '#0a0a15';
  ctx.fillRect(0, 0, w, h);

  // Draw pixel grid
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY);
  ctx.drawImage(CM.offscreen, 0, 0);

  // Reset transform for overlays
  ctx.setTransform(1, 0, 0, 1, 0, 0);
};

// ── Events — Mouse ───────────────────────────────────
CM._onMouseDown = function (e) {
  if (e.button === 1 || e.button === 2) {
    // Middle/right click: start pan
    CM.canvasState.dragging = true;
    CM.canvasState.dragStartX = e.clientX;
    CM.canvasState.dragStartY = e.clientY;
    CM.canvasState.dragOrigOffX = CM.canvasState.offsetX;
    CM.canvasState.dragOrigOffY = CM.canvasState.offsetY;
    CM.el.style.cursor = 'grabbing';
    return;
  }

  if (e.button === 0 && !CM.canvasState.dragging) {
    CM._handleClick(e);
  }
};

CM._onMouseMove = function (e) {
  if (!CM.canvasState.dragging) {
    // Show coordinate hover
    const pos = CM._screenToCanvas(e.clientX, e.clientY);
    CM._updateCoordsDisplay(pos);
    return;
  }

  const dx = e.clientX - CM.canvasState.dragStartX;
  const dy = e.clientY - CM.canvasState.dragStartY;
  CM.canvasState.offsetX = CM.canvasState.dragOrigOffX + dx;
  CM.canvasState.offsetY = CM.canvasState.dragOrigOffY + dy;
  CM._draw();
};

CM._onMouseUp = function () {
  if (!CM.canvasState.dragging) return;
  CM.canvasState.dragging = false;
  CM.el.style.cursor = 'crosshair';
};

CM._onWheel = function (e) {
  e.preventDefault();
  const rect = CM.el.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const state = CM.canvasState;

  // Zoom toward mouse position
  const oldScale = state.scale;
  const zoomFactor = 1 - e.deltaY * 0.001;
  let newScale = oldScale * zoomFactor;
  newScale = Math.max(state.minScale, Math.min(state.maxScale, newScale));

  // Adjust offset so that the point under the mouse stays put
  const scaleRatio = newScale / oldScale;
  state.offsetX = mx - scaleRatio * (mx - state.offsetX);
  state.offsetY = my - scaleRatio * (my - state.offsetY);
  state.scale = newScale;

  CM._draw();
  CM._updateZoomDisplay();
};

// ── Events — Touch ───────────────────────────────────
CM._onTouchStart = function (e) {
  e.preventDefault();
  if (e.touches.length === 1) {
    const t = e.touches[0];
    CM._handleClick({ clientX: t.clientX, clientY: t.clientY });
  } else if (e.touches.length === 2) {
    CM.canvasState.dragging = true;
    CM.canvasState.pinchStart = CM._pinchDistance(e.touches);
    CM.canvasState.pinchScale = CM.canvasState.scale;
    const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    CM.canvasState.pinchCX = cx;
    CM.canvasState.pinchCY = cy;
  }
};

CM._onTouchMove = function (e) {
  e.preventDefault();
  if (e.touches.length === 2 && CM.canvasState.dragging) {
    const newDist = CM._pinchDistance(e.touches);
    const ratio = newDist / CM.canvasState.pinchStart;
    let newScale = CM.canvasState.pinchScale * ratio;
    newScale = Math.max(CM.canvasState.minScale, Math.min(CM.canvasState.maxScale, newScale));
    CM.canvasState.scale = newScale;
    CM._draw();
  }
};

CM._onTouchEnd = function () {
  CM.canvasState.dragging = false;
};

CM._pinchDistance = function (touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
};

// ── Click Handling ───────────────────────────────────
CM._handleClick = function (e) {
  if (CM.canvasState.frozen) {
    CM._showToast('比赛已结束，画布已冻结');
    return;
  }

  const rect = CM.el.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const pos = CM._screenToCanvasFromOffset(cx, cy);

  if (pos.x < 0 || pos.x >= CM.CANVAS_WIDTH || pos.y < 0 || pos.y >= CM.CANVAS_HEIGHT) return;

  // Send via WebSocket
  if (CM.sendClick) {
    CM.sendClick(pos.x, pos.y, CM.canvasState.selectedColor);
    CM._flashPixel(pos.x, pos.y, CM.canvasState.selectedColor);
  }
};

CM._screenToCanvas = function (clientX, clientY) {
  const rect = CM.el.getBoundingClientRect();
  return CM._screenToCanvasFromOffset(clientX - rect.left, clientY - rect.top);
};

CM._screenToCanvasFromOffset = function (cx, cy) {
  const { scale, offsetX, offsetY } = CM.canvasState;
  return {
    x: Math.floor((cx - offsetX) / scale),
    y: Math.floor((cy - offsetY) / scale),
  };
};

// ── Pixel Operations ─────────────────────────────────
/**
 * Set a single pixel in the ImageData.
 * Called when receiving a 'pixel' message from WebSocket.
 */
CM.setPixel = function (x, y, colorHex) {
  if (x < 0 || x >= CM.CANVAS_WIDTH || y < 0 || y >= CM.CANVAS_HEIGHT) return;

  const r = parseInt(colorHex.slice(1, 3), 16);
  const g = parseInt(colorHex.slice(3, 5), 16);
  const b = parseInt(colorHex.slice(5, 7), 16);
  const idx = (y * CM.CANVAS_WIDTH + x) * 4;
  CM.imageData.data[idx] = r;
  CM.imageData.data[idx + 1] = g;
  CM.imageData.data[idx + 2] = b;
  CM.imageData.data[idx + 3] = 255;

  // Update offscreen and redraw
  CM.offCtx.putImageData(CM.imageData, 0, 0);
  CM._draw();
};

/**
 * Load full canvas from binary (PNG from server).
 * Called on 'init' message.
 */
CM.loadCanvasFromBlob = function (blob) {
  const img = new Image();
  img.onload = function () {
    CM.offCtx.drawImage(img, 0, 0);
    // Re-extract ImageData for pixel-level ops
    CM.imageData = CM.offCtx.getImageData(0, 0, CM.CANVAS_WIDTH, CM.CANVAS_HEIGHT);
    CM._draw();
  };
  img.src = URL.createObjectURL(blob);
};

// Flash a pixel on the canvas (client-side feedback before server confirms)
CM._flashPixel = function (x, y, colorHex) {
  const { scale, offsetX, offsetY } = CM.canvasState;
  const ctx = CM.ctx;

  const sx = x * scale + offsetX;
  const sy = y * scale + offsetY;
  const ps = Math.max(scale, 1);

  ctx.fillStyle = colorHex;
  ctx.fillRect(sx, sy, ps, ps);

  // Fade after 150ms
  setTimeout(() => {
    CM._draw();
  }, 150);
};

// ── HUD ──────────────────────────────────────────────
CM._updateCoordsDisplay = function (pos) {
  const el = document.getElementById('coordDisplay');
  if (!el) return;
  if (pos && pos.x >= 0 && pos.x < CM.CANVAS_WIDTH && pos.y >= 0 && pos.y < CM.CANVAS_HEIGHT) {
    el.textContent = `(${pos.x}, ${pos.y})`;
  } else {
    el.textContent = '';
  }
};

CM._updateZoomDisplay = function () {
  const el = document.getElementById('zoomDisplay');
  if (!el) return;
  el.textContent = Math.round(CM.canvasState.scale * 100) + '%';
};

CM._showToast = function (msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2000);
};

// ── Freeze ───────────────────────────────────────────
CM.freeze = function () {
  CM.canvasState.frozen = true;
  CM.el.style.cursor = 'default';
};

CM.unfreeze = function () {
  CM.canvasState.frozen = false;
  CM.el.style.cursor = 'crosshair';
};

window.ClickMatch = CM;
