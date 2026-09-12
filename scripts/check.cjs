'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
for (const folder of ['scripts', 'tests']) {
  for (const filename of fs.readdirSync(path.join(__dirname, '..', folder)).filter(p => p.endsWith('.cjs'))) {
    const result = spawnSync(process.execPath, ['--check', path.join(__dirname, '..', folder, filename)], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
