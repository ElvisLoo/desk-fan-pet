'use strict';
/** 打包入口：spawn 指定 cwd 调 electron-builder，绕开 Windows 下 cd && 相对路径的问题 */
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const r = spawnSync(process.execPath, [cli, '--win', '--x64'], { cwd: root, stdio: 'inherit', env });
process.exit(r.status == null ? 1 : r.status);
