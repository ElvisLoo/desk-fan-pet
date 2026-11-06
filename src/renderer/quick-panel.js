'use strict';
/**
 * quick-panel.js — 四叶草菜单与四个小面板的渲染层
 *
 * 职责边界：
 *   - 这里只做「画与交互」，所有算法在 quick-tools.js（可单测）
 *   - 需要 Node 能力的地方（读内存、请求 API）走 window.pet.*，由主进程实现
 *
 * 关键时序：
 *   菜单展开时告诉主进程 pinned=true，贴边收起逻辑就不会在鼠标
 *   移向菜单的路途中把窗口收回去（否则菜单点不到）。
 */

(function () {
  const clover = document.getElementById('clover');
  const panel = document.getElementById('toolPanel');
  const tpTitle = document.getElementById('tpTitle');
  const tpBody = document.getElementById('tpBody');
  const tpClose = document.getElementById('tpClose');
  if (!clover || !panel) return;

  let currentTool = null;     // 'memory' | 'ai' | 'pomodoro' | 'fortune'
  let menuOpen = false;
  let openTimer = 0;
  let closeTimer = 0;

  // 番茄钟实例（跨面板复用，关掉面板也不停）
  const pomo = {
    phase: 'idle', running: false, remainMs: 0, round: 0,
    label: '25:00',
  };
  let pomoTimer = 0;

  const api = window.pet || {};

  /* ---------------- 菜单展开 / 收起 ---------------- */

  function openMenu() {
    clearTimeout(closeTimer);
    if (menuOpen) return;
    menuOpen = true;
    clover.hidden = false;
    // 下一帧再加 open 类，让 transition 生效
    requestAnimationFrame(() => clover.classList.add('open'));
    // 钉住：告诉主进程别把窗口收回去
    if (api.setPinned) api.setPinned(true);
  }

  function closeMenu(force) {
    if (!menuOpen) return;
    // 面板开着时不收菜单，避免点进面板后菜单消失
    if (!force && panel && !panel.hidden) return;
    menuOpen = false;
    clover.classList.remove('open');
    closeTimer = setTimeout(() => {
      if (!menuOpen) clover.hidden = true;
    }, 280);
    if (api.setPinned) api.setPinned(false);
  }

  function scheduleClose() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => closeMenu(false), 260);
  }

  // 鼠标进出宠物区域：延迟展开，避免只是路过就弹菜单
  document.addEventListener('mouseenter', () => {
    clearTimeout(openTimer);
    openTimer = setTimeout(openMenu, 420);
  });

  document.addEventListener('mouseleave', () => {
    clearTimeout(openTimer);
    scheduleClose();
  });

  clover.addEventListener('mouseenter', () => clearTimeout(closeTimer));
  clover.addEventListener('mouseleave', scheduleClose);

  /* ---------------- 面板开关 ---------------- */

  function openTool(tool) {
    currentTool = tool;
    panel.hidden = false;
    document.body.classList.add('panel-open');
    tpBody.innerHTML = '';
    if (api.setPinned) api.setPinned(true);

    if (tool === 'memory') renderMemory();
    else if (tool === 'ai') renderAI();
    else if (tool === 'pomodoro') renderPomodoro();
    else if (tool === 'fortune') renderFortune();
  }

  function closeTool() {
    currentTool = null;
    panel.hidden = true;
    // 无论从哪条路径关闭（按钮 / 切换工具 / 异常），都要清掉这个类，
    // 否则菜单会一直是 opacity:0，看起来像「四叶草不出现」
    document.body.classList.remove('panel-open');
    tpBody.innerHTML = '';
    if (pomoTimer) { clearInterval(pomoTimer); pomoTimer = 0; }
    if (api.setPinned) api.setPinned(false);
  }

  tpClose.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTool();
  });

  clover.addEventListener('click', (e) => {
    const btn = e.target.closest('.leaf');
    if (!btn) return;
    e.stopPropagation();
    const tool = btn.dataset.tool;
    if (currentTool === tool && !panel.hidden) { closeTool(); return; }
    openTool(tool);
  });

  /* ---------------- ① 内存 ---------------- */

  async function renderMemory() {
    tpTitle.textContent = '内存';
    tpBody.innerHTML = '<div class="mem-tip">正在读取…</div>';

    let info;
    try {
      info = await api.memoryInfo();
    } catch (_) {
      info = null;
    }
    if (!info || !info.total) {
      tpBody.innerHTML = '<div class="mem-tip">读不到内存信息。</div>';
      return;
    }

    const pct = Math.round(info.usedPct * 100);
    const cls = info.level === 'high' ? 'high' : info.level === 'warn' ? 'warn' : '';
    const freeTxt = info.canFree > 0 ? '估计可回收 ' + info.canFreeText : '';

    tpBody.innerHTML =
      '<div class="mem-row">' +
        '<span class="mem-used"><em>已用</em>' +
          '<b>' + esc(splitSize(info.usedText).num) + '</b>' +
          '<i>' + esc(splitSize(info.usedText).unit) + '</i>' +
        '</span>' +
        '<span class="mem-pct">共 ' + esc(info.totalText) + ' · ' + pct + '%</span>' +
      '</div>' +
      '<div class="mem-bar ' + cls + '"><i style="width:' + pct + '%"></i></div>' +
      '<div class="mem-tip">' + esc(info.advice) + (freeTxt ? ' · ' + esc(freeTxt) : '') + '</div>' +
      '<div class="mem-actions">' +
        '<button class="mem-btn primary" id="memClean"' + (info.canFree > 0 ? '' : ' disabled') + '>清理</button>' +
        '<button class="mem-btn" id="memRefresh">刷新</button>' +
      '</div>';

    const cleanBtn = document.getElementById('memClean');
    const refreshBtn = document.getElementById('memRefresh');
    if (refreshBtn) refreshBtn.onclick = () => renderMemory();
    if (cleanBtn) {
      cleanBtn.onclick = async () => {
        cleanBtn.disabled = true;
        cleanBtn.textContent = '清理中…';
        let r = null;
        try { r = await api.cleanMemory(); } catch (_) {}
        if (r && r.ok) {
          cleanBtn.textContent = r.reclaimedText ? '释放 ' + r.reclaimedText : '已清理';
          setTimeout(() => renderMemory(), 900);
        } else {
          cleanBtn.textContent = '清理失败';
          cleanBtn.disabled = false;
        }
      };
    }
  }

  /* ---------------- ② AI 小助手 ---------------- */

  const aiHistory = [];

  function renderAI() {
    tpTitle.textContent = '问问它';
    tpBody.innerHTML =
      '<div class="ai-log" id="aiLog"></div>' +
      '<div class="ai-input-row">' +
        '<input class="ai-input" id="aiInput" placeholder="说点什么…" maxlength="200">' +
        '<button class="ai-send" id="aiSend">发送</button>' +
      '</div>';

    const log = document.getElementById('aiLog');
    const input = document.getElementById('aiInput');
    const send = document.getElementById('aiSend');

    if (!aiHistory.length) {
      addMsg('hint', '没配模型也能聊几句家常。');
    } else {
      aiHistory.forEach((h) => addMsg(h.role, h.text, true));
    }

    function addMsg(role, text, replay) {
      const div = document.createElement('div');
      div.className = 'ai-msg ' + (role === 'user' ? 'user' : role === 'bot' ? 'bot' : 'hint');
      div.textContent = text;
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
      if (!replay) aiHistory.push({ role: role === 'bot' ? 'assistant' : 'user', text });
      return div;
    }

    async function submit() {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      addMsg('user', text);
      send.disabled = true;

      const thinking = addMsg('bot', '…');
      let reply = '';
      try {
        const r = await api.askAI(text, aiHistory.slice(-10));
        reply = (r && r.text) || '';
      } catch (_) {
        reply = '';
      }
      thinking.textContent = reply || '没连上模型。设置里填个 API 地址就行。';
      if (reply) aiHistory.push({ role: 'assistant', text: reply });
      else aiHistory.pop();   // 失败的不入历史，避免下一轮带上空回复
      send.disabled = false;
      input.focus();
    }

    send.onclick = submit;
    input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
    setTimeout(() => input.focus(), 60);
  }

  /* ---------------- ③ 番茄钟 ---------------- */

  function renderPomodoro() {
    tpTitle.textContent = '番茄钟';

    tpBody.innerHTML =
      '<div class="pomo-phase" id="pomoPhase">' + esc(pomo.name || '待开始') + '</div>' +
      '<div class="pomo-time" id="pomoTime">' + esc(pomo.label) + '</div>' +
      '<div class="pomo-round" id="pomoRound">已完成 ' + (pomo.round || 0) + ' 轮</div>' +
      '<div class="pomo-actions">' +
        '<button class="mem-btn primary" id="pomoToggle">' + (pomo.running ? '暂停' : '开始') + '</button>' +
        '<button class="mem-btn" id="pomoSkip">跳过</button>' +
        '<button class="mem-btn" id="pomoReset">重置</button>' +
      '</div>';

    const timeEl = document.getElementById('pomoTime');
    const phaseEl = document.getElementById('pomoPhase');
    const roundEl = document.getElementById('pomoRound');
    const toggleEl = document.getElementById('pomoToggle');

    function paint(s) {
      Object.assign(pomo, s);
      if (timeEl) timeEl.textContent = s.label;
      if (phaseEl) phaseEl.textContent = s.name;
      if (roundEl) roundEl.textContent = '已完成 ' + s.round + ' 轮';
      if (toggleEl) toggleEl.textContent = s.running ? '暂停' : '开始';
      updateBadge(s);
    }

    async function sync() {
      try {
        const s = await api.pomodoroState();
        if (s) paint(s);
      } catch (_) {}
    }

    toggleEl.onclick = async () => {
      try {
        const s = pomo.running ? await api.pomodoroPause() : await api.pomodoroStart();
        if (s) paint(s);
      } catch (_) {}
    };
    document.getElementById('pomoSkip').onclick = async () => {
      try { const s = await api.pomodoroSkip(); if (s) paint(s); } catch (_) {}
    };
    document.getElementById('pomoReset').onclick = async () => {
      try { const s = await api.pomodoroReset(); if (s) paint(s); } catch (_) {}
    };

    sync();
    if (pomoTimer) clearInterval(pomoTimer);
    pomoTimer = setInterval(sync, 1000);
  }

  /** 番茄钟运行时，在四叶草下方显示剩余时间 */
  function updateBadge(s) {
    let badge = clover.querySelector('.clover-badge');
    if (s && s.running) {
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'clover-badge';
        clover.appendChild(badge);
      }
      badge.textContent = s.label;
      badge.classList.add('show');
    } else if (badge) {
      badge.classList.remove('show');
    }
  }

  /* ---------------- ④ 今日运势 ---------------- */

  async function renderFortune() {
    tpTitle.textContent = '今日运势';
    let f = null;
    try { f = await api.fortune(); } catch (_) {}
    if (!f) {
      tpBody.innerHTML = '<div class="mem-tip">运势算不出来，稍后再试。</div>';
      return;
    }

    tpBody.innerHTML =
      '<div class="fortune-level">' +
        '<div class="fortune-seal">' + esc(f.label) + '</div>' +
        '<div class="fortune-desc">' + esc(f.desc) + '</div>' +
      '</div>' +
      '<div class="fortune-items">' +
        '<div class="fortune-item"><b>宜</b><span class="fortune-yi">' + esc(f.action) + '</span></div>' +
        '<div class="fortune-item"><b>忌</b><span class="fortune-ji">' + esc(f.avoid) + '</span></div>' +
        '<div class="fortune-item"><b>幸运色</b><span>' + esc(f.color) + '</span></div>' +
        '<div class="fortune-item"><b>数字</b><span>' + f.number + '</span></div>' +
        '<div class="fortune-item"><b>时段</b><span>' + esc(f.range) + '</span></div>' +
      '</div>';
  }

  /* ---------------- 工具 ---------------- */

  /** "13.0 GB" -> { num: '13.0', unit: 'GB' } */
  function splitSize(text) {
    const m = /^([\d.]+)\s*(.*)$/.exec(String(text || '').trim());
    return m ? { num: m[1], unit: m[2] } : { num: String(text || ''), unit: '' };
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // 主进程推来的状态里若带番茄钟进度，顺手更新角标
  if (api.onFrame) {
    api.onFrame((s) => {
      if (s && s.pomodoro) updateBadge(s.pomodoro);
    });
  }
})();
