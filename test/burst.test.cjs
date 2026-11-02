const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const browser = require('./helpers/browser.cjs');
const context = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync('makaka-pilot.user.js', 'utf8'), context);
const core = context.module.exports;
const flush = async b => { for (let i = 0; i < 4; i++) await b.flush(); };

test('the elite candidate uses the actual wave rewards and exposes the spawn-time estimate as a hypothesis', () => {
  const wave = { gap: 1.6, cats: Array.from({ length: 18 }, (_, i) => ({
    kind: i === 3 ? 'elite' : 'cat', reward: i === 3 ? 4746 : 1582 })) };
  const plan = core.eliteFarmCandidate(wave);
  assert.equal(plan.kills, 4); assert.equal(plan.reward, 9492);
  assert.equal(plan.spawnSeconds, 5.3);
  assert.equal(core.farmReportAt(wave, 4, 1000), 6360);
  assert.equal(core.eliteFarmCandidate({ ...wave, cats: [{ kind: 'boss', reward: 90000 }] }), null);
});

test('timed farming reports at the predicted boundary and restarts only after genuine acknowledgement', async () => {
  const b = browser();
  b.start({ mode: 'farmer', farmTiming: 'spawn', farmKills: 2, farmCycleLimit: 2 });
  await b.advance(); b.engine.killed = 2; await b.advance();
  const deadline = core.farmReportAt(b.engine.wave, 2, b.pilot.status().currentTrial.requestedAt);
  await b.advance(deadline - b.context.Date.now() - 1);
  assert.equal(b.sent.some(r => r.path.endsWith('/kills')), false);
  await b.advance(1); await flush(b);
  assert.equal(b.pilot.status().stats.farmCycles, 1);
  assert.equal(b.sent.filter(r => r.path.endsWith('/start')).length, 2);
  assert.equal(b.pilot.status().active, true);
  b.engine.killed = 2; await b.advance();
  const second = core.farmReportAt(b.engine.wave, 2, b.pilot.status().currentTrial.requestedAt);
  await b.advance(second - b.context.Date.now()); await flush(b);
  assert.equal(b.pilot.status().session.completed, true);
  assert.equal(b.pilot.status().session.cycles, 2);
  assert.equal(b.pilot.status().active, false);
  assert.equal(b.engine.phase, 'idle');
  assert.equal(b.sent.filter(r => r.path.endsWith('/start')).length, 2);
  assert.equal(b.sent.filter(r => r.path.endsWith('/fail')).length, 2);
});

test('partial acknowledgement never triggers the fast exit or another wave', async () => {
  const b = browser({ killLimit: 1 });
  b.start({ mode: 'farmer', farmTiming: 'spawn', farmKills: 2 });
  await b.advance(); b.engine.killed = 2; await b.advance(2300); await flush(b);
  assert.equal(b.pilot.status().serverKills.counted, 1);
  assert.equal(b.pilot.status().stats.farmCycles, 0);
  assert.equal(b.sent.some(r => r.path.endsWith('/fail')), false);
  b.pilot.stop();
});

test('manual stop cancels the scheduled report and cannot restart farming', async () => {
  const b = browser();
  b.start({ mode: 'farmer', farmTiming: 'spawn', farmKills: 2 });
  await b.advance(); b.engine.killed = 2; await b.advance(); b.pilot.stop();
  const count = b.sent.length; await b.advance(10000); await flush(b);
  assert.equal(b.sent.length, count); assert.equal(b.pilot.status().active, false);
});

test('a failed native exit stops the fast farmer instead of starting over uncertain state', async () => {
  const b = browser({ failStatus: 500 });
  b.start({ mode: 'farmer', farmTiming: 'spawn', farmKills: 2 });
  await b.advance(); b.engine.killed = 2; await b.advance(2300); await flush(b);
  assert.equal(b.pilot.status().active, false);
  assert.equal(b.pilot.status().session.completed, false);
  assert.equal(b.sent.filter(r => r.path.endsWith('/start')).length, 1);
});

test('stopping during an in-flight native exit cannot resurrect the farmer after the reply', async () => {
  const b = browser({ holdFail: true });
  b.start({ mode: 'farmer', farmTiming: 'spawn', farmKills: 2 });
  await b.advance(); b.engine.killed = 2; await b.advance(2300); await flush(b);
  assert.equal(b.pilot.status().transitioning, true);
  b.pilot.stop(); b.releaseFail(); await flush(b); await b.advance(5000);
  assert.equal(b.pilot.status().active, false);
  assert.equal(b.sent.filter(r => r.path.endsWith('/start')).length, 1);
});

test('the timed farmer yields to the scheduled three-minute progression attempt', async () => {
  const b = browser(); await b.enterPush({ farmTiming: 'spawn' });
  await b.clear(); await flush(b);
  for (let i = 0; i < 5; i++) await b.advance();
  assert.equal(b.pilot.status().automation.stage, 'farm');
  const due = b.pilot.status().automation.nextAttemptAt;
  b.engine.killed = 2;
  await b.advance(due - b.context.Date.now()); await flush(b);
  for (let i = 0; i < 3; i++) await b.advance();
  assert.equal(b.pilot.status().automation.stage, 'push');
  assert.equal(b.pilot.status().automation.attempts, 2);
  assert.equal(b.pilot.status().automation.combatMode, 'survival');
  b.pilot.stop();
});

test('an unresponsive native exit has a finite timeout and cannot start a replacement battle later', async () => {
  const b = browser({ holdFail: true });
  b.start({ mode: 'farmer', farmTiming: 'spawn', farmKills: 2 });
  await b.advance(); b.engine.killed = 2; await b.advance(2300); await flush(b);
  await b.advance(15000);
  assert.equal(b.pilot.status().active, false);
  b.releaseFail(); await flush(b);
  assert.equal(b.sent.filter(r => r.path.endsWith('/start')).length, 1);
});
