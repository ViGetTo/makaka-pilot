import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { rankFarmSamples, tuneFarm } from '../lib/tuning.mjs';

test('farm tuning chooses server income per real elapsed minute, not the largest payout', () => {
  const ranked = rankFarmSamples([
    { kills: 16, gain: 58000, seconds: 80, cycles: 2 },
    { kills: 8, gain: 29000, seconds: 35, cycles: 2 },
    { kills: 4, gain: 14000, seconds: 20, cycles: 2 },
  ]);
  assert.equal(ranked[0].kills, 8);
  assert.equal(ranked[0].perMinute, 29000 / 35 * 60);
});

test('farm tuning rejects losses, invalid timings and incomplete samples', () => {
  assert.equal(rankFarmSamples([
    { gain: -100, seconds: 10, cycles: 2 }, { gain: 100, seconds: 0, cycles: 2 },
    { gain: 100, seconds: NaN, cycles: 2 }, { gain: 100, seconds: 10, cycles: 1 },
  ]).length, 0);
});

test('live tuning aborts if equipment changes during a sample instead of saving misleading income', async () => {
  let tick;
  const state = { active: false, stats: { farmCycles: 0 }, config: {},
    server: { wave: 64, bananas: 100, upgrades: { dmg: { level: 25 } } } };
  const context = { Date, JSON, Object,
    window: { MakakaPilot: {
      status: () => structuredClone(state),
      start(options) { state.active = true; state.config = options; return true; },
      stop(reason) { state.active = false; state.message = reason; },
    } },
    setInterval(fn) { tick = fn; return 1; }, clearInterval() {},
  };
  const page = { async evaluate(fn, arg) {
    if (arg === undefined && tick) { state.server.upgrades.dmg.level++; tick(); tick = null; }
    return vm.runInNewContext(`(${fn.toString()})(${JSON.stringify(arg)})`, context);
  } };
  await assert.rejects(tuneFarm(page, { stopped: () => false, readStop: async () => false, log() {} }), /изменились снаряжение/);
  assert.equal(state.active, false);
});
