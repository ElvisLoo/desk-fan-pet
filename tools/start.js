'use strict';
/** 启动器：清掉宿主注入的 ELECTRON_RUN_AS_NODE，否则 Electron 会退化成纯 Node */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const electronBin = require('electron');
const entry = path.resolve(__dirname, '..', 'src', 'main.js');
const logPath = path.resolve(__dirname, '..', 'electron.log');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const fd = fs.openSync(logPath, 'a');
const child = spawn(electronBin, [entry], { stdio: ['ignore', fd, fd], env });
child.on('exit', (code) => process.exit(code === null ? 1 : code));
