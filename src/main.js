'use strict';
/**
 * 风扇宠物 · 主进程
 *
 * 窗口策略（桌面宠物的三条铁律）：
 *   1. 透明无框、置顶、不占任务栏、不抢焦点；
 *   2. 默认鼠标穿透 —— 宠物不该挡住你点文件（悬停才接管鼠标）；
 *   3. 全屏应用时自动隐藏，不在你演示时冒出来。
 */
const path = require('path');
const { app, BrowserWindow, ipcMain, Tray, Menu, screen, nativeImage, globalShortcut } = require('electron');
const os = require('os');
const { PetBrain, STATE, MODE } = require('./pet-brain');
const { createPetIcon } = require('./pet-icon');

const PET_W = 150;
const PET_H = 150;

let win = null;
let tray = null;
let brain = null;
let timer = null;
let lastTickAt = 0;
let hovering = false;

// ---------- 开机自启 ----------
// 用注册表 Run 键而不是 Startup 文件夹：不需要额外权限，删除也干净。
// HKCU 下写入，只影响当前用户，不需要管理员。
const AUTOSTART_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const AUTOSTART_NAME = 'DeskFanPet';

function autostartEnabled() {
  if (process.platform !== 'win32') return false;
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('reg', ['query', AUTOSTART_KEY, '/v', AUTOSTART_NAME], { encoding: 'utf8', windowsHide: true });
    return out.includes(AUTOSTART_NAME);
  } catch (_) { return false; }
}

function setAutostart(on) {
  if (process.platform !== 'win32') return { ok: false, reason: '仅支持 Windows' };
  try {
    const { execFileSync } = require('child_process');
    if (on) {
      // 打包后 process.execPath 就是 exe 本身；开发模式下指向 electron.exe，
      // 用引号包住避免路径含空格时被拆开
      const exe = process.execPath;
      const args = app.isPackaged ? [exe] : [exe, path.resolve(__dirname, '..')];
      execFileSync('reg', ['add', AUTOSTART_KEY, '/v', AUTOSTART_NAME, '/t', 'REG_SZ',
        '/d', `"${args.join('" "')}"`, '/f'], { windowsHide: true });
    } else {
      execFileSync('reg', ['delete', AUTOSTART_KEY, '/v', AUTOSTART_NAME, '/f'], { windowsHide: true });
    }
    return { ok: true, enabled: on };
  } catch (e) {
    // 组策略禁用注册表时这里会失败，必须让调用方知道
    return { ok: false, reason: String(e && e.message || e).slice(0, 120) };
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

function createWindow() {
  const area = screen.getPrimaryDisplay().workAreaSize;
  brain = new PetBrain({ now: Date.now() });
  const pos = brain.toPixels({ ...area, screenW: area.width, screenH: area.height, petW: PET_W, petH: PET_H });

  win = new BrowserWindow({
    width: PET_W,
    height: PET_H,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    icon: createPetIcon(256),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

/** 宠物窗口的鼠标穿透开关：悬停时接管，离开后放开 */
function setThrough(through) {
  if (!win || win.isDestroyed()) return;
  hovering = !through;
  win.setIgnoreMouseEvents(through, { forward: true });
}

/**
 * 用 os.cpus() 的累计时间差估算 CPU 负载（0..1）。
 * 不引第三方依赖；采样间隔 2 秒，够平滑也不会自己变成负载。
 */
function createCpuSampler() {
  let prev = snapshot();
  function snapshot() {
    const cpus = os.cpus() || [];
    let idle = 0, total = 0;
    for (const c of cpus) {
      const t = c.times;
      idle += t.idle;
      total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    return { idle, total };
  }
  return () => {
    const cur = snapshot();
    const dIdle = cur.idle - prev.idle;
    const dTotal = cur.total - prev.total;
    prev = cur;
    if (dTotal <= 0) return 0;
    return Math.min(1, Math.max(0, 1 - dIdle / dTotal));
  };
}

function startLoop() {
  lastTickAt = Date.now();
  const sampleCpu = createCpuSampler();
  let lastCpuAt = 0;
  timer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const now = Date.now();
    const dt = Math.min(500, now - lastTickAt); // 系统睡眠唤醒后 dt 会很大，夹紧
    lastTickAt = now;

    // 每 2 秒采一次 CPU，避免采样本身占资源
    if (now - lastCpuAt > 2000) {
      lastCpuAt = now;
      brain.setLoad(sampleCpu(), 2000);
    }

    const d = screen.getPrimaryDisplay();
    const area = d.workAreaSize;
    const act = brain.tick(dt, { screenW: area.width, screenH: area.height, petW: PET_W, petH: PET_H }, now);

    if (act.moveTo) win.setPosition(act.moveTo.x, act.moveTo.y, false);
    win.webContents.send('pet:frame', {
      state: brain.state,
      mood: brain.mood,
      facing: brain.facing,
      since: now - brain.stateSince,
      mode: brain.mode,
      remainingMs: brain.modeRemaining(now),
      reminder: act.reminder,
      spin: brain.spin,
      edge: brain.edge,
      climbDir: brain.climbDir,
    });
  }, 50);
  timer.unref?.();
}

let focusItem = null;

function refreshTrayMenu() {
  if (!tray) return;
  const mins = Math.ceil(brain.modeRemaining() / 60000);
  if (focusItem) {
    if (brain.mode === MODE.FOCUS) {
      focusItem.label = `专注中：还剩 ${mins} 分钟`;
      focusItem.visible = true;
    } else if (brain.mode === MODE.BREAK) {
      focusItem.label = `休息中：还剩 ${mins} 分钟`;
      focusItem.visible = true;
    } else {
      focusItem.visible = false;
    }
  }
}

function createTray() {
  tray = new Tray(createPetIcon(32));
  tray.setToolTip('风扇宠物');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '摸摸它', click: () => { brain.click(); win?.webContents.send('pet:pat'); } },
    { label: '叫它过来', click: bringToCenter },
    { type: 'separator' },
    { label: '开始专注（25 分钟）', click: () => { brain.startFocus(); refreshTrayMenu(); } },
    { label: '结束专注', click: () => { brain.stopFocus(); refreshTrayMenu(); } },
    { label: `专注中：${0} 分钟`, enabled: false, id: 'focusLeft', visible: false },
    { type: 'separator' },
    { label: '暂时隐藏（Ctrl+Alt+P 切换）', click: toggleVisible },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: autostartEnabled(),
      click: (item) => {
        const r = setAutostart(item.checked);
        if (!r.ok) {
          // 写注册表失败时必须把勾去掉，否则用户以为设上了
          item.checked = !item.checked;
          win?.webContents.send('pet:notice', '开机自启设置失败：' + (r.reason || '未知原因'));
        }
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  // 保存“专注中”那一项的引用，每分钟更新文字
  const menu = tray.contextMenu || null;
  const findItem = (items) => {
    for (const it of items || []) {
      if (it && typeof it.label === 'string' && it.label.includes('专注中：')) return it;
      const sub = it && it.submenu && it.submenu.items;
      const hit = sub ? findItem(sub) : null;
      if (hit) return hit;
    }
    return null;
  };
  focusItem = menu ? findItem(menu.items) : null;
  refreshTrayMenu();
  tray.on('click', () => { brain.click(); win?.webContents.send('pet:pat'); });
}

function bringToCenter() {
  if (!win || win.isDestroyed()) return;
  const d = screen.getPrimaryDisplay();
  const a = d.workAreaSize;
  brain.x = 0.5;
  brain.y = 0.7;
  const p = brain.toPixels({ screenW: a.width, screenH: a.height, petW: PET_W, petH: PET_H });
  win.setPosition(p.x, p.y, true);
  win.showInactive();
}

let visible = true;
function toggleVisible() {
  if (!win || win.isDestroyed()) return;
  visible = !visible;
  if (visible) { win.showInactive(); brain.setHidden(false); }
  else { win.hide(); brain.setHidden(true); }
}

// ---- IPC ----
ipcMain.on('pet:hover', (_e, on) => setThrough(!on));
ipcMain.handle('pet:click', () => { brain.click(); return { mood: brain.mood }; });
ipcMain.handle('pet:dragStart', () => { brain.dragStart(); return { ok: true }; });
ipcMain.handle('pet:dragEnd', (_e, p) => {
  const d = screen.getPrimaryDisplay();
  const a = d.workAreaSize;
  // 像素 → 相对坐标
  const rx = (p.x - 8) / Math.max(1, a.width - PET_W - 16);
  const ry = (p.y - 8) / Math.max(1, a.height - PET_H - 16);
  // 传入屏幕尺寸：吸附判定是按像素算的，缺了 env 就算不出距离
  brain.dragEnd(rx, ry, Date.now(), {
    screenW: a.width, screenH: a.height, petW: PET_W, petH: PET_H,
  });
  return { ok: true, edge: brain.edge, state: brain.state };
});
// 拖拽过程中实时移动窗口。用 send（不等待回执）而不是 invoke，
// 否则鼠标每动 1px 都要走一次 IPC 往返，拖起来会顿。
const DRAG_BOUND = 60; // 允许拖出屏幕的像素余量，但不能无限拖走
ipcMain.on('pet:move', (_e, p) => {
  if (!win || win.isDestroyed() || !p) return;
  const d = screen.getPrimaryDisplay();
  const a = d.workAreaSize;
  const x = Math.round(Number(p.x));
  const y = Math.round(Number(p.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  // 夹住窗口位置：宠物不能被拖到完全看不见的地方
  const cx = Math.min(a.width - DRAG_BOUND, Math.max(DRAG_BOUND - PET_W, x));
  const cy = Math.min(a.height - DRAG_BOUND, Math.max(0, y));
  win.setPosition(cx, cy, false);
});

ipcMain.handle('pet:state', () => ({
  state: brain.state, mood: brain.mood, stats: brain.stats,
}));

// 全屏应用时隐藏（Windows 下用窗口层级近似：检测前台窗口是否全屏）
function watchFullscreen() {
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const d = screen.getPrimaryDisplay();
    const cur = d.workAreaSize;
    const full = d.size;
    // 任务栏被占满 ⇒ 大概率有全屏应用
    const isFullscreen = cur.height >= full.height - 2;
    if (brain.mode !== MODE.FREE) refreshTrayMenu();
    if (isFullscreen && brain.state !== STATE.HIDDEN) { win.hide(); brain.setHidden(true); }
    else if (!isFullscreen && brain.state === STATE.HIDDEN && visible) { win.showInactive(); brain.setHidden(false); }
  }, 3000).unref?.();
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  createTray();
  startLoop();
  watchFullscreen();
  globalShortcut.register('Ctrl+Alt+P', toggleVisible);
  console.log('[风扇宠物] 已启动');
});

app.on('window-all-closed', () => { /* 托盘常驻 */ });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (timer) clearInterval(timer);
});
app.on('second-instance', () => { if (win) { win.showInactive(); bringToCenter(); } });
