'use strict';
/**
 * 风扇宠物的「大脑」：纯状态机，不碰任何 DOM 或 Electron API。
 *
 * 为什么单独拆出来：
 *   桌面宠物的主要 bug 都出在「状态乱跳」——比如一边被拖动一边自己走、
 *   或者全屏时还在跑动画。这些用 UI 调试极慢，抽成纯函数就能写测试锁死。
 */

/** 宠物状态 */
const STATE = {
  IDLE: 'idle',       // 待机：轻轻喘气
  WALK: 'walk',       // 自己在桌面上走
  DRAG: 'drag',       // 被拖拽
  SLEEP: 'sleep',     // 长时间没人理
  EXCITED: 'excited', // 被点击/喂食
  HIDDEN: 'hidden',   // 全屏应用时不打扰
  CLIMB: 'climb',     // 贴在屏幕边缘往上爬
};

/** 屏幕边缘 */
const EDGE = { NONE: 'none', LEFT: 'left', RIGHT: 'right' };

/** 工作模式：决定它在提醒你什么 */
const MODE = {
  FREE: 'free',       // 普通陪玩
  FOCUS: 'focus',     // 番茄钟进行中
  BREAK: 'break',     // 休息时间
};

/** 可调参数（面试/办公场景默认偏安静） */
const DEFAULT_OPTS = {
  walkIntervalMs: 12000,   // 多久自己走一次
  sleepAfterMs: 180000,    // 3 分钟没交互就睡
  excitedMs: 1600,         // 兴奋状态持续
  moveSpeedPxPerSec: 26,   // 走路速度
  edgeMarginPx: 8,         // 离屏幕边缘留白
  // —— 以下是番茄钟 / 喝水提醒 ——
  focusMs: 25 * 60 * 1000, // 专注时长
  breakMs: 5 * 60 * 1000,  // 休息时长
  sipIntervalMs: 45 * 60 * 1000, // 多久提醒喝一次水
  sipRemindMs: 20000,      // 提醒持续多久后自动收起
  // —— 边缘攀爬 ——
  edgeSnapPx: 28,          // 拖到离边缘多近算「贴上」
  climbSpeedPxPerSec: 40,  // 爬行速度
  climbIdleMs: 6000,       // 爬多久自己下来
};

/**
 * 宠物的大脑。
 *
 * 坐标用「屏幕可用区域」的相对位置（0..1），这样换显示器 / 改分辨率
 * 也不会跑到屏幕外 —— 这是桌面宠物最常见的翻车点。
 */
class PetBrain {
  /**
   * @param {object} [opts]
   * @param {number} [opts.now] 初始时间戳。
   *   必须可注入：构造时用 Date.now()，而 tick() 用调用方传的 now，
   *   两者一旦不同源（比如测试用虚拟时钟），
   *   状态判定会算出差几十年的间隔，睡着/走路全部失效。
   */
  constructor(opts = {}) {
    this.opts = { ...DEFAULT_OPTS, ...opts };
    this.state = STATE.IDLE;
    this.x = 0.5;              // 0..1，相对可用区域
    this.y = 0.75;
    this.facing = 1;           // 1 朝右，-1 朝左
    // 统一时钟。原来各方法的 `now = Date.now()` 默认参数直接读系统时间，
    // 与构造时注入的 now 是两套来源 —— 系统校时或用户改时间后，
    // modeRemaining 会算出十几亿毫秒这种荒谬值。
    this._clock = typeof opts.clock === 'function' ? opts.clock
      : (typeof opts.now === 'function' ? opts.now : () => Date.now());
    const t0 = typeof opts.now === 'function' ? opts.now() : (Number.isFinite(opts.now) ? opts.now : this._clock());
    this.lastInteractAt = t0;
    this.stateSince = t0;
    this.targetX = null;       // 走路目标
    this.mood = 70;            // 0..100，影响表情
    this.stats = { clicks: 0, walks: 0, slept: 0, focusDone: 0, sips: 0 };

    // —— 工作模式 ——
    this.mode = MODE.FREE;
    this.modeSince = t0;
    this.nextSipAt = t0 + this.opts.sipIntervalMs;
    this.reminder = null;      // { kind: 'sip'|'focus-done'|'break-done', until }

    // —— 转速随负载 ——
    this.load = 0;             // 0..1，来自系统 CPU
    this.spin = 0.5;           // 0..1，实际显示转速（平滑过）

    // —— 边缘攀爬 ——
    this.edge = EDGE.NONE;     // 当前贴在哪条边
    this.climbDir = -1;        // -1 向上，1 向下
    this.climbedAt = 0;
  }

  /** 切状态，并记录进入时间 */
  setState(s, now = this._clock()) {
    if (this.state === s) return;
    if (s === STATE.SLEEP) this.stats.slept++;
    this.state = s;
    this.stateSince = now;
    if (s === STATE.WALK) this.stats.walks++;
  }

  touch(now = this._clock()) {
    this.lastInteractAt = now;
    if (this.state === STATE.SLEEP) this.setState(STATE.IDLE, now);
  }

  click(now = this._clock()) {
    this.touch(now);
    // 贴在边上时点一下 = 让它下来
    if (this.edge !== EDGE.NONE) this.detachFromEdge(now);
    this.stats.clicks++;
    this.mood = Math.min(100, this.mood + 4);
    this.setState(STATE.EXCITED, now);
    // 点一下顺手收掉当前提醒，避免一直挂着
    this.reminder = null;
  }

  /** 拖拽开始 / 结束 */
  dragStart(now = this._clock()) {
    this.touch(now);
    this.setState(STATE.DRAG, now);
  }

  dragEnd(x, y, now = this._clock(), env = {}) {
    this.x = clamp01(x);
    this.y = clamp01(y);
    this.attachToEdge(env, now);
    if (this.edge !== EDGE.NONE) this.setState(STATE.CLIMB, now);
    else this.setState(STATE.IDLE, now);
  }

  /**
   * 判断拖放位置是否贴到左右边缘，贴上了就转为攀爬。
   *
   * 为什么要限制在左右：上下边缘贴上去会盖住任务栏或标题栏，
   * 而左右两侧通常是空的，宠物挂在那里最不碍事。
   */
  attachToEdge(env = {}, now = this._clock()) {
    const sw = env.screenW || 1920;
    const pw = env.petW || 150;
    const m = this.opts.edgeMarginPx;
    const snap = this.opts.edgeSnapPx;
    // 把 0..1 的相对位置换算回像素距离
    const px = this.x * Math.max(1, sw - pw - m * 2);
    const leftGap = px;
    const rightGap = Math.max(0, sw - pw - m * 2 - px);

    if (leftGap <= snap) { this.edge = EDGE.LEFT; this.x = 0; }
    else if (rightGap <= snap) { this.edge = EDGE.RIGHT; this.x = 1; }
    else { this.edge = EDGE.NONE; return false; }
    this.climbDir = -1;
    this.climbedAt = now;
    return true;
  }

  /** 从边缘放下来 */
  detachFromEdge(now = this._clock()) {
    if (this.edge === EDGE.NONE) return;
    this.edge = EDGE.NONE;
    // 离开边缘一点点，避免下次 tick 又被判成贴上
    this.x = clamp01(this.x + (this.x < 0.5 ? 0.06 : -0.06));
    this.setState(STATE.IDLE, now);
  }

  /** 全屏应用时隐藏，避免挡住演示 */
  setHidden(hidden, now = this._clock()) {
    if (hidden) this.setState(STATE.HIDDEN, now);
    else this.setState(STATE.IDLE, now);
  }

  /** 外部喂进来的系统负载（0..1），用于让扇叶转快转慢 */
  setLoad(load, dtMs = 0) {
    const l = clamp(Number(load), 0, 1);
    if (!Number.isFinite(l)) return;
    this.load = l;
    // 目标转速：低负载 0.25（看得见在转但不烦），满载 1.0
    const target = 0.25 + l * 0.75;
    // 平滑，避免 CPU 抖动时扇叶忽快忽慢
    const k = clamp(dtMs / 600, 0, 1);
    this.spin = this.spin + (target - this.spin) * Math.max(0.08, k);
  }

  /** 开始番茄钟 */
  startFocus(now = this._clock()) {
    this.mode = MODE.FOCUS;
    this.modeSince = now;
    this.reminder = null;
    this.mood = Math.min(100, this.mood + 2);
  }

  /** 结束番茄钟（提前放弃也算） */
  stopFocus(now = this._clock()) {
    this.mode = MODE.FREE;
    this.modeSince = now;
    this.reminder = null;
  }

  /** 距离本轮结束还有多少毫秒 */
  modeRemaining(now = this._clock()) {
    if (this.mode === MODE.FOCUS) {
      return Math.max(0, this.opts.focusMs - (now - this.modeSince));
    }
    if (this.mode === MODE.BREAK) {
      return Math.max(0, this.opts.breakMs - (now - this.modeSince));
    }
    return 0;
  }

  /**
   * 推进一帧。返回本帧需要做的动作，调用方据此移动窗口 / 重绘。
   * @param {number} dtMs 距上一帧的毫秒数
   * @param {object} env 环境：{screenW, screenH, petW, petH}
   */
  tick(dtMs, env = {}, now = this._clock()) {
    const act = { moveTo: null, state: this.state, reminder: null };
    if (this.state === STATE.HIDDEN) return act;

    // 转速始终平滑更新（隐藏时不转，省电）
    this.setLoad(this.load, dtMs);

    // —— 番茄钟流转 ——
    if (this.mode === MODE.FOCUS && now - this.modeSince >= this.opts.focusMs) {
      this.mode = MODE.BREAK;
      this.modeSince = now;
      this.stats.focusDone++;
      this.mood = Math.min(100, this.mood + 8);
      this.reminder = { kind: 'focus-done', until: now + 15000 };
      this.setState(STATE.EXCITED, now);
    } else if (this.mode === MODE.BREAK && now - this.modeSince >= this.opts.breakMs) {
      this.mode = MODE.FREE;
      this.modeSince = now;
      this.reminder = { kind: 'break-done', until: now + 12000 };
    }

    // —— 喝水提醒（专注时也提醒，但休息中不叠加）——
    if (this.mode !== MODE.BREAK && now >= this.nextSipAt) {
      // 关键：nextSipAt 必须从"上一次该提醒的时间"往后推，
      // 而不是从 now 推。休眠 3 小时唤醒时，从 now 推是对的，
      // 但如果不夹紧会连续触发 —— 因为下一轮 tick 的 now 又变大了。
      // 这里先把 nextSipAt 一次推到 now 之后的第一个周期点，
      // 保证一小时内最多触发一次。
      const interval = this.opts.sipIntervalMs;
      const missed = Math.floor((now - this.nextSipAt) / interval) + 1;
      this.nextSipAt = this.nextSipAt + missed * interval;
      // 已经晚了很久（比如唤醒后才发现）就不要补发了：
      // 用户不需要知道"你三小时前该喝水"
      if (now - this.nextSipAt < -interval) {
        this.nextSipAt = now + interval;
      }
      this.stats.sips++;
      this.reminder = { kind: 'sip', until: now + this.opts.sipRemindMs };
    }
    // 提醒过期自动收起
    if (this.reminder && now > this.reminder.until) this.reminder = null;
    act.reminder = this.reminder;

    // 长时间无交互 → 睡（专注时不睡，它得陪着）
    if (this.state !== STATE.SLEEP && this.state !== STATE.DRAG && this.mode === MODE.FREE
        && now - this.lastInteractAt > this.opts.sleepAfterMs) {
      this.setState(STATE.SLEEP, now);
      act.state = this.state;
      return act;
    }

    // 兴奋到时间 → 回待机
    if (this.state === STATE.EXCITED && now - this.stateSince > this.opts.excitedMs) {
      this.setState(STATE.IDLE, now);
      act.state = this.state;
      return act;
    }

    if (this.state === STATE.DRAG || this.state === STATE.SLEEP) return act;

    // —— 贴边攀爬 ——
    if (this.edge !== EDGE.NONE) {
      // 爬一会儿自己下来，别一直挂在屏幕上
      if (now - this.climbedAt > this.opts.climbIdleMs) {
        this.detachFromEdge(now);
        act.state = this.state;
        act.moveTo = this.toPixels(env);
        return act;
      }
      const sh = env.screenH || 1080;
      const ph = env.petH || 150;
      const step = (this.opts.climbSpeedPxPerSec * dtMs) / 1000 / Math.max(1, sh - ph - this.opts.edgeMarginPx * 2);
      this.y += this.climbDir * step;
      // 爬到顶/底就掉头
      if (this.y <= 0.02) { this.y = 0.02; this.climbDir = 1; }
      else if (this.y >= 0.9) { this.y = 0.9; this.climbDir = -1; }
      act.state = STATE.CLIMB;
      act.moveTo = this.toPixels(env);
      this.setState(STATE.CLIMB, now);
      return act;
    }

    // 专注时不乱跑，免得打断注意力
    if (this.mode === MODE.FOCUS) {
      if (this.state === STATE.WALK) this.setState(STATE.IDLE, now);
      act.state = this.state;
      return act;
    }

    // 待机久了 → 挑个目标走一走
    if (this.state === STATE.IDLE && now - this.stateSince > this.opts.walkIntervalMs) {
      this.targetX = 0.15 + Math.random() * 0.7;
      this.facing = this.targetX > this.x ? 1 : -1;
      this.setState(STATE.WALK, now);
      act.state = this.state;
      return act;
    }

    // 走路：线性逼近目标
    if (this.state === STATE.WALK && this.targetX != null) {
      const dx = this.targetX - this.x;
      const step = (this.opts.moveSpeedPxPerSec * dtMs) / 1000 / Math.max(1, env.screenW || 1920);
      if (Math.abs(dx) <= step) {
        this.x = this.targetX;
        this.targetX = null;
        this.setState(STATE.IDLE, now);
      } else {
        this.x += Math.sign(dx) * step;
      }
      this.x = clamp01(this.x);
      this.y = clamp(this.y, 0.08, 0.92);
      act.state = this.state;
      act.moveTo = this.toPixels(env);
    }
    return act;
  }

  /** 相对坐标 → 屏幕像素（左上角） */
  toPixels(env = {}) {
    const sw = env.screenW || 1920;
    const sh = env.screenH || 1080;
    const pw = env.petW || 150;
    const ph = env.petH || 150;
    const m = this.opts.edgeMarginPx;
    const x = Math.round(this.x * (sw - pw - m * 2)) + m;
    const y = Math.round(this.y * (sh - ph - m * 2)) + m;
    return { x, y };
  }
}

function clamp01(v) { return clamp(v, 0, 1); }
function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

module.exports = { PetBrain, STATE, MODE, EDGE, DEFAULT_OPTS, clamp, clamp01 };
