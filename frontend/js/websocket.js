/**
 * ClickMatch — WebSocket Client
 * Manages connection to Cloudflare Durable Object for real-time pixel updates
 */

const CM = window.ClickMatch || {};

// ── Config ───────────────────────────────────────────
CM.WS_URL = 'wss://clickmatch-canvas.dev/connect'; // Replace with DO endpoint

CM.wsState = {
  ws: null,
  connected: false,
  reconnectTimer: null,
  reconnectDelay: 1000,
  maxReconnectDelay: 30000,
  pingInterval: null,
  token: null,
  lastEventId: 0,
};

// ── Connect ──────────────────────────────────────────
CM.wsConnect = function (token) {
  CM.wsState.token = token;
  const url = CM.WS_URL + '?token=' + encodeURIComponent(token);

  try {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.onopen = function () {
      console.log('[ClickMatch] WebSocket connected');
      CM.wsState.connected = true;
      CM.wsState.reconnectDelay = 1000;
      CM.wsState.ws = ws;

      // Start ping
      CM.wsState.pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000);

      CM._updateConnectionStatus(true);
    };

    ws.onmessage = function (event) {
      // Text frame
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          CM._handleMessage(msg);
        } catch (e) {
          console.warn('[ClickMatch] Bad message:', event.data);
        }
        return;
      }

      // Binary frame = canvas PNG
      if (event.data instanceof ArrayBuffer) {
        const blob = new Blob([event.data], { type: 'image/png' });
        CM.loadCanvasFromBlob(blob);
      }
    };

    ws.onclose = function (e) {
      console.log('[ClickMatch] WebSocket closed:', e.code, e.reason);
      CM.wsState.connected = false;
      CM.wsState.ws = null;
      clearInterval(CM.wsState.pingInterval);
      CM._updateConnectionStatus(false);

      // Reconnect
      if (CM.wsState.reconnectDelay < CM.wsState.maxReconnectDelay) {
        CM.wsState.reconnectDelay = Math.min(
          CM.wsState.maxReconnectDelay,
          CM.wsState.reconnectDelay * 1.5
        );
      }
      CM.wsState.reconnectTimer = setTimeout(() => {
        if (CM.wsState.token) CM.wsConnect(CM.wsState.token);
      }, CM.wsState.reconnectDelay);
    };

    ws.onerror = function () {
      // onclose will fire after this
      console.warn('[ClickMatch] WebSocket error');
    };
  } catch (e) {
    console.error('[ClickMatch] WebSocket connect failed:', e);
    // Retry
    CM.wsState.reconnectTimer = setTimeout(() => {
      if (CM.wsState.token) CM.wsConnect(CM.wsState.token);
    }, 5000);
  }
};

// ── Disconnect ───────────────────────────────────────
CM.wsDisconnect = function () {
  clearTimeout(CM.wsState.reconnectTimer);
  clearInterval(CM.wsState.pingInterval);
  CM.wsState.reconnectDelay = 1000;
  if (CM.wsState.ws) {
    CM.wsState.ws.close(1000, 'User disconnect');
    CM.wsState.ws = null;
  }
  CM.wsState.connected = false;
  CM.wsState.token = null;
  CM._updateConnectionStatus(false);
};

// ── Send Click ───────────────────────────────────────
CM.sendClick = function (x, y, color) {
  if (!CM.wsState.ws || CM.wsState.ws.readyState !== WebSocket.OPEN) {
    CM._showToast('未连接到服务器');
    return;
  }
  if (CM.canvasState.frozen) {
    CM._showToast('比赛已结束');
    return;
  }

  const msg = {
    type: 'click',
    x: x,
    y: y,
    color: color,
    token: CM.wsState.token,
  };
  CM.wsState.ws.send(JSON.stringify(msg));
};

// ── Message Handler ──────────────────────────────────
CM._handleMessage = function (msg) {
  switch (msg.type) {
    case 'init':
      // expires_at and total_clicks arrive in text frame
      // Canvas binary follows as separate binary frame
      CM._onInit(msg);
      break;

    case 'pixel':
      CM.setPixel(msg.x, msg.y, msg.color);
      if (msg.id) CM.wsState.lastEventId = msg.id;
      break;

    case 'countdown':
      CM._onCountdown(msg.seconds_left);
      break;

    case 'frozen':
      CM.freeze();
      CM._onFrozen();
      break;

    case 'error':
      CM._onError(msg);
      break;

    case 'pong':
      // Nothing to do
      break;

    default:
      console.log('[ClickMatch] Unknown message type:', msg.type);
  }
};

CM._onInit = function (msg) {
  if (msg.total_clicks !== undefined) {
    CM.updateGlobalClicks(msg.total_clicks);
  }
};

CM._onCountdown = function (seconds) {
  CM.updateCountdown(seconds);
};

CM._onFrozen = function () {
  CM._showToast('比赛结束！画布已冻结');
};

CM._onError = function (msg) {
  const messages = {
    401: '登录已过期，请重新登录',
    402: '余额不足！请充值后再试',
    403: '画布已冻结，无法放置像素',
    429: '点击太快了，请稍后再试',
    400: '无效的操作',
  };
  const text = messages[msg.code] || msg.message || '未知错误';
  CM._showToast(text);
};

// ── Connection Status ────────────────────────────────
CM._updateConnectionStatus = function (connected) {
  const el = document.getElementById('connStatus');
  if (!el) return;
  if (connected) {
    el.className = 'conn-status connected';
    el.textContent = '● 已连接';
  } else {
    el.className = 'conn-status disconnected';
    el.textContent = '● 未连接';
  }
};

// ── Placeholders (called by UI module) ──────────────
CM.updateCountdown = function (seconds) {};
CM.updateGlobalClicks = function (clicks) {};
CM._showToast = function (msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2000);
};

window.ClickMatch = CM;
