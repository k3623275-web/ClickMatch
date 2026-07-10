/**
 * ClickMatch — UI Controller
 * Auth modal, countdown timer, leaderboard panel, phase tease cards
 */

const CM = window.ClickMatch || {};

// ── Auth State ───────────────────────────────────────
CM.authState = {
  user: null,
  token: null,
};

// ── Competition State ────────────────────────────────
CM.compState = {
  endsAt: null,
  phase: 1,
  totalClicks: 0,
  onlinePlayers: 0,
};

// ── Init ─────────────────────────────────────────────
CM.initUI = function () {
  CM._bindAuthButtons();
  CM._bindCountdown();
  CM._bindLeaderboard();
  CM._bindColorPicker();
  CM._renderPhaseCards();
  CM._checkStoredAuth();
};

// ── Auth ─────────────────────────────────────────────
CM._bindAuthButtons = function () {
  document.getElementById('loginBtn').addEventListener('click', () => CM._showAuthModal('login'));
  document.getElementById('registerBtn').addEventListener('click', () => CM._showAuthModal('register'));
  document.getElementById('authClose').addEventListener('click', () => CM._hideAuthModal());
  document.getElementById('authSubmit').addEventListener('click', CM._handleAuth);
};

CM._checkStoredAuth = function () {
  try {
    const stored = localStorage.getItem('clickmatch_auth');
    if (stored) {
      const data = JSON.parse(stored);
      if (data.token && data.user) {
        CM.authState.user = data.user;
        CM.authState.token = data.token;
        CM._updateUserUI();
        CM.wsConnect(data.token);
      }
    }
  } catch (e) {
    localStorage.removeItem('clickmatch_auth');
  }
};

CM._showAuthModal = function (mode) {
  const modal = document.getElementById('authModal');
  const title = document.getElementById('authTitle');
  const submit = document.getElementById('authSubmit');
  modal.style.display = 'flex';
  document.getElementById('authEmail').value = '';
  document.getElementById('authPassword').value = '';
  CM._authMode = mode;

  if (mode === 'login') {
    title.textContent = '登录';
    submit.textContent = '登录';
  } else {
    title.textContent = '注册';
    submit.textContent = '注册';
  }
};

CM._hideAuthModal = function () {
  document.getElementById('authModal').style.display = 'none';
};

CM._handleAuth = async function () {
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;

  if (!email || !password) {
    CM._flashError('请填写邮箱和密码');
    return;
  }
  if (password.length < 8) {
    CM._flashError('密码至少 8 个字符');
    return;
  }

  const endpoint = CM._authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
  const btn = document.getElementById('authSubmit');
  btn.disabled = true;
  btn.textContent = '处理中...';

  try {
    // In demo mode: use mock API if no backend
    if (CM.API_BASE === 'https://api.clickmatch.io') {
      // Real API
      const resp = await fetch(CM.API_BASE + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || '认证失败');
      CM._onAuthSuccess(data);
    } else {
      // Demo/mock mode
      CM._mockAuth(email);
    }
  } catch (e) {
    CM._flashError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = CM._authMode === 'login' ? '登录' : '注册';
  }
};

CM._mockAuth = function (email) {
  const user = {
    id: 'demo-' + Date.now(),
    email: email,
    balance: 500,
    total_clicks: 0,
  };
  const data = { user, token: 'demo-jwt-' + Date.now() };
  CM._onAuthSuccess(data);
};

CM._onAuthSuccess = function (data) {
  CM.authState.user = data.user;
  CM.authState.token = data.token;
  localStorage.setItem('clickmatch_auth', JSON.stringify({ user: data.user, token: data.token }));
  CM._updateUserUI();
  CM._hideAuthModal();
  CM.wsConnect(data.token);
};

CM._updateUserUI = function () {
  const user = CM.authState.user;
  if (!user) return;

  document.getElementById('loginBtn').style.display = 'none';
  document.getElementById('registerBtn').style.display = 'none';
  document.getElementById('userInfo').style.display = 'flex';

  document.getElementById('userName').textContent = user.email.split('@')[0];
  document.getElementById('userBalance').textContent = user.balance;
};

CM._flashError = function (msg) {
  const el = document.getElementById('authError');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
};

// ── Countdown Timer ──────────────────────────────────
CM._bindCountdown = function () {
  CM.countdownEl = document.getElementById('countdown');
};

CM.updateCountdown = function (seconds) {
  CM.compState.endsAt = Date.now() + seconds * 1000;
  CM._tickCountdown();
  if (CM._countdownInterval) clearInterval(CM._countdownInterval);
  CM._countdownInterval = setInterval(CM._tickCountdown, 1000);
};

CM._tickCountdown = function () {
  if (!CM.compState.endsAt) return;
  const remaining = Math.max(0, Math.floor((CM.compState.endsAt - Date.now()) / 1000));

  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;

  CM.countdownEl.textContent =
    String(h).padStart(2, '0') + ':' +
    String(m).padStart(2, '0') + ':' +
    String(s).padStart(2, '0');

  if (remaining <= 0) {
    clearInterval(CM._countdownInterval);
    CM.countdownEl.textContent = '00:00:00';
    CM.countdownEl.classList.add('expired');
  }
};

CM.updateGlobalClicks = function (clicks) {
  CM.compState.totalClicks = clicks;
  const el = document.getElementById('globalClicks');
  if (el) el.textContent = clicks.toLocaleString();
};

// ── Leaderboard ──────────────────────────────────────
CM._bindLeaderboard = function () {
  document.getElementById('lbToggle').addEventListener('click', () => {
    CM._toggleLeaderboard();
    CM._fetchLeaderboard();
  });
  document.getElementById('lbClose').addEventListener('click', () => CM._toggleLeaderboard());
};

CM._toggleLeaderboard = function () {
  const panel = document.getElementById('lbPanel');
  panel.classList.toggle('open');
};

CM._fetchLeaderboard = async function () {
  const list = document.getElementById('lbList');
  list.innerHTML = '<div class="lb-loading">加载中...</div>';

  try {
    // Demo: mock leaderboard
    const rankings = CM._mockLeaderboard();
    CM._renderLeaderboard(rankings);
  } catch (e) {
    list.innerHTML = '<div class="lb-loading">加载失败</div>';
  }
};

CM._mockLeaderboard = function () {
  const names = ['PixelKing', 'ColorQueen', 'GridMaster', 'DotLord', 'ArtWarrior',
    'CanvasHero', 'BytePainter', 'PixelPusher', 'DotCom', 'MosaicMind'];
  const rankings = [];
  for (let i = 1; i <= 50; i++) {
    rankings.push({
      rank: i,
      name: names[i % names.length] + (i > 10 ? i : ''),
      clicks: Math.floor(Math.random() * 50000) + 5000,
    });
  }
  rankings.sort((a, b) => b.clicks - a.clicks);
  rankings.forEach((r, i) => r.rank = i + 1);
  return rankings;
};

CM._renderLeaderboard = function (rankings) {
  const list = document.getElementById('lbList');
  let html = '';
  rankings.forEach(r => {
    const rankClass = r.rank <= 3 ? ' top' + r.rank : '';
    html += '<div class="lb-row' + rankClass + '">' +
      '<span class="lb-rank">' + r.rank + '</span>' +
      '<span class="lb-name">' + r.name + '</span>' +
      '<span class="lb-clicks">' + r.clicks.toLocaleString() + '</span>' +
      '</div>';
  });
  list.innerHTML = html;
};

// ── Color Picker ─────────────────────────────────────
CM._bindColorPicker = function () {
  const swatches = document.querySelectorAll('.cp-swatch');
  swatches.forEach(sw => {
    sw.addEventListener('click', function () {
      CM.canvasState.selectedColor = this.dataset.color;

      // Update active visual
      swatches.forEach(s => s.classList.remove('active'));
      this.classList.add('active');

      // Glow effect
      this.style.boxShadow = '0 0 12px ' + this.dataset.color;
      setTimeout(() => {
        this.style.boxShadow = '';
      }, 300);
    });
  });

  // Default first active
  if (swatches.length > 0) swatches[0].classList.add('active');
};

// ── Phase Cards ──────────────────────────────────────
CM._renderPhaseCards = function () {
  const container = document.getElementById('phaseCards');
  if (!container) return;

  const phases = [
    { num: 2, title: '阵营战', sub: '选择阵营，与队友协同占领像素领土', icon: '⚔️' },
    { num: 3, title: '灰度世界', sub: '颜色消失——只剩黑白与无限可能性', icon: '🌑' },
    { num: 4, title: '最终章', sub: '未知规则，终极对决，仅限最强者', icon: '👑' }
  ];

  container.innerHTML = phases.map(p => (
    '<div class="phase-card locked">' +
    '<div class="phase-card-icon">' + p.icon + '</div>' +
    '<div class="phase-card-num">Phase ' + p.num + '</div>' +
    '<div class="phase-card-title">' + p.title + '</div>' +
    '<div class="phase-card-sub">' + p.sub + '</div>' +
    '<div class="phase-card-lock">🔒 即将解锁</div>' +
    '</div>'
  )).join('');
};

// ── Toast ────────────────────────────────────────────
CM._showToast = function (msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(CM._toastTimer);
  CM._toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
};

// ── Demo Mode ────────────────────────────────────────
CM.API_BASE = 'https://api.clickmatch.io'; // Change for local dev

window.ClickMatch = CM;
