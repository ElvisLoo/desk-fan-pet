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
const { PetBrain, STATE } = require('./pet-brain');
const { createPetIcon } = require('./pet-icon');

const PET_W = 150;
const PET_H = 150;

let win = null;
let tray = null;
let brain = null;
let timer = null;
let lastTickAt = 0;
let hovering = false;

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

function startLoop() {
  lastTickAt = Date.now();
  timer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const now = Date.now();
    const dt = Math.min(500, now - lastTickAt); // 系统睡眠唤醒后 dt 会很大，夹紧
    lastTickAt = now;

    const d = screen.getPrimaryDisplay();
    const area = d.workAreaSize;
    const act = brain.tick(dt, { screenW: area.width, screenH: area.height, petW: PET_W, petH: PET_H }, now);

    if (act.moveTo) win.setPosition(act.moveTo.x, act.moveTo.y, false);
    win.webContents.send('pet:frame', {
      state: brain.state,
      mood: brain.mood,
      facing: brain.facing,
      since: now - brain.stateSince,
    });
  }, 50);
  timer.unref?.();
}

function createTray() {
  tray = new Tray(createPetIcon(32));
  tray.setToolTip('风扇宠物');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '摸摸它', click: () => { brain.click(); win?.webContents.send('pet:pat'); } },
    { label: '叫它过来', click: bringToCenter },
    { type: 'separator' },
    { label: '暂时隐藏（Ctrl+Alt+P 切换）', click: toggleVisible },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
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
  brain.dragEnd(rx, ry);
  return { ok: true };
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
