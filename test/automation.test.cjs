const { test } = require('node:test');
const assert = require('node:assert/strict');
const browser = require('./helpers/browser.cjs');

test('auto farms first, finishes a confirmed prefix, and only then attempts a wave after three minutes', async () => {
  const b = browser();
  b.start({ farmTarget: 1, targetWave: 60 });
  await b.advance(179900);
  assert.equal(b.pilot.status().active, true);
  assert.equal(b.pilot.status().automation.stage, 'farm');
  assert.equal(b.sent.some(r => r.path === '/api/upgrade'), false);
  await b.advance();
  assert.equal(b.pilot.status().automation.stage, 'prepare');
  assert.equal(b.pilot.status().automation.combatMode, 'farmer');
  b.engine.killed = 2;
  for (let i = 0; i < 5; i++) await b.advance();
  const s = b.pilot.status();
  assert.equal(s.automation.stage, 'push'); assert.equal(s.automation.attempts, 1);
  assert.equal(s.automation.combatMode, 'paced'); assert.equal(s.active, true);
  assert.equal(s.stats.farmCycles, 1);
  assert.equal(b.sent.filter(r => r.path.endsWith('/start')).length, 2);
});

test('a server rejection cancels the old clear and resumes farming without stopping the runner', async () => {
  const b = browser(); await b.enterPush();
  let oldResolved = false;
  const { promise } = await b.clear(); promise.then(() => { oldResolved = true; });
  assert.equal(b.sent.filter(r => r.path.endsWith('/clear')).length, 0, 'clear must honor the real-time gate');
  await b.advance(11000);
  for (let i = 0; i < 4; i++) await b.advance();
  let s = b.pilot.status();
  assert.equal(s.active, true); assert.equal(s.automation.stage, 'farm');
  assert.equal(s.automation.history.at(-1).result, 'too_fast');
  assert.equal(s.server.bestWave, 64); assert.equal(oldResolved, false);
  assert.equal(b.sent.filter(r => r.path.endsWith('/clear')).length, 1);
  await b.advance(s.automation.nextAttemptSeconds * 1000 - 1000);
  s = b.pilot.status();
  assert.equal(s.automation.stage, 'farm'); assert.equal(s.automation.attempts, 1);
  b.engine.killed = 2;
  for (let i = 0; i < 5; i++) await b.advance();
  await b.advance(1000);
  for (let i = 0; i < 5; i++) await b.advance();
  assert.equal(b.pilot.status().automation.attempts, 2);
  assert.equal(oldResolved, false, 'an old clear must not resolve against the restarted wave');
  assert.equal(b.sent.filter(r => r.path.endsWith('/clear')).length, 1);
});

test('an accepted wave returns to farming the next wave and keeps the three-minute schedule', async () => {
  const b = browser({ clearAccepted: true }); await b.enterPush();
  const nextAttempt = b.pilot.status().automation.nextAttemptAt;
  const { promise } = await b.clear();
  await b.advance(11000); await promise; await b.flush();
  const s = b.pilot.status();
  assert.equal(s.active, true); assert.equal(s.server.bestWave, 65);
  assert.equal(s.automation.stage, 'farm'); assert.equal(s.automation.combatMode, 'farmer');
  assert.equal(s.automation.nextAttemptAt, nextAttempt);
  assert.equal(s.automation.history.at(-1).result, 'cleared');
});

test('a clear already in flight is allowed to finish before any exit and a delayed success resumes farming', async () => {
  const b = browser({ clearAccepted: true, holdClear: true }); await b.enterPush();
  const { promise } = await b.clear(); await b.advance(11000);
  assert.equal(b.pilot.status().clearInFlight, 1);
  await b.advance(90000);
  assert.equal(b.pilot.status().automation.stage, 'retreat');
  assert.equal(b.sent.some(r => r.path.endsWith('/fail')), false);
  b.releaseClear(); await promise; await b.flush();
  const s = b.pilot.status();
  assert.equal(s.automation.stage, 'farm'); assert.equal(s.active, true);
  assert.equal(s.server.bestWave, 65);
  assert.equal(s.automation.history.at(-1).result, 'cleared');
  assert.equal(b.sent.some(r => r.path.endsWith('/fail')), false);
});

test('missing kill confirmation cannot trap a locally cleared attempt for fifteen minutes', async () => {
  const b = browser({ killLimit: 1 }); await b.enterPush();
  const { promise } = await b.clear(); let resolved = false; promise.then(() => { resolved = true; });
  await b.advance(90000);
  for (let i = 0; i < 4; i++) await b.advance();
  const s = b.pilot.status();
  assert.equal(s.active, true); assert.equal(s.automation.stage, 'farm');
  assert.equal(s.automation.history.at(-1).result, 'timeout');
  assert.equal(s.server.bestWave, 64); assert.equal(resolved, false);
  assert.equal(b.sent.some(r => r.path.endsWith('/fail')), true);
  assert.equal(b.sent.some(r => r.path.endsWith('/clear')), false);
});

test('one affordable upgrade is bought per attempt and the reserve is honored', async () => {
  const b = browser(); await b.enterPush({ autoUpgrade: true });
  assert.equal(b.sent.filter(r => r.path === '/api/upgrade').length, 1);
  for (let i = 0; i < 4; i++) await b.advance();
  assert.equal(b.sent.filter(r => r.path === '/api/upgrade').length, 1);
  assert.equal(b.pilot.status().stats.spent, 100);
  const reserved = browser(); await reserved.enterPush({ autoUpgrade: true, reserve: 1000000 });
  assert.equal(reserved.sent.filter(r => r.path === '/api/upgrade').length, 0);
  assert.equal(reserved.pilot.status().automation.stage, 'push');
});

test('manual stop stays stopped and a configured session deadline spans all automatic stages', async () => {
  const b = browser(); await b.enterPush(); b.pilot.stop();
  const requests = b.sent.length; await b.advance(180000);
  assert.equal(b.pilot.status().active, false); assert.equal(b.sent.length, requests);
  const timed = browser(); timed.start({ sessionMinutes: 4 });
  await timed.advance(180000); assert.equal(timed.pilot.status().automation.stage, 'push');
  await timed.advance(60000); assert.equal(timed.pilot.status().active, false);
});
