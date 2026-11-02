import { resolve } from 'node:path';
import { acquireRuntime } from '../../lib/runtime.mjs';

const runtime = await acquireRuntime({ stateDir: process.argv[2], script: resolve('run.mjs'),
  initialStatus: { active: false, checkedAt: new Date().toISOString() } });
await runtime.saveStatus({ active: true, checkedAt: new Date().toISOString(),
  battle: { wave: 69, killed: 14, total: 18 }, incomePerMinute: 46532 });
console.log('ready');
