'use strict';
/** 清 ELECTRON_RUN_AS_NODE 后跑 make-icon，导出图标 PNG */
const { spawn } = require('child_process');
const path = require('path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const c = spawn(require('electron'), [path.resolve(__dirname, 'make-icon.js')], { stdio: 'inherit', env });
c.on('exit', (code) => process.exit(code === null ? 1 : code));
