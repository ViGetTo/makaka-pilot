import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import browser from './helpers/browser.cjs';
import { classifyRestartProbe, probeFastRestart } from '../lib/probe.mjs';

const evidence = gain => ({ before: { bananas: 1000, wave: 65, bestWave: 64, gear: { dmg: 1 } },
  afterExit: { bananas: 1000 + gain, wave: 65, bestWave: 64, gear: { dmg: 1 } },
  afterRestart: { bananas: 1000 + gain, wave: 65, bestWave: 64, gear: { dmg: 1 } },
  local: { killed: 18, total: 18 },
  reports: [{ wave: 65, reported: 18, counted: gain ? 16 : 0, status: 200 }] });

test('probe conclusions require a positive server balance that persists across restarting the same wave', () => {
  assert.equal(classifyRestartProbe(evidence(400)).verdict, 'paid');
  assert.equal(classifyRestartProbe(evidence(0)).verdict, 'unpaid');
  const rollback = evidence(400); rollback.afterRestart.bananas = 1000;
  assert.equal(classifyRestartProbe(rollback).verdict, 'inconclusive');
  const cleared = evidence(400); cleared.afterExit.bestWave = 65;
  assert.equal(classifyRestartProbe(cleared).verdict, 'inconclusive');
  const upgrade = evidence(400); upgrade.afterRestart.gear.dmg = 2;
  assert.equal(classifyRestartProbe(upgrade).verdict, 'inconclusive');
  const partial = evidence(400); partial.local.killed = 16;
  assert.equal(classifyRestartProbe(partial).verdict, 'inconclusive');
  const failedReport = evidence(0); failedReport.reports[0].status = 409;
  assert.equal(classifyRestartProbe(failedReport).verdict, 'inconclusive');
  const unrelatedGain = evidence(400); unrelatedGain.reports[0].counted = 0;
  assert.equal(classifyRestartProbe(unrelatedGain).verdict, 'inconclusive');
});

for (const killLimit of [4, 0]) test(`probe executes native pause/exit and restart with ${killLimit ? 'paid' : 'unpaid'} fixture replies`, async () => {
  const b = browser({ killLimit });
  let driving = false;
  const driver = setInterval(async () => {
    if (driving) return;
    driving = true;
    try {
      await b.advance(100);
      if (b.pilot.status().config.mode === 'maximum' && b.engine.wave) b.engine.killed = b.engine.wave.cats.length;
    } finally { driving = false; }
  }, 2);
  const page = { evaluate(fn, arg) {
    return vm.runInNewContext(`(${fn.toString()})(${JSON.stringify(arg)})`, b.context);
  } };
  try {
    const result = await probeFastRestart(page);
    assert.equal(result.verdict, killLimit ? 'paid' : 'unpaid');
    assert.equal(result.gain, killLimit * 10);
    assert.equal(result.before.wave, result.afterRestart.wave);
    assert.equal(result.local.killed, 4);
    assert.equal(result.reports.at(-1).reported, 4);
    assert.equal(result.reports.at(-1).counted, killLimit);
    const firstExit = b.sent.findIndex(r => r.path.endsWith('/fail'));
    const firstFullReport = b.sent.findIndex(r => r.path.endsWith('/kills') && r.body.kills === 4);
    assert.ok(firstFullReport >= 0 && firstFullReport < firstExit, 'the full native report must arrive before battle cancellation');
    assert.equal(b.sent.filter(r => r.path.endsWith('/start')).length, 2);
    assert.equal(b.sent.filter(r => r.path.endsWith('/fail')).length, 2);
    assert.equal(b.sent.some(r => r.path.endsWith('/clear') || r.path.includes('/mine/') || r.path === '/api/upgrade'), false);
    assert.equal(b.pilot.status().active, false);
    assert.equal(b.engine.phase, 'idle');
  } finally { clearInterval(driver); }
});
