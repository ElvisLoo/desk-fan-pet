'use strict';
/**
 * 宠物窗口的渲染层：只负责显示与交互事件转发，不含业务逻辑。
 * 状态由主进程的 PetBrain 决定，这里拿到什么就画什么。
 */
const $ = (id) => document.getElementById(id);
const petEl = $('pet');
const bubble = $('bubble');
const zzz = $('zzz');

let dragging = false;
let dragOffset = { x: 0, y: 0 };
let bubbleTimer = 0;

let lastReminderKey = '';
let modeBadge = null;

/** 主进程每帧推状态过来 */
window.pet.onFrame((s) => {
  if (!s) return;
  petEl.dataset.state = s.state;

  // 扇叶转速跟随 CPU 负载（主进程已平滑，这里直接映射到动画时长）
  const blades = document.getElementById('blades');
  if (blades && typeof s.spin === 'number') {
    // spin 0..1 → 1.9s 到 0.35s
    const dur = (1.9 - s.spin * 1.55).toFixed(2);
    blades.style.animationDuration = dur + 's';
  }

  // 番茄钟 / 休息：角落小徽标显示剩余分钟
  updateModeBadge(s);

  // 提醒：同一类只弹一次，避免每帧重刷
  if (s.reminder) {
    const key = s.reminder.kind + ':' + s.reminder.until;
    if (key !== lastReminderKey) {
      lastReminderKey = key;
      showBubble(REMINDER_TEXT[s.reminder.kind] || '看这里～', 6000);
    }
  } else {
    lastReminderKey = '';
  }
  // 朝向：翻转整个身体
  document.body.style.transform = s.facing < 0 ? 'scaleX(-1)' : '';
  // 睡觉时显示 Z
  zzz.hidden = s.state !== 'sleep';
  // 心情影响嘴巴：开心时上扬更明显
  const mouth = document.querySelector('.mouth');
  if (mouth) {
    mouth.style.height = s.mood >= 80 ? '4px' : s.mood >= 50 ? '3px' : '2px';
  }
});

/** 摸一下：出个气泡 */
window.pet.onPat(() => {
  const words = ['呼～', '嘿嘿', '好凉快', '再摸一下', '转起来！', '我也在努力'];
  showBubble(words[Math.floor(Math.random() * words.length)]);
});

const REMINDER_TEXT = {
  sip: '喝口水吧 💧',
  'focus-done': '专注完成，休息一下 ☕',
  'break-done': '休息结束，继续？',
};

function showBubble(text, ms = 1600) {
  bubble.textContent = text;
  bubble.hidden = false;
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => { bubble.hidden = true; }, ms);
}

/** 专注/休息的剩余时间徽标 */
function updateModeBadge(s) {
  if (!modeBadge) {
    modeBadge = document.createElement('div');
    modeBadge.className = 'mode-badge';
    modeBadge.hidden = true;
    document.querySelector('.pet').appendChild(modeBadge);
  }
  if (!s.mode || s.mode === 'free' || !s.remainingMs) {
    modeBadge.hidden = true;
    return;
  }
  const mins = Math.ceil(s.remainingMs / 60000);
  modeBadge.textContent = (s.mode === 'focus' ? '⏱ ' : '☕ ') + mins + '′';
  modeBadge.dataset.mode = s.mode;
  modeBadge.hidden = false;
}

// ---- 悬停：接管鼠标（否则点不到它）----
let hoverTimer = 0;
document.body.addEventListener('mouseenter', () => {
  clearTimeout(hoverTimer);
  window.pet.hover(true);
});
document.body.addEventListener('mouseleave', () => {
  // 延迟放开，避免在边缘抖动时鼠标事件闪烁
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => window.pet.hover(false), 260);
});

// ---- 点击 ----
document.body.addEventListener('click', async () => {
  if (dragging) return;
  await window.pet.click();
  showBubble(['呼～', '嘿嘿', '好凉快'][Math.floor(Math.random() * 3)]);
});

// ---- 拖拽 ----
document.body.addEventListener('mousedown', async (e) => {
  if (e.button !== 0) return;
  dragging = true;
  dragOffset = { x: e.screenX - window.screenX, y: e.screenY - window.screenY };
  document.body.classList.add('dragging');
  await window.pet.dragStart();
});

document.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  window.pet.moveTo(e.screenX - dragOffset.x, e.screenY - dragOffset.y);
});

document.addEventListener('mouseup', async (e) => {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove('dragging');
  await window.pet.dragEnd({ x: e.screenX - dragOffset.x, y: e.screenY - dragOffset.y });
});

// 防止拖拽时选中文字 / 触发原生拖影
document.addEventListener('dragstart', (e) => e.preventDefault());
window.addEventListener('contextmenu', (e) => { e.preventDefault(); });
