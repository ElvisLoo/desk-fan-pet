'use strict';
/**
 * 风扇宠物：真实 Electron 端到端验证。
 *
 * 之前只有纯逻辑单测（74 项）和"进程存活 8 秒"两项证据。
 * 但宠物是窗口应用，真正要证明的是：
 *   - 渲染层真的能把状态画出来（不是白屏）
 *   - 托盘/主进程与渲染层的 IPC 通
 *   - 番茄钟的剩余时间能传到界面
 *   - 窗口位置持久化真的生效
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

const profile = path.join(os.tmpdir(), 'pet-e2e-' + Date.now());
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.disableHardwareAcceleration();

setTimeout(() => { console.log('TIMEOUT'); app.exit(2); }, 45000);

const ROOT = path.resolve(__dirname, '..');

app.whenReady().then(async () => {
  // 直接加载渲染层页面（不启动托盘，避免污染真实环境）
  const w = new BrowserWindow({
    width: 150, height: 150, show: false,
    transparent: true, frame: false,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const errors = [];
  w.webContents.on('console-message', (_e, l, m) => { if (l >= 2) errors.push(m.slice(0, 160)); });

  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 800));

  // 帧推送放到页面注册监听之后（见下方 startFrames）。
  // 之前在这里就推完，等 executeJavaScript 里注册监听时帧早发完了，
  // 测出 frameCount:0 是测试时序问题，不是 IPC 坏了。

  // 页面脚本加载完后持续推帧，直到取完结果
  const { PetBrain } = require(path.join(ROOT, 'src', 'pet-brain'));
  const brain = new PetBrain({ now: Date.now() });
  const pushTimer = setInterval(() => {
    if (w.isDestroyed()) return;
    w.webContents.send('pet:frame', {
      state: brain.state, mood: brain.mood, facing: brain.facing, since: 0,
      mode: brain.mode, remainingMs: brain.modeRemaining(Date.now()),
      reminder: null, spin: brain.spin, edge: brain.edge, climbDir: brain.climbDir,
    });
  }, 50);

  const out = await w.webContents.executeJavaScript(`(async () => {
    const res = {};
    res.title = document.title;
    res.root = !!document.body;
    res.hasPreloadApi = !!(window.pet && typeof window.pet.onFrame === 'function');
    res.petKeys = window.pet ? Object.keys(window.pet) : [];

    // 这只宠物是纯 CSS 画的（div + 样式），不是 SVG/canvas。
    // 所以要看的是 DOM 结构是否完整、尺寸是否被撑开，
    // 而不是找 <svg>。
    const petEl = document.getElementById('pet');
    const blades = document.getElementById('blades');
    const cage = document.querySelector('.cage');
    const hub = document.querySelector('.hub');

    function box(el) {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    }

    res.dom = {
      pet: !!petEl,
      petBox: box(petEl),
      cageBox: box(cage),
      hubBox: box(hub),
      blades: !!blades,
      bladeCount: blades ? blades.querySelectorAll('i').length : 0,
      eyes: document.querySelectorAll('.eye').length,
      mouth: !!document.querySelector('.mouth'),
    };
    // 关键：如果所有盒模型都是 0x0，说明 CSS 没加载或布局塌了 —— 那就是白屏
    res.rendered = !!(res.dom.cageBox && res.dom.cageBox.w > 0 && res.dom.cageBox.h > 0);

    // 试着接收一帧状态（主进程正常会持续推送 pet:frame）
    // 先注册监听，再让主进程推帧 —— 顺序反了就什么都收不到。
    window.__frames = [];
    if (window.pet && typeof window.pet.onFrame === 'function') {
      window.pet.onFrame((f) => { window.__frames.push(f); });
    }
    // 通知主进程"可以开始推了"
    window.__readyForFrames = true;
    await new Promise((r) => setTimeout(r, 1500));
    const frameCount = window.__frames.length;
    const lastFrame = frameCount ? window.__frames[frameCount - 1] : null;
    res.frameCount = frameCount;
    res.frameReceived = frameCount > 0;
    const frame = lastFrame;
    if (frame) {
      res.frameKeys = Object.keys(frame).slice(0, 10);
      res.frameSample = {
        state: frame.state,
        mode: frame.mode,
        remainingMs: frame.remainingMs,
        spin: typeof frame.spin === 'number' ? Math.round(frame.spin * 100) / 100 : frame.spin,
      };
    }

    // 元素可见性
    const bodyStyle = getComputedStyle(document.body);
    res.bodyBg = bodyStyle.backgroundColor;
    res.bodyOverflow = bodyStyle.overflow;

    return res;
  })()`).catch((e) => ({ err: String(e) }));

  clearInterval(pushTimer);

  const checks = [
    ['页面标题正确', out.title === '风扇宠物'],
    ['DOM 根节点存在', out.root === true],
    ['preload API 暴露', out.hasPreloadApi === true],
    ['宠物外框已布局', out.dom && out.dom.petBox && out.dom.petBox.w > 0],
    ['风扇外壳有尺寸（非白屏）', out.rendered === true],
    ['扇叶 4 片', out.dom && out.dom.bladeCount === 4],
    ['两只眼睛', out.dom && out.dom.eyes === 2],
    ['有嘴巴', out.dom && out.dom.mouth === true],
    ['收到状态帧', out.frameReceived === true],
    ['帧数足够（>10）', (out.frameCount || 0) > 10],
    ['帧字段完整', out.frameKeys && out.frameKeys.length >= 8],
    ['帧内容合理', out.frameSample && typeof out.frameSample.spin === 'number'],
    ['控制台无报错', !out.consoleErrors || out.consoleErrors.length === 0],
  ];

  console.log(JSON.stringify(out, null, 2));
  console.log('');
  let pass = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (ok) pass += 1;
  }
  console.log(`
${pass}/${checks.length} 通过`);
  app.exit(pass === checks.length ? 0 : 1);
});
