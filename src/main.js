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
const { app, BrowserWindow, ipcMain, Tray, Menu, screen, nativeImage, globalShortcut, dialog } = require('electron');
const os = require('os');
const { PetBrain, STATE, MODE } = require('./pet-brain');
const { Config } = require('./config');
const { DiaryStore } = require('./diary-store');
const QT = require('./quick-tools');
const { EdgeHide } = require('./edge-hide');
const sysStatus = require('./system-status');
const fullscreenDetect = require('./fullscreen');
const { createPetIcon } = require('./pet-icon');

// 窗口尺寸：原 150×150 只够放风扇本体。
// 四叶草展开后占 114×114，功能面板宽 244px，都会超出 150 被裁掉。
// 260×340 的布局：风扇贴底(约 128px)，菜单居中偏上，面板占上半区。
const PET_W = 260;
const PET_H = 340;

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
let diary = null;
// 上一次的计数快照：用增量而不是绝对值，避免重启后重复计入。
// 必须放在模块级 —— 写日记的是 watchFullscreen 的 interval，
// 不是 tick，两者不在同一个函数作用域里。
let lastStats = { clicks: 0, walks: 0, slept: 0, focusDone: 0, sips: 0 };
// 四叶草面板的番茄钟（跨面板关闭也继续走）
let pomodoro = null;
// 菜单展开时钉住，贴边逻辑不收回窗口
let panelPinned = false;
// 贴边收起：把窗口推到屏幕外只留一条边，鼠标碰一下弹回
// 窗口 260 宽，风扇只有 108 宽且居中 —— 两侧各 76px 是透明留白。
// contentInset/contentWidth 必须传，否则收起时露出的是留白而不是风扇。
const FAN_W = 108;
const edgeHide = new EdgeHide({
  peekPx: 28,
  graceMs: 420,
  contentInsetPx: (PET_W - FAN_W) / 2,
  contentWidthPx: FAN_W,
});
let edgeTimer = null;
let currentSide = 'none';
function initConfig() {
  cfg = new Config(path.join(app.getPath('userData'), 'pet-config.json'));
  // 每日小记：单独一个文件，不跟配置混在一起
  // （配置被用户重置时不该把使用记录一起清掉）
  diary = new DiaryStore(path.join(app.getPath('userData'), 'pet-diary.json'));
  diary.load();
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

  // 日记文案每次刷新时重算：用户在电脑前坐一整天，
  // 数字应该跟着涨，而不是停在启动那一刻。
  // 菜单对象要从托盘取，不能引用一个不存在的局部变量
  const menu = tray.contextMenu || null;
  if (menu && typeof menu.getMenuItemById === 'function') {
    const dToday = menu.getMenuItemById('diaryToday');
    const dWeek = menu.getMenuItemById('diaryWeek');
    if (dToday) dToday.label = diaryTodayLabel();
    if (dWeek) dWeek.label = diaryWeekLabel();
  }
}

/**
 * 托盘里的两行日记文案。
 * 托盘菜单宽度有限，长句会被截断，所以这里做成短句。
 */
function diaryTodayLabel() {
  try {
    if (!diary) return '今日：还没记录';
    const s = diary.summary();
    const t = s.today;
    const bits = [];
    if (t.focusDone > 0) bits.push(t.focusDone + ' 个番茄钟');
    if (t.sips > 0) bits.push('喝水 ' + t.sips);
    if (t.clicks > 0) bits.push('被摸 ' + t.clicks);
    if (!bits.length) return '今日：还没记录';
    return '今日：' + bits.join(' · ');
  } catch (_) {
    return '今日：读取失败';
  }
}

function diaryWeekLabel() {
  try {
    if (!diary) return '';
    const s = diary.summary();
    const m = s.month;
    if (!m || !m.total) return '';
    if (m.total.focusDone === 0 && m.total.sips === 0) return '';
    const bits = [];
    if (m.total.focusDone > 0) bits.push('本月 ' + m.total.focusDone + ' 个番茄钟');
    if (s.streak > 1) bits.push('连续 ' + s.streak + ' 天');
    return bits.join(' · ');
  } catch (_) {
    return '';
  }
}

/** 完整小结弹窗：托盘放不下长文本，单独开一个小窗 */
function showDiaryDialog() {
  try {
    if (!diary) return;
    const s = diary.summary();
    const t = s.today;
    const m = s.month;

    const lines = [
      '今天',
      '  完成番茄钟　' + t.focusDone + ' 个',
      '  专注时长　　' + (t.focusMs ? (t.focusMs / 60000).toFixed(0) + ' 分钟' : '—'),
      '  喝水提醒　　' + t.sips + ' 次',
      '  被摸　　　　' + t.clicks + ' 下',
      '  自己走动　　' + t.walks + ' 趟',
      '',
      '本月',
      '  完成番茄钟　' + (m.total ? m.total.focusDone : 0) + ' 个',
      '  累计专注　　' + (m.total && m.total.focusMs
        ? (m.total.focusMs / 3600000).toFixed(1) + ' 小时' : '—'),
      '  连续使用　　' + s.streak + ' 天',
      '',
      s.weekLine,
    ];

    dialog.showMessageBox({
      type: 'info',
      title: '使用小结',
      message: '风扇宠物的使用记录',
      detail: lines.join(String.fromCharCode(10)),
      buttons: ['知道了'],
      noLink: true,
    });
  } catch (e) {
    console.error('[pet] 打开小结失败:', e && e.message);
  }
}

function createTray() {
  tray = new Tray(createPetIcon(32));
  tray.setToolTip('风扇宠物');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '摸摸它', click: () => { brain.click(); win?.webContents.send('pet:pat'); } },
    { label: '叫它过来', click: bringToCenter },
    { type: 'separator' },
    { label: diaryTodayLabel(), enabled: false, id: 'diaryToday' },
    { label: diaryWeekLabel(), enabled: false, id: 'diaryWeek', visible: false },
    { label: '查看完整小结…', click: showDiaryDialog },
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

  // 拖到离边缘很近时，进入"贴边收起"模式
  applyEdgeHide(p);

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

// ---------- 四叶草菜单 ----------

ipcMain.on('pet:pin', (_e, on) => {
  panelPinned = !!on;
  // 面板打开时钉住：既让贴边不收回，也保证鼠标能移进去点
  edgeHide.setPinned(panelPinned);
  if (panelPinned) edgeHide.enter(Date.now());
});

// ---------- 贴边收起 ----------

/**
 * 拖拽松手后判断要不要贴边。
 * 只在「离屏幕左右边缘 28px 以内」时触发，避免误触。
 */
function applyEdgeHide(pos) {
  if (!win || win.isDestroyed()) return;
  const d = screen.getPrimaryDisplay();
  const b = d.workArea;

  const gapLeft = pos.x - b.x;
  const gapRight = (b.x + b.width) - (pos.x + PET_W);

  if (gapLeft <= 28) {
    currentSide = 'left';
    edgeHide.attach('left');
  } else if (gapRight <= 28) {
    currentSide = 'right';
    edgeHide.attach('right');
  } else {
    currentSide = 'none';
    edgeHide.detach();
    return;
  }
  edgeHide.leave(Date.now() - edgeHide.opts.graceMs);   // 允许立刻收起
  applyEdgeGeometry();
}

/** 按当前收起状态摆放窗口 */
function applyEdgeGeometry() {
  if (!win || win.isDestroyed()) return;
  const d = screen.getPrimaryDisplay();
  const b = d.workArea;
  const rect = win.getBounds();

  if (currentSide === 'none') {
    if (edgeHide.collapsed) edgeHide.collapsed = false;
    return;
  }

  const g = edgeHide.collapsed
    ? edgeHide.collapsedGeometry(rect, b.width)
    : edgeHide.expandedGeometry(rect, b.width);

  // 纵向保持原位，只动横向
  win.setBounds({ x: Math.round(g.x), y: rect.y, width: rect.width, height: rect.height }, false);
}

/**
 * 每 120ms 看一次鼠标位置：
 *   碰到露出的一条边 → 弹出；离开够久 → 缩回。
 * 用轮询而不是 mouseenter，是因为窗口缩到屏幕外时
 * 渲染层收不到事件，只能由主进程读系统光标位置。
 */
function startEdgeWatcher() {
  if (edgeTimer) clearInterval(edgeTimer);
  let wasCollapsed = false;

  edgeTimer = setInterval(() => {
    if (!win || win.isDestroyed() || currentSide === 'none') return;

    const d = screen.getPrimaryDisplay();
    const b = d.workArea;
    const rect = win.getBounds();
    const pt = screen.getCursorScreenPoint();

    // 收起状态下：光标进入露出区域就展开
    if (edgeHide.collapsed) {
      const peekHit =
        (currentSide === 'left' && pt.x <= b.x + edgeHide.opts.hotZonePx) ||
        (currentSide === 'right' && pt.x >= b.x + b.width - edgeHide.opts.hotZonePx);
      const inVertical = pt.y >= rect.y - 4 && pt.y <= rect.y + rect.height + 4;

      if (peekHit && inVertical) {
        edgeHide.enter(Date.now());
        applyEdgeGeometry();
        setThrough(false);
        wasCollapsed = true;
        return;
      }
      return;
    }

    // 展开状态：光标离开窗口范围就准备收回
    const inside = pt.x >= rect.x - 6 && pt.x <= rect.x + rect.width + 6 &&
                   pt.y >= rect.y - 6 && pt.y <= rect.y + rect.height + 6;
    if (!inside && !panelPinned) {
      edgeHide.leave(Date.now());
    } else {
      edgeHide.enter(Date.now());
    }

    if (edgeHide.tick(Date.now()) && wasCollapsed === false) {
      applyEdgeGeometry();
      setThrough(true);   // 收起后鼠标穿透，不挡桌面
      wasCollapsed = true;
    } else if (!edgeHide.collapsed) {
      wasCollapsed = false;
    }
  }, 120);
  edgeTimer.unref?.();
}

// 注意：pet:pin 的监听已经在「四叶草菜单」段注册过。
// 这里再注册一次会让后面的覆盖前面的，setPinned 就不生效了 ——
// 面板打开时仍会被贴边逻辑收走。

ipcMain.handle('tool:memory', () => {
  const total = os.totalmem();
  const free = os.freemem();
  const a = QT.analyzeMemory({ total, free });
  return {
    ...a,
    usedText: QT.formatBytes(a.used),
    totalText: QT.formatBytes(a.total),
    freeText: QT.formatBytes(a.free),
    canFreeText: QT.formatBytes(a.canFree),
  };
});

/**
 * 清理内存。
 *
 * 诚实说明：Node 能做的只有「让本进程交出可回收的内存」，
 * 没法真的去清别的程序。这里做两件有实际作用的事：
 *   1. 触发 V8 垃圾回收（--expose-gc 未开启时降级为无害的分配释放）
 *   2. 清掉 Electron 的会话缓存
 * 然后重新读一次真实占用，把实际变化告诉用户，而不是编一个"释放了 2.3GB"。
 */
ipcMain.handle('tool:cleanMemory', async () => {
  const before = os.freemem();
  try {
    if (global.gc) global.gc();
    if (win && !win.isDestroyed() && win.webContents) {
      await win.webContents.session.clearCache();
    }
  } catch (_) {}
  // 给系统一点时间回收
  await new Promise((r) => setTimeout(r, 600));
  const after = os.freemem();
  const delta = Math.max(0, after - before);
  return {
    ok: true,
    reclaimed: delta,
    reclaimedText: delta > 1024 * 1024 ? QT.formatBytes(delta) : '',
  };
});

ipcMain.handle('tool:ai', async (_e, text, history) => {
  const cfg = (cfg && cfg.get('ai')) || {};
  const baseUrl = String(cfg.baseUrl || '').trim();
  const apiKey = String(cfg.apiKey || '').trim();

  // 没配端点时用本地回答，不假装能联网
  if (!baseUrl) {
    return { text: QT.localReply(text), local: true };
  }

  const body = QT.buildChatRequest(cfg, history, text);
  try {
    const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      return { text: '接口返回 ' + res.status + '，检查一下地址和 Key。', local: true };
    }
    const json = await res.json();
    const reply = QT.extractReply(json);
    return { text: reply || '模型没给内容，再问一次试试。', local: false };
  } catch (e) {
    return { text: '连不上模型：' + String((e && e.message) || e).slice(0, 60), local: true };
  }
});

function pomo() {
  if (!pomodoro) pomodoro = new QT.Pomodoro();
  return pomodoro;
}

ipcMain.handle('tool:pomo', (_e, action) => {
  const p = pomo();
  const now = Date.now();
  if (action === 'start') return p.start(now);
  if (action === 'pause') return p.pause(now);
  if (action === 'skip') return p.skip(now);
  if (action === 'reset') return p.reset();
  return p.snapshot();
});

ipcMain.handle('tool:pomoState', () => pomo().tick(Date.now()).changed
  ? pomo().snapshot()
  : pomo().snapshot());

ipcMain.handle('tool:fortune', () => QT.dailyFortune(new Date()));

ipcMain.handle('pet:state', () => ({
  state: brain.state, mood: brain.mood, stats: brain.stats,
}));

/**
 * 把 pet-brain 里的计数增量写进日记。
 *
 * 为什么要对比增量而不是直接读绝对值：
 *   brain.stats 是本次进程内累加的，重启就归零；
 *   日记是跨天跨进程累加的。直接写绝对值会把历史记录冲掉。
 */
function syncDiary(now, prev) {
  if (!diary || !brain) return;
  const cur = brain.stats;
  for (const key of ['clicks', 'walks', 'slept', 'focusDone', 'sips']) {
    const delta = (cur[key] || 0) - (prev[key] || 0);
    if (delta > 0) {
      const field = key;
      // focusDone 同时折算 25 分钟专注时长
      diary.bump(field, delta, now);
      if (field === 'focusDone') {
        diary.addFocus(delta * brain.opts.focusMs, now);
      }
    }
  }
}

// 全屏应用时隐藏（Windows 下用窗口层级近似：检测前台窗口是否全屏）
function watchFullscreen() {
  // 任务栏设成「自动隐藏」时，原本的近似判断会一直认为处于全屏，
  // 宠物于是永远隐身，而用户完全不知道为什么。
  // 先探一次任务栏状态，决定用哪种判定方式。
  let autohide = false;
  let useNative = true;
  try {
    autohide = fullscreenDetect.isTaskbarAutohide();
    if (autohide) {
      console.log('[pet] 检测到任务栏自动隐藏，改用前台窗口检测全屏');
    }
  } catch (_) {}

  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const now = Date.now();
    const d = screen.getPrimaryDisplay();
    let isFullscreen = false;

    if (useNative) {
      const rect = fullscreenDetect.queryForegroundFullscreen();
      if (rect === null) {
        // PowerShell 不可用/被策略禁用：退回近似判断并永久关闭原生路径，
        // 避免每 3 秒起一次失败的子进程
        useNative = false;
      } else if (rect.left === 0 && rect.right === 0) {
        // 前台是桌面（没有真实窗口）
        isFullscreen = false;
      } else {
        isFullscreen = fullscreenDetect.coversScreen(rect, d.bounds);
      }
    }

    if (!useNative) {
      isFullscreen = fullscreenDetect.isFullscreenByWorkArea({
        workH: d.workAreaSize.height,
        screenH: d.size.height,
        taskbarAutohide: autohide,
      });
    }

    syncDiary(now, lastStats);
    lastStats = { ...brain.stats };

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
  if (edgeTimer) clearInterval(edgeTimer);
  // 退出前再存一次：用户可能拖完立刻关电脑，晚于拖动的那次保存
  savePosition();
  // 日记是节流写盘的，退出时把没落盘的部分补上，否则会丢最后几秒的记录
  try { if (diary) diary.flush(); } catch (_) {}
});
app.on('second-instance', () => { if (win) { win.showInactive(); bringToCenter(); } });
