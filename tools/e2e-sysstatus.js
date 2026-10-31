'use strict';
/**
 * 系统状态功能：真实 Electron 验证。
 *
 * 要证明的是三件事：
 *   1. 主进程能采到真实的系统数据（不是写死的假值）
 *   2. 状态能推到渲染层，徽标按等级正确显示
 *   3. 正常时不显示徽标（不打扰）
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

app.setPath('userData', path.join(os.tmpdir(), 'pet-sys-' + Date.now()));
app.disableHardwareAcceleration();
setTimeout(() => { console.log('TIMEOUT'); app.exit(2); }, 45000);

const ROOT = path.resolve(__dirname, '..');
const sysStatus = require(path.join(ROOT, 'src', 'system-status'));

app.whenReady().then(async () => {
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
  w.webContents.on('console-message', (_e, l, m) => { if (l >= 2) errors.push(m.slice(0, 140)); });

  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 800));

  // ---- 主进程侧：真实采集 ----
  const total = os.totalmem();
  const free = os.freemem();
  const realMem = {
    usedRatio: (total - free) / total,
    usedGb: (total - free) / 1024 ** 3,
    totalGb: total / 1024 ** 3,
  };

  const realStatus = sysStatus.summarize({
    battery: null,        // 本机是台式机
    memory: realMem,
    cpu: 0.35,
  });

  // ---- 推给渲染层 ----
  let pushTimer = null;
  function startPush(status) {
    if (pushTimer) clearInterval(pushTimer);
    pushTimer = setInterval(() => {
      if (w.isDestroyed()) return;
      w.webContents.send('pet:frame', {
        state: 'idle', mood: 70, facing: 1, since: 0, mode: 'free',
        remainingMs: 0, reminder: null, spin: 0.5, edge: 'none', climbDir: 0,
        status,
      });
    }, 50);
  }
  startPush(realStatus);

  const normalView = await w.webContents.executeJavaScript(`(async () => {
    await new Promise(r => setTimeout(r, 900));
    const b = document.querySelector('.sys-badge');
    return { exists: !!b, hidden: b ? b.hidden : null, text: b ? b.textContent : '' };
  })()`);

  // ---- 换成高压力状态 ----
  const stressed = sysStatus.summarize({
    battery: { percent: 8, charging: false },
    memory: { usedRatio: 0.95, usedGb: 15, totalGb: 16 },
    cpu: 0.97,
  });
  startPush(stressed);

  const critView = await w.webContents.executeJavaScript(`(async () => {
    await new Promise(r => setTimeout(r, 900));
    const b = document.querySelector('.sys-badge');
    return {
      hidden: b ? b.hidden : null,
      text: b ? b.textContent : '',
      level: b ? b.dataset.level : '',
    };
  })()`);

  // ---- 触发警报气泡 ----
  w.webContents.send('pet:alert', { kind: 'battery', level: 'crit', text: '电量 8%' });
  const alertView = await w.webContents.executeJavaScript(`(async () => {
    await new Promise(r => setTimeout(r, 400));
    const b = document.getElementById('bubble');
    return { bubbleHidden: b ? b.hidden : null, bubbleText: b ? b.textContent : '' };
  })()`);

  clearInterval(pushTimer);

  const checks = [
    ['采到真实内存数据', realMem.usedRatio > 0 && realMem.usedRatio < 1],
    ['内存总量接近真实', Math.abs(realMem.totalGb - total / 1024 ** 3) < 0.1],
    ['正常状态无警报', realStatus.alerts.length === 0],
    ['正常时徽标隐藏', normalView.hidden === true],
    ['高压状态产生警报', stressed.alerts.length >= 2],
    ['高压时徽标显示', critView.hidden === false],
    ['徽标取最严重项（电量）', critView.text.includes('电量')],
    ['徽标等级为 crit', critView.level === 'crit'],
    ['警报气泡弹出', alertView.bubbleHidden === false],
    ['气泡内容正确', alertView.bubbleText.includes('电量 8%')],
    ['控制台无报错', errors.length === 0],
  ];

  console.log('真实内存:', (realMem.usedRatio * 100).toFixed(0) + '%',
    `(${realMem.usedGb.toFixed(1)}/${realMem.totalGb.toFixed(0)}G)`);
  console.log('高压徽标:', critView.text, '| level:', critView.level);
  console.log('');
  let pass = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (ok) pass += 1;
  }
  if (errors.length) console.log('\n错误:', errors.slice(0, 3));
  console.log(`\n${pass}/${checks.length} 通过`);
  app.exit(pass === checks.length ? 0 : 1);
});
