'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const sandbox = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync('makaka-pilot.user.js', 'utf8'), sandbox);
const C = sandbox.module.exports;

const state = () => ({
  now: 1000, bananas: 100000,
  stats: { dmg: 319, crit: 4.4, crit_chance: .24, hp: 625,
    energy_max: 300, regen: .5, tap: 1, gen: 60,
    next: { dmg: 383, crit: 4.6, crit_chance: .25, hp: 660, tap: 2, gen: 144 } },
  mine: { energy: 8, since: 0 },
  upgrades: { dmg: { cost: 70000 }, auto: { cost: 70000 }, hp: { cost: 24000 },
    tap: { cost: 45 }, gen: { cost: 140 } },
});

test('damage upgrade outranks critical multiplier using actual expected damage', () => {
  assert.equal(C.chooseCombatUpgrade(state()).kind, 'dmg');
});
test('critical chance is included in the upgrade calculation', () => {
  const s = state(); s.stats.next.dmg = 320; s.stats.next.crit_chance = .8;
  assert.equal(C.chooseCombatUpgrade(s).kind, 'auto');
});
test('low health prioritizes a real affordable HP purchase', () => {
  assert.equal(C.chooseCombatUpgrade(state(), .2).kind, 'hp');
  const s = state(); s.bananas = 20000;
  assert.equal(C.chooseCombatUpgrade(s, .2), null);
});
test('reserve and maximum-level upgrades cannot be spent', () => {
  assert.equal(C.chooseCombatUpgrade(state(), 1, 50000), null);
  const s = state(); s.upgrades.dmg.cost = null; s.upgrades.auto.cost = null;
  assert.equal(C.chooseCombatUpgrade(s), null);
});
test('tap batches respect actual energy, regeneration and 60-tap limit', () => {
  const s = state();
  assert.equal(C.tapCount(s, 1000), 8);
  assert.equal(C.tapCount(s, 1020), 18);
  assert.equal(C.tapCount(s, 10000), 60);
  s.mine.energy = 0;
  assert.equal(C.tapCount(s, 1000), 0);
  assert.equal(C.tapCount(s, 1002), 1);
});
test('configuration bounds speed, duration and target', () => {
  const c = C.cleanConfig({ speed: 1e9, mode: 'admin', sessionMinutes: -10, targetWave: -1 });
  assert.equal(c.speed, 8); assert.equal(c.mode, 'farmer');
  assert.equal(c.sessionMinutes, 1); assert.equal(c.targetWave, 0);
});
test('economy only invests in upgrades with short payback', () => {
  assert.equal(C.economyChoice(state()).kind, 'tap');
  const s = state(); s.upgrades.tap.cost = 10000;
  assert.equal(C.economyChoice(s), null);
});

class Engine {
  constructor() {
    this.phase = 'running'; this.time = 0; this.lastShot = -9;
    this.hp = 100; this.cat = { hp: 500, deco: false };
    this.shots = 0; this.taps = 0; this.elapsed = 0;
  }
  update(dt) { this.elapsed += dt; this.time += dt; }
  hurtMonkey(n) { this.hp -= n; }
  damage(cat, n) { cat.hp -= n; }
  frontCats() { return this.cat.hp > 0 ? [this.cat] : []; }
  tap() {
    if (this.time - this.lastShot >= .085) {
      this.taps++; this.lastShot = this.time; this.damage(this.cat, 10);
    }
  }
  shoot() { this.shots++; this.lastShot = this.time; this.damage(this.cat, 10); }
}
const counts = () => ({ blockedDamage: 0, burstShots: 0 });

test('normal mode honors original cooldown and does not accelerate time or protect health', () => {
  const e = new Engine(); const off = C.patchEngine(e, () => ({ mode: 'normal', speed: 8 }), counts());
  e.update(.016); e.update(.016); e.hurtMonkey(20);
  assert.equal(e.taps, 1); assert.equal(e.shots, 0); assert.equal(e.hp, 80);
  assert.equal(e.elapsed, .032); assert.equal(e.cat.hp, 490); off();
});
test('maximum mode advances physics, protects health and kills using the original damage method', () => {
  const e = new Engine(); const c = counts();
  const off = C.patchEngine(e, () => ({ mode: 'maximum', speed: 4 }), c);
  e.update(.025); e.hurtMonkey(20);
  assert.ok(Math.abs(e.elapsed - .1) < 1e-8); assert.equal(e.cat.hp, 0);
  assert.equal(e.hp, 100); assert.equal(c.blockedDamage, 20); assert.equal(e.shots, 1);
  off(); e.hurtMonkey(20); assert.equal(e.hp, 80);
  assert.equal(e.update, Engine.prototype.update);
  assert.equal(e.damage, Engine.prototype.damage);
  assert.equal(e.hurtMonkey, Engine.prototype.hurtMonkey);
});
test('turbo fires faster but retains the real damage per shot', () => {
  const e = new Engine(); const off = C.patchEngine(e, () => ({ mode: 'turbo', speed: 1 }), counts());
  e.update(.05); assert.ok(e.cat.hp > 0 && e.cat.hp < 500); off();
});
test('survival protects health but preserves real damage, cooldown and time', () => {
  const e = new Engine();
  const off = C.patchEngine(e, () => ({ mode: 'survival', speed: 8 }), counts());
  e.update(.016); e.update(.016); e.hurtMonkey(1000);
  assert.equal(e.hp, 100); assert.equal(e.cat.hp, 490);
  assert.equal(e.taps, 1); assert.equal(e.shots, 0); assert.equal(e.elapsed, .032);
  off();
});
test('runtime mode changes and cleanup preserve preexisting own methods', () => {
  const e = new Engine(); e.update = function(dt) { this.time += dt; this.elapsed += dt; };
  const original = e.update; let mode = 'maximum';
  const off = C.patchEngine(e, () => ({ mode, speed: 4 }), counts());
  mode = 'normal'; e.hurtMonkey(10); assert.equal(e.hp, 90);
  off(); assert.equal(e.update, original);
});
test('controller cannot write battle results, casino, payments or administrative API', () => {
  for (const path of ['/api/battle/clear', '/api/battle/kills', '/api/admin/ground_banana',
    '/api/casino/spin', '/api/shop/invoice', 'https://example.com/api/state']) {
    assert.equal(C.WRITABLE.has(path), false);
  }
});
test('accelerated local kills wait for the real spawn schedule before saving', () => {
  const wave = { gap: 1.6, cats: Array(18).fill({}) };
  const clear = C.battleNotBefore(wave, 1000, '/api/battle/clear', 18);
  assert.equal(clear, 33700);
  assert.ok(C.battleNotBefore(wave, 1000, '/api/battle/kills', 8) < clear);
  assert.equal(C.battleNotBefore(wave, 1000, '/api/battle/kills', 999),
    C.battleNotBefore(wave, 1000, '/api/battle/kills', 18));
});
test('casino expectations enumerate all 64 results without a betting request', () => {
  let total = 0;
  for (let n = 0; n < 64; n++) {
    const symbols = [n & 3, (n >> 2) & 3, (n >> 4) & 3];
    total += symbols.every(x => x === 3) ? 25
      : symbols.every(x => x === symbols[0]) ? 7
      : symbols.filter(x => x === 3).length === 2 ? 1.5 : 0;
  }
  assert.equal(C.casinoExpected(100).expectedReturn, 100 * total / 64);
  assert.equal(C.casinoExpected(100).expectedNet, -7.03125);
});
test('farmer picks the high-yield prefix before the boss', () => {
  const cats = Array.from({ length: 17 }, (_, i) => ({
    kind: i % 4 === 3 ? 'elite' : 'cat', reward: i % 4 === 3 ? 2516 : 839,
  }));
  cats.push({ kind: 'boss', reward: 20970 });
  const p = C.farmPrefix({ cats, gap: 1.6 });
  assert.equal(p.kills, 16); assert.equal(p.reward, 20132);
  const fast = C.farmPrefix({ cats, gap: 1.6 }, 8);
  assert.equal(fast.kills, 16); assert.equal(fast.reward, 20132);
  assert.equal(C.farmPrefix({ cats, gap: 1.6 }, 8, 4).kills, 4);
  assert.equal(C.farmPrefix({ cats, gap: 1.6 }, 8, 999).kills, 16);
});
test('farmer stops shooting at its target while world animations continue', () => {
  const e = new Engine();
  e.wave = { cats: [{ kind: 'cat', reward: 10 }, { kind: 'boss', reward: 100 }], gap: 1 };
  e.killed = 1;
  const off = C.patchEngine(e, () => ({ mode: 'farmer', speed: 8 }), counts());
  e.update(.05);
  assert.ok(e.elapsed > 0); assert.equal(e.phase, 'running'); assert.equal(e.shots, 0);
  assert.equal(e.elapsed, .05, 'a completed prefix should animate once at normal speed');
  const hp = e.cat.hp; e.shoot(true);
  assert.equal(e.cat.hp, hp, 'manual taps cannot kill the remaining opponents after the farming target');
  off();
});

test('a requested farming prefix stops local kills before the larger safety limit', () => {
  const e = new Engine();
  e.wave = { cats: Array.from({ length: 18 }, () => ({ kind: 'cat', reward: 10 })), gap: 1.6 };
  e.killed = 4;
  const off = C.patchEngine(e, () => ({ mode: 'farmer', speed: 8, farmKills: 4 }), counts());
  e.update(.05);
  assert.equal(e.shots, 0, 'a chosen short prefix must not kill extra opponents');
  assert.equal(C.farmLocalLimit(e.wave), 16);
  e.killed = 16;
  const shots = e.shots; e.shoot(true); assert.equal(e.shots, shots);
  off();
});
test('paced battle waits for ordinary enemies to reach center and drains boss HP across its path', () => {
  const e = new Engine(); e.cat.kind = 'cat'; e.cat.x = 300; e.cat.maxHp = 500;
  const off = C.patchEngine(e, () => ({ mode: 'paced', speed: 1 }), counts());
  e.update(.05); assert.equal(e.shots, 0);
  e.cat.x = 210; e.update(.05); assert.equal(e.cat.hp, 0);
  const boss = { kind: 'boss', hp: 1000, maxHp: 1000, x: 400 };
  e.damage(boss, 10); assert.equal(boss.hp, 999);
  boss.x = 300; e.damage(boss, 10); assert.ok(boss.hp > 400 && boss.hp < 600);
  boss.x = 190; e.damage(boss, 10); assert.equal(boss.hp, 0);
  off();
});
