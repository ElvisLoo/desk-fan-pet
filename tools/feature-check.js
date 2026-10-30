'use strict';
/**
 * 无界面跑一遍新功能时间线：番茄钟流转、喝水提醒、负载转速。
 * 输出可直接读的时间线，用于发布前确认。
 */
const { PetBrain, MODE } = require('../src/pet-brain');

const ENV = { screenW: 1920, screenH: 1080, petW: 150, petH: 150 };
const b = new PetBrain({ now: 0, focusMs: 25 * 60 * 1000, breakMs: 5 * 60 * 1000, sipIntervalMs: 45 * 60 * 1000 });

const log = [];
let t = 0;
let lastMode = b.mode;
let lastReminder = null;

function step(ms) {
  t += ms;
  const act = b.tick(ms, ENV, t);
  if (b.mode !== lastMode) {
    const tag = b.mode === MODE.FOCUS ? '开始专注' : b.mode === MODE.BREAK ? '专注完成→休息' : '休息结束';
    log.push(`${fmt(t)}  ${tag}`);
    lastMode = b.mode;
  }
  const rk = act.reminder ? act.reminder.kind : null;
  if (rk && rk !== lastReminder) log.push(`${fmt(t)}  提醒：${label(rk)}`);
  lastReminder = rk;
}

const fmt = (ms) => {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const label = (k) => ({ sip: '喝水', 'focus-done': '专注完成', 'break-done': '休息结束' }[k] || k);

// 先开始一轮专注，再推进
b.startFocus(t);
log.push(`${fmt(t)}  开始专注`);
lastMode = b.mode;

// 每 30 秒推进一次，跑满 40 分钟（够走完 专注 25min + 休息 5min）
for (let i = 0; i < 100; i++) step(30000);  // 跑满 50 分钟，覆盖 45 分钟的喝水提醒

// 负载转速
const spinAt = (load) => { const x = new PetBrain({ now: 0 }); x.setLoad(load, 5000); return x.spin.toFixed(2); };

console.log('== 时间线 ==');
log.forEach((l) => console.log('  ' + l));
console.log('\n== 统计 ==', JSON.stringify(b.stats));
console.log('\n== 负载 → 转速 ==');
console.log('  空闲(0%)   转速', spinAt(0));
console.log('  半载(50%)  转速', spinAt(0.5));
console.log('  满载(100%) 转速', spinAt(1));
