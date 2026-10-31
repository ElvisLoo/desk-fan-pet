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
const { Config } = require('./config');
const sysStatus = require('./system-status');
const { createPetIcon } = require('./pet-icon');

const PET_W = 150;
const PET_H = 150;

// 渲染进程崩溃的自动恢复上限：够覆盖偶发崩溃，又不至于无限重启
const MAX_CRASH_RELOAD = 3;
let crashCount = 0;

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

// ---------- 系统状态采集 ----------

/**
 * 内存：os.totalmem/freemem 在所有平台都有，零依赖。
 * 注意 freemem 在 Windows 上是"可用"（含缓存可回收部分），
 * 比任务管理器的"可用"略高，但对"是否吃紧"这个判断足够。
 */
function readMemory() {
  try {
    const total = os.totalmem();
    const free = os.freemem();
    if (!total) return null;
    const used = total - free;
    return {
      usedRatio: used / total,
      usedGb: used / 1024 ** 3,
      totalGb: total / 1024 ** 3,
    };
  } catch (_) {
    return null;
  }
}

/**
 * 电量：Node 没有内置接口，Windows 上用 WMI 查询。
 *
 * 为什么不用 PowerShell：每次启动一个 powershell.exe 要 200-400ms，
 * 每 2 秒跑一次会明显可见地吃 CPU —— 一个"监控系统状态"的功能
 * 自己成为负担就本末倒置了。
 * 这里用 WMIC 一次性输出，读取超时也设上限。
 *
 * 台式机没有电池，查询会失败或返回空，返回 null 即可（界面不显示）。
 */
let batteryProbed = false;
let batterySupported = true;
let batteryCache = null;
let batteryCacheAt = 0;

function readBattery() {
  if (process.platform !== 'win32') return null;
  if (!batterySupported) return null;

  const now = Date.now();
  // 电量变化慢，15 秒缓存一次足够，避免频繁起子进程
  if (now - batteryCacheAt < 15000) return batteryCache;

  batteryCacheAt = now;
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('wmic', ['path', 'Win32_Battery', 'get',
      'EstimatedChargeRemaining,BatteryStatus', '/format:list'],
    { encoding: 'utf8', windowsHide: true, timeout: 3000 });

    const pctMatch = out.match(/EstimatedChargeRemaining=(\d+)/);
    const statMatch = out.match(/BatteryStatus=(\d+)/);
    if (!pctMatch) {
      // 没有电池（台式机）或查询失败：以后不再尝试，省掉每 15 秒一次的子进程
      batterySupported = false;
      batteryCache = null;
      return null;
    }
    // BatteryStatus: 2 = 接通电源充电中（AC）
    const charging = statMatch ? statMatch[1] === '2' : false;
    batteryCache = {
      percent: Number(pctMatch[1]),
      charging,
      minutesLeft: null,   // WMI 这个字段不可靠，宁可不显示也不给错值
    };
    return batteryCache;
  } catch (_) {
    batterySupported = false;
    batteryCache = null;
    return null;
  }
}

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

/** 窗口当前位置是否还落在某块屏幕的可见区域内（拔掉副屏后要判断） */
function isOnAnyScreen(x, y) {
  try {
    const displays = screen.getAllDisplays();
    for (const d of displays) {
      const b = d.bounds;
      // 只要求有一部分可见：窗口左上角落在屏内，或与屏有交集
      if (x + PET_W > b.x && x < b.x + b.width && y + PET_H > b.y && y < b.y + b.height) {
        return true;
      }
    }
  } catch (_) {}
  return false;
}

/** 记住当前位置；失败只记日志，不打断使用 */
function savePosition() {
  if (!cfg || !win || win.isDestroyed()) return { ok: false };
  try {
    const [x, y] = win.getPosition();
    return cfg.set({ x, y, placed: true });
  } catch (e) {
    console.warn('[pet] 保存位置失败:', e && e.message);
    return { ok: false };
  }
}

// 配置只在 ready 之后创建（此时 userData 路径才确定）
let cfg = null;
function initConfig() {
  cfg = new Config(path.join(app.getPath('userData'), 'pet-config.json'));
  cfg.load();
  return cfg;
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workAreaSize;
  brain = new PetBrain({ now: Date.now() });
  const pos = brain.toPixels({ ...area, screenW: area.width, screenH: area.height, petW: PET_W, petH: PET_H });

  // 用户拖过就用上次的位置，没拖过才落到默认角落。
  // 但必须先确认那块屏还在：拔掉副屏后旧坐标可能落到屏幕外，
  // 宠物会"启动成功但看不见"，这比不记住位置糟糕得多。
  let startX = pos.x;
  let startY = pos.y;
  if (cfg && cfg.get('placed')) {
    const sx = cfg.get('x');
    const sy = cfg.get('y');
    if (Number.isFinite(sx) && Number.isFinite(sy) && isOnAnyScreen(sx, sy)) {
      startX = sx;
      startY = sy;
      brain.setPosition?.(startX, startY);
    } else if (Number.isFinite(sx)) {
      console.warn('[pet] 记住的位置已不在任何屏幕上，回退默认位置');
      cfg.set({ placed: false, x: null, y: null });
    }
  }

  win = new BrowserWindow({
    width: PET_W,
    height: PET_H,
    x: startX,
    y: startY,
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

  // 渲染进程崩溃/被系统回收后，窗口还在但内容是空白透明的一块 ——
  // 用户只会觉得「宠物凭空消失了」，而托盘图标还在，也不会自己恢复。
  // 这里自动重建，并限制次数，避免某个必然崩溃的 bug 打成死循环。
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[pet] 渲染进程退出:', details && details.reason);
    if (!win || win.isDestroyed()) return;
    if (crashCount >= MAX_CRASH_RELOAD) {
      console.error('[pet] 连续崩溃次数过多，停止自动恢复');
      return;
    }
    crashCount += 1;
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.reload();
    }, 600);
  });

  // 加载失败（文件缺失、路径被改）会留下一个全透明窗口，同样要换回可见状态
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[pet] 页面加载失败:', code, desc);
  });
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
  const cpuAvg = new sysStatus.CpuAverager({ windowSize: 5 });
  const alertGate = new sysStatus.AlertGate({ cooldownMs: 10 * 60 * 1000 });
  let lastCpuAt = 0;
  let status = { items: [], level: 'ok', alerts: [] };
  timer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const now = Date.now();
    const dt = Math.min(500, now - lastTickAt); // 系统睡眠唤醒后 dt 会很大，夹紧
    lastTickAt = now;

    // 每 2 秒采一次 CPU，避免采样本身占资源
    if (now - lastCpuAt > 2000) {
      lastCpuAt = now;
      const raw = sampleCpu();
      brain.setLoad(raw, 2000);

      // 系统状态：CPU 用平滑值（单次尖峰不该让宠物报警），
      // 内存/电量直接读（它们本身变化就慢）
      status = sysStatus.summarize({
        battery: readBattery(),
        memory: readMemory(),
        cpu: cpuAvg.push(raw),
      });

      // 警报去抖：内存 85% 会持续很久，每帧提醒等于骚扰
      const fresh = alertGate.filter(status.alerts);
      for (const a of fresh) {
        if (win && !win.isDestroyed()) {
          win.webContents.send('pet:alert', a);
        }
      }
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
      // 系统状态：渲染层据此显示角标与图标
      status,
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
  // 松手即记：这是唯一"用户明确表达了意图"的时刻。
  // 边爬边动的不记，否则会被攀爬动画写进一堆中间坐标。
  savePosition();
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

// 进程级兜底：常驻托盘的小工具一旦抛异常就是静默退出，
// 用户看到的是「图标还在但点了没反应」。这里至少留下可追溯的日志。
process.on('uncaughtException', (err) => {
  console.error('[pet] uncaughtException:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[pet] unhandledRejection:', reason);
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  initConfig();
  createWindow();
  createTray();
  startLoop();
  watchFullscreen();
  // 返回值必须看：Ctrl+Alt+P 容易和输入法/截屏工具撞，撞了就没有任何提示。
  const hotkeyOk = globalShortcut.register('Ctrl+Alt+P', toggleVisible);
  if (!hotkeyOk) {
    console.warn('[pet] Ctrl+Alt+P 被占用，显隐只能用托盘菜单');
    if (tray) {
      try {
        tray.setToolTip('风扇宠物（Ctrl+Alt+P 被占用，请用右键菜单）');
      } catch (_) {}
    }
  }
  console.log('[风扇宠物] 已启动');
}).catch((err) => {
  // 启动链失败时不能什么都不做，否则进程静默退出、双击毫无反应
  console.error('[pet] 启动失败:', err && err.stack ? err.stack : err);
  app.exit(1);
});

app.on('window-all-closed', () => { /* 托盘常驻 */ });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (timer) clearInterval(timer);
  // 退出前再存一次：用户可能拖完立刻关电脑，晚于拖动的那次保存
  savePosition();
});
app.on('second-instance', () => { if (win) { win.showInactive(); bringToCenter(); } });
