'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('bank mode makes no purchases before one million, then switches to progression and buys damage', async () => {
  const sent = [], intervals = [];
  let state = {
    now: 100, bananas: 999999, battle: { wave: 55, max_wave: 54 },
    stats: { dmg: 460, crit: 4.8, crit_chance: .26, hp: 765, gen: 0, regen: .5,
      tap: 22, energy_max: 300, storage_hours: 3, next: { dmg: 552, crit: 5, crit_chance: .27, hp: 800 } },
    upgrades: { dmg: { cost: 150000 }, auto: { cost: 180000 }, hp: { cost: 100000 } },
    mine: { energy: 0, since: 100 },
  };
  const canvas = {};
  const engine = { canvas, phase: 'idle', running: false, hp: 765, maxHp: 765,
    update() {}, hurtMonkey() {}, damage() {}, tap() {}, frontCats() { return []; }, stop() {} };
  const provider = { state, setState(s) { state = s; this.state = s; } };
  canvas.__reactFiber$test = { memoizedState: { memoizedState: { current: engine }, next: null }, memoizedProps: { value: provider } };
  const context = {
    URL, URLSearchParams, Headers, Request, Response, AbortController, Blob,
    Date, Math, JSON, Number, Set, Map, Object, Error,
    setTimeout, clearTimeout, setInterval(fn) { intervals.push(fn); return intervals.length; }, clearInterval() {},
    location: { origin: 'https://makaka.wivvi.net', href: 'https://makaka.wivvi.net/', hash: '#tgWebAppData=test-only' },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { body: null, hidden: false, querySelectorAll: selector => selector === 'main canvas' ? [canvas] : [],
      addEventListener() {}, removeEventListener() {} },
    async fetch(input, init) {
      const path = new URL(input, 'https://makaka.wivvi.net/').pathname;
      sent.push({ path, body: init?.body ? JSON.parse(init.body) : {} });
      if (path === '/api/upgrade') {
        state = { ...state, now: state.now + 1, bananas: state.bananas - 150000,
          stats: { ...state.stats, dmg: 552 } };
      }
      return new Response(JSON.stringify({ state }), { status: 200 });
    },
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync('makaka-pilot.user.js', 'utf8'), context);
  const pause = () => new Promise(resolve => setTimeout(resolve, 130));
  context.MakakaPilot.start({ mode: 'farmer', farmTarget: 1000000, mine: false, collect: false, autoUpgrade: true });
  intervals[0](); await pause();
  assert.equal(context.MakakaPilot.status().config.mode, 'farmer');
  assert.equal(sent.filter(x => x.path === '/api/upgrade').length, 0);
  state = { ...state, now: state.now + 1, bananas: 1000001 };
  provider.state = state;
  await context.fetch('/api/state'); await pause();
  intervals[0](); await pause();
  assert.equal(context.MakakaPilot.status().config.mode, 'paced');
  assert.equal(sent.find(x => x.path === '/api/upgrade').body.kind, 'dmg');
  assert.equal(context.MakakaPilot.status().server.bananas, 850001);
  context.MakakaPilot.stop();
  state = { ...state, now: state.now + 1, bananas: 1000001, battle: { wave: 61, max_wave: 60 } };
  provider.state = state;
  context.MakakaPilot.start({ mode: 'farmer', targetWave: 60, farmTarget: 1000000 });
  const purchases = sent.filter(x => x.path === '/api/upgrade').length;
  intervals[0](); await pause();
  assert.equal(context.MakakaPilot.status().active, false);
  assert.equal(context.MakakaPilot.status().server.bananas, 1000001);
  assert.equal(sent.filter(x => x.path === '/api/upgrade').length, purchases);
});
