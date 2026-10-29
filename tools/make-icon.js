'use strict';
/** 把代码绘制的图标导出成 PNG，供 electron-builder 打进安装包 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { draw } = require('../src/pet-icon');

app.whenReady().then(() => {
  const out = path.resolve(__dirname, '..', 'assets');
  fs.mkdirSync(out, { recursive: true });
  for (const s of [16, 32, 48, 64, 128, 256, 512]) {
    fs.writeFileSync(path.join(out, `icon-${s}.png`), draw(s).toPNG());
  }
  console.log('icons written to', out);
  app.exit(0);
});
