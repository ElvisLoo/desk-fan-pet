'use strict';
/**
 * 四叶草菜单的渲染自检。
 *
 * 验证点：
 *  1. 四个叶子按钮都在，data-tool 正确
 *  2. 展开后每个叶子的位置确实散开（不是叠在中心）
 *  3. 点叶子能打开对应面板且不报错
 *  4. 面板内容随工具变化
 */
const { chromium } = require('playwright-core');
const path = require('path');

const PAGE = path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html');

/** 注入假 preload，让面板能拿到数据 */
function fakeBridge() {
  return {
    onFrame: () => {},
    onPat: () => {},
    onAlert: () => {},
    hover: () => {},
    click: () => Promise.resolve({}),
    dragStart: () => Promise.resolve({}),
    dragEnd: () => Promise.resolve({}),
    moveTo: () => {},
    state: () => Promise.resolve({}),
    setPinned: () => {},
    memoryInfo: () => Promise.resolve({
      total: 16 * 1024 ** 3, free: 3 * 1024 ** 3, used: 13 * 1024 ** 3,
      usedPct: 0.81, level: 'warn', canFree: 1.4 * 1024 ** 3,
      advice: '有点紧了，可以清一下',
      usedText: '13.0 GB', totalText: '16.0 GB', freeText: '3.00 GB',
      canFreeText: '1.40 GB',
    }),
    cleanMemory: () => Promise.resolve({ ok: true, reclaimedText: '420 MB' }),
    askAI: () => Promise.resolve({ text: '在的，风扇转着呢。', local: true }),
    pomodoroStart: () => Promise.resolve({ phase: 'focus', name: '专注', running: true, remainMs: 1500000, label: '25:00', round: 0 }),
    pomodoroPause: () => Promise.resolve({ phase: 'focus', name: '专注', running: false, remainMs: 1000000, label: '16:40', round: 0 }),
    pomodoroSkip: () => Promise.resolve({ phase: 'short', name: '短休息', running: false, remainMs: 300000, label: '05:00', round: 1 }),
    pomodoroReset: () => Promise.resolve({ phase: 'idle', name: '待开始', running: false, remainMs: 0, label: '25:00', round: 0 }),
    pomodoroState: () => Promise.resolve({ phase: 'focus', name: '专注', running: true, remainMs: 1200000, label: '20:00', round: 0 }),
    fortune: () => Promise.resolve({
      key: '2026-11-06', level: 'good', label: '稳',
      desc: '按部就班就好，别硬冲',
      action: '适合写文档', avoid: '别碰祖传代码',
      color: '雾蓝', number: 7, range: '14:00–16:00',
    }),
  };
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
  // 与主进程的 PET_W × PET_H 保持一致，否则布局比例不对
  const page = await browser.newPage({ viewport: { width: 260, height: 340 }, deviceScaleFactor: 3 });

  await page.addInitScript(`window.pet = (${fakeBridge.toString()})();`);
  await page.goto('file:///' + PAGE.split(path.sep).join('/'), { waitUntil: 'load' });
  await page.waitForTimeout(500);

  // 结构检查
  const struct = await page.evaluate(() => {
    const leaves = [...document.querySelectorAll('.leaf')];
    return {
      leafCount: leaves.length,
      tools: leaves.map((l) => l.dataset.tool),
      cloverHidden: document.getElementById('clover').hidden,
      panelHidden: document.getElementById('toolPanel').hidden,
    };
  });

  // 手动展开
  await page.evaluate(() => {
    const c = document.getElementById('clover');
    c.hidden = false;
    c.classList.add('open');
  });
  await page.waitForTimeout(420);

  // 量四个叶子的实际位置
  const pos = await page.evaluate(() => {
    const c = document.getElementById('clover').getBoundingClientRect();
    return [...document.querySelectorAll('.leaf')].map((l) => {
      const r = l.getBoundingClientRect();
      return {
        tool: l.dataset.tool,
        dx: Math.round(r.x + r.width / 2 - (c.x + c.width / 2)),
        dy: Math.round(r.y + r.height / 2 - (c.y + c.height / 2)),
        w: Math.round(r.width),
        opacity: getComputedStyle(l).opacity,
      };
    });
  });

  // 逐个打开面板
  const panels = {};
  for (const tool of ['memory', 'ai', 'pomodoro', 'fortune']) {
    await page.evaluate((t) => {
      const btn = document.querySelector(`.leaf[data-tool="${t}"]`);
      if (btn) btn.click();
    }, tool);
    await page.waitForTimeout(420);
    panels[tool] = await page.evaluate(() => {
      const body = document.getElementById('tpBody');
      return {
        title: document.getElementById('tpTitle').textContent,
        panelOpen: !document.getElementById('toolPanel').hidden,
        textLen: body.textContent.trim().length,
        preview: body.textContent.replace(/\s+/g, ' ').trim().slice(0, 60),
      };
    });
    await page.locator('#toolPanel').screenshot({ path: `.qa-panel-${tool}.png` });
  }

  // 展开状态截个图
  await page.evaluate(() => {
    // 必须同时移除 panel-open，否则 body 上的规则会把菜单透明掉
    document.body.classList.remove('panel-open');
    document.getElementById('toolPanel').hidden = true;
    const c = document.getElementById('clover');
    c.hidden = false; c.classList.add('open');
  });
  await page.waitForTimeout(350);
  await page.screenshot({ path: '.qa-clover.png' });

  console.log(JSON.stringify({ struct, pos, panels }, null, 2));
  await browser.close();
})();
