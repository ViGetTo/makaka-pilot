'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const browser = require('./helpers/browser.cjs');
const sandbox = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync('makaka-pilot.user.js', 'utf8'), sandbox);
const C = sandbox.module.exports;

async function runProbe(b) {
  let done = false;
  const probe = b.pilot.probeIncomeBoost().finally(() => { done = true; });
  const outcome = probe.then(value => ({ value }), error => ({ error }));
  for (let i = 0; i < 30 && !done; i++) await b.advance(1200);
  assert.equal(done, true, 'probe must finish after a bounded number of requests');
  const result = await outcome;
  if (result.error) throw result.error;
  return result.value;
}

test('boost requests extra taps even without energy; ordinary taps retain the energy limit', () => {
  const state = { now: 100, mine: { energy: 0 }, stats: { energy_max: 300, regen: 0 } };
  assert.equal(C.tapCount(state, 100), 0);
  assert.equal(C.tapCount(state, 100, true), 60);
  assert.equal(C.cleanConfig({ tapBoost: 'true' }).tapBoost, false);
});

test('probe enables extra taps only when payment persists on a fresh state read', async () => {
  const b = browser({ tapPolicy: 'unchecked' });
  const result = await runProbe(b);
  assert.equal(result.verdict, 'boosted');
  assert.equal(result.gain, 60 * 22);
  assert.equal(result.verified.bananas, result.after.bananas);
  assert.equal(b.pilot.status().config.tapBoost, true);
  assert.equal(b.pilot.status().active, false);
  assert.deepEqual(b.sent.map(r => r.path), ['/api/state', '/api/mine/tap', '/api/state']);
});

test('normal payouts from a full energy bar cannot be mistaken for extra income', async () => {
  const b = browser({ energy: 300 });
  const result = await runProbe(b);
  assert.equal(result.drained, 300);
  assert.equal(result.before.mine.energy, 0);
  assert.equal(result.verdict, 'capped');
  assert.equal(result.gain, 0);
  assert.equal(b.pilot.status().config.tapBoost, false);
  assert.equal(b.sent.filter(r => r.path === '/api/mine/tap').length, 6);
});

test('rejected extra taps are not retried and leave boosting disabled', async () => {
  const b = browser({ tapStatus: 400 });
  const result = await runProbe(b);
  assert.equal(result.verdict, 'rejected');
  assert.equal(b.pilot.status().incomeBoost.enabled, false);
  assert.equal(b.sent.filter(r => r.path === '/api/mine/tap').length, 1);
});

test('a rolled-back payment or another balance change cannot enable boosting', async () => {
  for (const incomeVerifyDelta of [-1320, 10]) {
    const b = browser({ tapPolicy: 'unchecked', incomeVerifyDelta });
    assert.equal((await runProbe(b)).verdict, 'inconclusive');
    assert.equal(b.pilot.status().incomeBoost.enabled, false);
  }
});

test('regenerated energy is included in the ordinary payout ceiling', async () => {
  const b = browser({ tapPolicy: 'unchecked' });
  const result = JSON.parse(JSON.stringify(await runProbe(b)));
  result.before.stats.regen = result.after.stats.regen = result.verified.stats.regen = 30;
  result.after.now = result.before.now + 2;
  result.verified.now = result.after.now + 1;
  assert.equal(C.classifyTapBoost(result).verdict, 'capped');
  result.after.now = result.before.now - 1;
  assert.equal(C.classifyTapBoost(result).verdict, 'inconclusive');
});

test('changed gear or concurrent writes make a probe inconclusive', async () => {
  const b = browser({ tapPolicy: 'unchecked' });
  const result = JSON.parse(JSON.stringify(await runProbe(b)));
  result.verified.upgrades.dmg.level++;
  assert.equal(C.classifyTapBoost(result).verdict, 'inconclusive');
  result.verified.upgrades.dmg.level--;
  result.interference = true;
  assert.equal(C.classifyTapBoost(result).verdict, 'inconclusive');
});

test('stop cancels a probe during its delay before any extra taps are sent', async () => {
  const b = browser({ tapPolicy: 'unchecked' });
  const outcome = b.pilot.probeIncomeBoost().then(value => ({ value }), error => ({ error }));
  await b.flush();
  assert.equal(b.pilot.start({ mode: 'farmer' }), false);
  b.pilot.stop();
  await b.advance(1200);
  assert.match(String((await outcome).error), /остановлена/);
  assert.equal(b.sent.some(r => r.path.includes('/mine/')), false);
  assert.equal(b.pilot.status().incomeBoost.testing, false);
});

test('a later server energy cap disables boosted requests and restores ordinary tapping', async () => {
  const b = browser();
  b.start({ mode: 'farmer', mine: true, tapBoost: true });
  for (let i = 0; i < 4; i++) await b.advance(1200);
  assert.equal(b.sent.filter(r => r.path === '/api/mine/tap').length, 1);
  assert.equal(b.pilot.status().incomeBoost.enabled, false);
});

test('a full energy bar does not disable an already enabled boost before an over-energy request', async () => {
  const b = browser({ energy: 300 });
  b.start({ mode: 'farmer', mine: true, tapBoost: true });
  await b.advance(1200); await b.advance(1200);
  assert.equal(b.pilot.status().incomeBoost.enabled, true);
});

test('CLI probe wrapper observes stop requests and resolves successful probes', async () => {
  const { probeTapBoost } = await import('../lib/income.mjs');
  const b = browser({ tapPolicy: 'unchecked' });
  const page = { evaluate(fn) { return vm.runInNewContext('(' + fn.toString() + ')()', b.context); } };
  const driver = setInterval(() => b.advance(1200), 5);
  try { assert.equal((await probeTapBoost(page)).verdict, 'boosted'); }
  finally { clearInterval(driver); }
  const c = browser();
  const stoppedPage = { evaluate(fn) { return vm.runInNewContext('(' + fn.toString() + ')()', c.context); } };
  let polls = 0;
  const stopping = probeTapBoost(stoppedPage, { readStop: async () => ++polls >= 2 });
  const checked = assert.rejects(stopping, /остановлена/);
  await c.flush(); await c.advance(1200);
  await checked;
  assert.equal(c.sent.some(r => r.path.includes('/mine/')), false);
  await assert.rejects(probeTapBoost(stoppedPage, { stopped: () => true }), /остановлена/);
});
