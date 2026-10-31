'use strict';
/** 宠物窗口的 IPC 桥：只暴露白名单方法，不给渲染层任何 Node 能力 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  onFrame: (cb) => ipcRenderer.on('pet:frame', (_e, s) => cb(s)),
  onPat: (cb) => ipcRenderer.on('pet:pat', () => cb()),
  // 系统警报（电量/内存/CPU）：只在越过阈值时发一次，不是每帧
  onAlert: (cb) => ipcRenderer.on('pet:alert', (_e, a) => cb(a)),
  hover: (on) => ipcRenderer.send('pet:hover', !!on),
  click: () => ipcRenderer.invoke('pet:click'),
  dragStart: () => ipcRenderer.invoke('pet:dragStart'),
  dragEnd: (p) => ipcRenderer.invoke('pet:dragEnd', p),
  moveTo: (x, y) => ipcRenderer.send('pet:move', { x, y }),
  state: () => ipcRenderer.invoke('pet:state'),
});
