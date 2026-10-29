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

/** 主进程每帧推状态过来 */
window.pet.onFrame((s) => {
  if (!s) return;
  petEl.dataset.state = s.state;
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

function showBubble(text) {
  bubble.textContent = text;
  bubble.hidden = false;
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => { bubble.hidden = true; }, 1600);
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
