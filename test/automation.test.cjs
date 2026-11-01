const { test } = require('node:test');
const assert = require('node:assert/strict');
const browser = require('./helpers/browser.cjs');
const ticks = async (b, count = 5) => { for (let i = 0; i < count; i++) await b.advance(); };

test('auto starts passing waves immediately with native damage and does not stop at old bank targets', async () => {
  const b = browser();
  await b.enterPush({ farmTarget: 1, targetWave: 60 });
  const s = b.pilot.status();
  assert.equal(s.active, true); assert.equal(s.automation.stage, 'push');
  assert.equal(s.automation.combatMode, 'survival'); assert.equal(s.automation.attempts, 1);
  assert.equal(s.stats.farmCycles, 0);
  assert.equal(b.sent.some(r => r.path === '/api/upgrade'), false, 'an affordable critical upgrade must not replace saving for damage');
});

test('a rejected wave farms for three minutes, finishes its prefix and retries without reviving the old clear', async () => {
  const b = browser(); await b.enterPush();
  let oldResolved = false;
  const { promise } = await b.clear(); promise.then(() => { oldResolved = true; });
  await b.flush(); await ticks(b);
  let s = b.pilot.status();
  assert.equal(s.active, true); assert.equal(s.automation.stage, 'farm');
  assert.equal(s.automation.history.at(-1).result, 'too_fast');
  assert.equal(s.server.bestWave, 64); assert.equal(oldResolved, false);
  assert.equal(b.sent.filter(r => r.path.endsWith('/clear')).length, 1);
  const untilRetry = s.automation.nextAttemptAt - b.context.Date.now();
  await b.advance(untilRetry - 100);
  assert.equal(b.pilot.status().automation.stage, 'farm');
  await b.advance();
  assert.equal(b.pilot.status().automation.stage, 'prepare');
  assert.equal(b.pilot.status().automation.combatMode, 'farmer');
  b.engine.killed = 2; await ticks(b);
  s = b.pilot.status();
  assert.equal(s.automation.stage, 'push'); assert.equal(s.automation.attempts, 2);
  assert.equal(s.stats.farmCycles, 1); assert.equal(oldResolved, false);
  assert.equal(b.sent.filter(r => r.path.endsWith('/clear')).length, 1);
});

test('accepted waves start the next wave immediately and continue passing without a farming cooldown', async () => {
  const b = browser({ clearAccepted: true }); await b.enterPush();
  for (const wave of [65, 66]) {
    const { promise } = await b.clear(); await promise; await b.flush();
    assert.equal(b.pilot.status().server.bestWave, wave);
    assert.equal(b.pilot.status().automation.stage, 'prepare');
    await b.advance(); await b.advance(2800);
    assert.equal(b.pilot.status().automation.stage, 'push');
    assert.equal(b.pilot.status().battle.wave, wave + 1);
    assert.equal(b.pilot.status().automation.nextAttemptSeconds, null);
  }
  const s = b.pilot.status();
  assert.equal(s.automation.attempts, 3); assert.equal(s.stats.farmCycles, 0);
  assert.equal(b.sent.some(r => r.path.endsWith('/fail')), false);
});

test('a damage rejection also parks the native clear and falls back to farming immediately', async () => {
  const b = browser({ clearError: 'damage_too_low', clearStatus: 400 }); await b.enterPush();
  const { promise } = await b.clear(); let resolved = false; promise.then(() => { resolved = true; });
  await b.flush(); await ticks(b);
  const s = b.pilot.status();
  assert.equal(s.automation.stage, 'farm'); assert.equal(s.automation.history.at(-1).result, 'damage_too_low');
  assert.equal(s.active, true); assert.equal(resolved, false);
  assert.ok(s.automation.nextAttemptSeconds >= 179);
  assert.equal(b.sent.filter(r => r.path.endsWith('/clear')).length, 1);
});

test('a delayed accepted clear is not cancelled by a simultaneous timeout retreat', async () => {
  const b = browser({ clearAccepted: true, holdClear: true }); await b.enterPush();
  const { promise } = await b.clear(); await b.flush();
  assert.equal(b.pilot.status().clearInFlight, 1);
  await b.advance(90000);
  assert.equal(b.pilot.status().automation.stage, 'retreat');
  assert.equal(b.sent.some(r => r.path.endsWith('/fail')), false);
  b.releaseClear(); await promise; await b.flush();
  const s = b.pilot.status();
  assert.equal(s.automation.stage, 'prepare'); assert.equal(s.active, true);
  assert.equal(s.server.bestWave, 65);
  assert.equal(s.automation.history.at(-1).result, 'cleared');
  assert.equal(b.sent.some(r => r.path.endsWith('/fail')), false);
});

test('missing kill confirmation returns to farming after ninety seconds instead of hanging for fifteen minutes', async () => {
  const b = browser({ killLimit: 1 }); await b.enterPush();
  const { promise } = await b.clear(); let resolved = false; promise.then(() => { resolved = true; });
  await b.advance(90000); await ticks(b);
  const s = b.pilot.status();
  assert.equal(s.active, true); assert.equal(s.automation.stage, 'farm');
  assert.equal(s.automation.history.at(-1).result, 'timeout');
  assert.equal(s.server.bestWave, 64); assert.equal(resolved, false);
  assert.equal(b.sent.some(r => r.path.endsWith('/fail')), true);
  assert.equal(b.sent.some(r => r.path.endsWith('/clear')), false);
});

test('damage is purchased repeatedly as soon as affordable, including during combat and with obsolete disabled settings', async () => {
  const b = browser({ damageCost: 100, bananas: 1000 });
  b.start({ autoUpgrade: false, reserve: 1000000 });
  await b.advance(); await b.advance(1100);
  assert.equal(b.pilot.status().automation.stage, 'push');
  await b.advance(1200); await b.advance(1200); await b.advance(1200);
  let purchases = b.sent.filter(r => r.path === '/api/upgrade');
  assert.equal(purchases.length, 3); assert.ok(purchases.every(r => r.body.kind === 'dmg'));
  let s = b.pilot.status();
  assert.equal(s.server.bananas, 300); assert.equal(s.server.upgrades.dmg.level, 4);
  assert.equal(s.stats.spent, 700); assert.equal(s.stats.damageUpgrades, 3);
  assert.equal(s.config.autoUpgrade, true); assert.equal(s.config.reserve, 0);
  await b.earn(500); await b.advance(1200);
  s = b.pilot.status(); purchases = b.sent.filter(r => r.path === '/api/upgrade');
  assert.equal(purchases.length, 4); assert.equal(s.server.bananas, 0);
  assert.equal(s.stats.spent, 1500);
});

test('saving for damage continues during farming and a funded upgrade does not wait for the next attempt', async () => {
  const b = browser(); await b.enterPush();
  await b.clear(); await b.flush(); await ticks(b);
  assert.equal(b.pilot.status().automation.stage, 'farm');
  await b.earn(2000000); await b.advance(1200);
  assert.equal(b.sent.filter(r => r.path === '/api/upgrade').length, 1);
  assert.equal(b.pilot.status().automation.stage, 'farm');
  assert.equal(b.pilot.status().stats.damageUpgrades, 1);
});

test('a farming confirmation timeout does not postpone the scheduled progression retry', async () => {
  const b = browser({ killLimit: 1 }); await b.enterPush();
  await b.clear(); await b.advance(90000); await ticks(b);
  const deadline = b.pilot.status().automation.nextAttemptAt;
  b.engine.killed = 2; await b.advance();
  await b.advance(30000); await ticks(b);
  assert.equal(b.pilot.status().automation.nextAttemptAt, deadline);
  assert.equal(b.pilot.status().active, true);
});

test('manual stop stays stopped and a finite session deadline spans passing and farming stages', async () => {
  const b = browser(); await b.enterPush(); b.pilot.stop();
  const requests = b.sent.length; await b.advance(180000);
  assert.equal(b.pilot.status().active, false); assert.equal(b.sent.length, requests);
  const timed = browser(); timed.start({ sessionMinutes: 4 }); await timed.advance();
  await timed.advance(90000); await ticks(timed);
  assert.equal(timed.pilot.status().automation.stage, 'farm');
  await timed.advance(150000); assert.equal(timed.pilot.status().active, false);
});
