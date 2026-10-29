'use strict';
/**
 * 无界面地跑一遍宠物大脑的行为序列，输出可读时间线。
 * 用途：打包/发布前确认「走 / 睡 / 醒 / 戳」真的会发生，而不是只有单测断言。
 */
const { PetBrain, STATE } = require('../src/pet-brain');

const ENV = { screenW: 1280, screenH: 760, petW: 150, petH: 150 };
const b = new PetBrain({ now: 0, walkIntervalMs: 12000, sleepAfterMs: 180000, excitedMs: 1600 });
const log = [];
let last = b.state;
let t = 0;

function step(ms) {
  t += ms;
  b.tick(ms, ENV, t);
  if (b.state !== last) {
    log.push(`${String(Math.round(t / 1000)).padStart(5)}s  ${last} → ${b.state}`);
    last = b.state;
  }
}

// 0–15s 待机，应在 12s 后开始走动
for (let i = 0; i < 150; i++) step(100);
// 走路最多 20s
for (let i = 0; i < 200; i++) step(100);
// 静置到 200s，应睡着
for (let i = 0; i < 1000; i++) step(200);
// 摸一下，应醒
b.touch(t);
if (b.state !== last) { log.push(`${String(Math.round(t / 1000)).padStart(5)}s  ${last} → ${b.state}（被摸）`); last = b.state; }
// 点一下，应兴奋
b.click(t);
log.push(`${String(Math.round(t / 1000)).padStart(5)}s  → ${b.state}（被点）`);

console.log('时间线:');
log.forEach((l) => console.log('  ' + l));
console.log('\n统计:', JSON.stringify(b.stats));
const reached = new Set(log.map((l) => l.split('→ ')[1].split('（')[0]));
console.log('到达过的状态:', [...reached].join(', '));
