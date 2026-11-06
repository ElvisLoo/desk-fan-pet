'use strict';
/**
 * diary-store.js — 日记的磁盘存储（桌面端专用）
 *
 * 与 diary.js 的分工：
 *   diary.js        纯逻辑，不碰文件系统，可以在任何环境跑单测
 *   diary-store.js  只负责读写文件，逻辑全部委托给 diary.js
 *
 * 写盘策略与 config.js 一致：
 *   写临时文件 → rename 覆盖。同一分区上 rename 是原子的，
 *   断电或崩溃时要么是旧文件、要么是完整新文件，不会出现半个 JSON。
 *
 * 写盘节流：宠物被摸一下就要落盘一次，太频繁。
 * 内存里立刻更新，磁盘最多每 5 秒同步一次；
 * 退出前调用 flush() 保证不丢。
 */

const fs = require('fs');
const path = require('path');
const diary = require('./diary.js');

const FLUSH_INTERVAL_MS = 5000;

class DiaryStore {
  constructor(file, opts = {}) {
    this.file = file;
    this.data = {};
    this.lastError = null;
    this._dirty = false;
    this._lastFlush = 0;
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.flushIntervalMs = Number.isFinite(opts.flushIntervalMs)
      ? opts.flushIntervalMs
      : FLUSH_INTERVAL_MS;
  }

  load() {
    try {
      const text = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(text);
      this.data = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (e) {
      // 文件不存在是首次启动；解析失败则备份坏文件，方便用户发给我们排查
      if (e && e.code !== 'ENOENT') {
        this.lastError = String(e.message || e);
        try { fs.copyFileSync(this.file, this.file + '.bad'); } catch (_) {}
      }
      this.data = {};
    }
    this.data = diary.prune(this.data, this._now());
    // 用加载时刻作为节流起点：否则 _lastFlush 还是 0，
    // 第一次 bump 时 now-0 必然超过间隔，等于没有节流
    this._lastFlush = this._now();
    return this.data;
  }

  /** 记一次事件。内存立刻生效，磁盘按节流写。 */
  bump(field, amount, atTs) {
    const ts = Number.isFinite(atTs) ? atTs : this._now();
    const day = diary.bump(this.data, ts, field, amount);
    if (day) {
      this._dirty = true;
      this._maybeFlush();
    }
    return day;
  }

  /** 记一段专注时长 */
  addFocus(ms, atTs) {
    const ts = Number.isFinite(atTs) ? atTs : this._now();
    const day = diary.addFocusMs(this.data, ts, ms);
    if (day) {
      this._dirty = true;
      this._maybeFlush();
    }
    return day;
  }

  _maybeFlush() {
    const now = this._now();
    if (now - this._lastFlush >= this.flushIntervalMs) this.flush(now);
  }

  /** 立即落盘 */
  flush(atTs) {
    this._lastFlush = Number.isFinite(atTs) ? atTs : this._now();
    if (!this._dirty) return { ok: true, skipped: true };

    try {
      const dir = path.dirname(this.file);
      if (!dir || dir === this.file) throw new Error('invalid diary path');
      fs.mkdirSync(dir, { recursive: true });

      // 顺手剪枝：不希望在文件里无限堆老数据
      this.data = diary.prune(this.data, this._lastFlush);

      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
      this._dirty = false;
      return { ok: true };
    } catch (e) {
      this.lastError = String((e && e.message) || e);
      return { ok: false, reason: this.lastError };
    }
  }

  /** 今日小结 */
  todayLine() {
    return diary.todayLine(this.data, this._now());
  }

  /** 最近 7 天小结 */
  weekLine() {
    return diary.weekLine(this.data, this._now());
  }

  /** 结构化汇总，给托盘菜单/界面用 */
  summary() {
    const now = this._now();
    const today = diary.dayKey(now);
    const t = diary.keyToTs(today);
    const monthStart = isNaN(t) ? now : new Date(new Date(t).getFullYear(), new Date(t).getMonth(), 1).getTime();
    return {
      today: diary.cleanDay(this.data[today]),
      month: diary.summarize(this.data, monthStart, now),
      streak: diary.streakDays(this.data, now),
      todayLine: this.todayLine(),
      weekLine: this.weekLine(),
    };
  }
}

module.exports = { DiaryStore, FLUSH_INTERVAL_MS };
