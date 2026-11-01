'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('gear manager farms for one upgrade and restarts before testing the new gear', () => {
  let tick;
  const state = {
    active: true,
    config: { mode: 'paced', gearAuto: true, targetWave: 60, reserve: 0 },
    server: { bestWave: 59, bananas: 80000, upgrades: { dmg: { level: 24, cost: 450000 }, auto: { level: 15, cost: 290000 } } },
    battle: { phase: 'cleared' },
    currentTrial: { gear: { damage: 24, critical: 15 }, attempts: [{ status: 409 }, { status: 409 }] },
  };
  const pilot = {
    status: () => structuredClone(state),
    configure(o) { Object.assign(state.config, o); },
    start() { state.active = true; }, stop() { state.active = false; },
  };
  const source = fs.readFileSync('makaka-pilot.user.js', 'utf8').split('// Coordinate one gear upgrade')[1];
  vm.runInNewContext('// Coordinate one gear upgrade' + source, {
    window: { MakakaPilot: pilot }, document: { querySelectorAll: () => [] },
    Date, setInterval(fn) { tick = fn; return 1; }, clearInterval() {},
  });
  tick(); assert.equal(pilot.gear.status().stage, 'exit');
  assert.equal(pilot.gear.status().plan.kind, 'auto');
  assert.equal(state.active, false);
  state.battle.phase = 'idle'; tick();
  assert.equal(state.config.mode, 'farmer'); assert.equal(state.config.farmTarget, 290000);
  assert.equal(state.active, true);
  state.config.mode = 'paced'; state.server.upgrades.auto.level = 16;
  tick();
  assert.equal(state.config.autoUpgrade, false); assert.equal(state.active, false);
  assert.equal(pilot.gear.status().stage, 'exit_push');
  tick(); assert.equal(pilot.gear.status().stage, 'push');
  assert.equal(state.config.mode, 'paced'); assert.equal(state.active, true);
  tick(); // A failed trial recorded with OLD gear must not trigger another purchase.
  assert.equal(pilot.gear.status().stage, 'push');
  state.currentTrial.gear.critical = 16; tick();
  assert.equal(pilot.gear.status().stage, 'exit');
});
