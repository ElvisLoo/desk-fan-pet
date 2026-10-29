'use strict';
/** 离屏加载宠物界面并截图，验证 CSS/HTML 渲染是否正常 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
setTimeout(() => { console.log('timeout'); app.exit(2); }, 25000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 150, height: 150, show: false, frame: false,
    backgroundColor: '#334155',
    webPreferences: { preload: path.resolve(__dirname, '..', 'src', 'preload.js'), contextIsolation: true },
  });
  await win.loadFile(path.resolve(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 900));

  const report = await win.webContents.executeJavaScript(`(() => {
    const pet = document.getElementById('pet');
    const blades = document.querySelectorAll('.blades i').length;
    const eyes = document.querySelectorAll('.eye').length;
    const cs = getComputedStyle(document.querySelector('.cage'));
    return {
      state: pet.dataset.state,
      blades, eyes,
      cageBg: cs.backgroundImage.slice(0, 40),
      bodyH: document.querySelector('.body').getBoundingClientRect().height,
    };
  })()`).catch((e) => ({ error: String(e) }));

  console.log(JSON.stringify(report));
  fs.writeFileSync(path.resolve(__dirname, '..', 'pet-shot.png'), (await win.capturePage()).toPNG());
  console.log('saved pet-shot.png');
  app.exit(0);
});
