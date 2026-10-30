'use strict';
/**
 * 轻量配置持久化
 *
 * 为什么需要：桌面宠物是用一次就不看的常驻小工具，用户对它的预期是
 * 「拖到哪就待在哪」。原来位置只存在内存里，每次重启都回到默认角落，
 * 番茄钟设好的时长、静音开关也一样丢 —— 用户会觉得这软件没记住任何东西。
 *
 * 设计取舍：
 *   - 用同步读写。配置只有几百字节，同步的代价可以忽略，
 *     而异步写盘会让「退出前最后一次拖动」有概率写不进去。
 *   - 写盘先写临时文件再 rename，避免断电/崩溃留下半截 JSON
 *     （半截 JSON 会导致下次启动解析失败，直接回到默认状态，且用户毫不知情）。
 *   - 任何异常都不抛：配置文件坏了就当没有，用默认值继续跑。
 *     宠物打不开比配置丢失严重得多。
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // 窗口位置：null 表示用默认（屏幕右下角）
  x: null,
  y: null,
  // 用户是否手动拖过。拖过就不再每次启动重置位置
  placed: false,
  // 番茄钟时长（分钟）
  focusMinutes: 25,
  breakMinutes: 5,
  // 喝水提醒间隔（分钟），0 表示关闭
  waterMinutes: 45,
  // 是否跟随 CPU 负载调整转速
  followCpu: true,
  // 声音提醒开关
  sound: true,
};

const LIMITS = {
  focusMinutes: [1, 180],
  breakMinutes: [1, 60],
  waterMinutes: [0, 480],
};

function clampInt(v, min, max, def) {
  // 只接受数字和数字字符串。
  // Number([]) === 0 但 Number({}) === NaN —— 直接 Number() 会把空数组
  // 当成合法的 0。用户手改出 "focusMinutes": [] 就会得到 0 分钟的番茄钟，
  // 一按开始立刻到点，看起来就是坏了。
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return def;
  } else if (!(typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)))) {
    return def;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

/** 只接受 JSON 里明确允许的字段，其它一律丢弃（防脏数据/手改出错） */
function sanitize(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;

  for (const k of ['x', 'y']) {
    const n = Number(raw[k]);
    // 坐标允许为负（多屏时副屏在主屏左侧），但不接受荒谬值
    if (Number.isFinite(n) && Math.abs(n) < 100000) out[k] = Math.round(n);
  }
  out.placed = raw.placed === true;

  for (const k of Object.keys(LIMITS)) {
    const [min, max] = LIMITS[k];
    out[k] = clampInt(raw[k], min, max, DEFAULTS[k]);
  }
  if (typeof raw.followCpu === 'boolean') out.followCpu = raw.followCpu;
  if (typeof raw.sound === 'boolean') out.sound = raw.sound;
  return out;
}

class Config {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
    this.lastError = null;
  }

  load() {
    try {
      const text = fs.readFileSync(this.file, 'utf8');
      this.data = sanitize(JSON.parse(text));
    } catch (e) {
      // 文件不存在是正常情况（首次启动）；解析失败则备份一份坏文件方便排查，
      // 然后照常使用默认值。
      if (e && e.code !== 'ENOENT') {
        this.lastError = String(e.message || e);
        try {
          fs.copyFileSync(this.file, this.file + '.bad');
        } catch (_) {}
      }
      this.data = { ...DEFAULTS };
    }
    return this.data;
  }

  get(key) {
    return this.data[key];
  }

  /** 批量更新并落盘；返回是否写成功 */
  set(patch) {
    if (!patch || typeof patch !== 'object') return { ok: false, reason: 'bad patch' };
    this.data = sanitize({ ...this.data, ...patch });
    return this.save();
  }

  save() {
    try {
      const dir = path.dirname(this.file);
      if (!dir || dir === this.file) throw new Error('invalid config path');
      fs.mkdirSync(dir, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      // rename 在同一分区上是原子的：要么是旧文件，要么是完整新文件，
      // 不会出现「写了一半」的 JSON。
      fs.renameSync(tmp, this.file);
      return { ok: true };
    } catch (e) {
      this.lastError = String(e && e.message || e);
      return { ok: false, reason: this.lastError };
    }
  }
}

module.exports = { Config, DEFAULTS, sanitize, clampInt };
