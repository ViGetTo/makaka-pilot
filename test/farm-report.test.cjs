'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('a completed prefix flushes its native report once while mine income continues during server waiting', async () => {
  let reports = 0, tick;
  const sent = [];
  const backend = { battleKills() { reports++; } };
  const report = async () => backend.battleKills();
  let state = { now: 100, bananas: 0, stats: { tap: 22, gen: 0, regen: 0, energy_max: 300, storage_hours: 3 },
    mine: { energy: 10, since: 100 }, battle: { wave: 55, max_wave: 54 }, upgrades: {} };
  const canvas = {}, wave = { wave: 55, gap: 1.6, cats: [{ hp: 100, reward: 10 }, { hp: 100, reward: 10 }] };
  const engine = { canvas, wave, cats: [], killed: 1, phase: 'running', running: false, hp: 100, maxHp: 100,
    update() {}, hurtMonkey() {}, damage() {}, tap() {}, shoot() {}, frontCats() { return []; }, stop() {} };
  const provider = { state, setState(next) { this.state = next; } };
  canvas.__reactFiber$test = { memoizedState: { memoizedState: { current: engine },
    next: { memoizedState: [report, []], next: null } }, memoizedProps: { value: provider } };
  const context = { URL, URLSearchParams, Headers, Request, Response, AbortController, Blob, Date, Math, JSON, Number, Set, Map, Object, Error,
    setTimeout, clearTimeout, setInterval(fn, ms) { if (ms === 100) tick = fn; return 1; }, clearInterval() {},
    location: { origin: 'https://makaka.wivvi.net', href: 'https://makaka.wivvi.net/', hash: '#tgWebAppData=test-only' },
    localStorage: { getItem: () => null, setItem() {} },
    document: { body: null, hidden: false, querySelectorAll: s => s === 'main canvas' ? [canvas] : [], addEventListener() {}, removeEventListener() {} },
    async fetch(input) {
      sent.push(input);
      state = { ...state, now: 101, bananas: 220, mine: { ...state.mine, energy: 0 } };
      provider.state = state;
      return new Response(JSON.stringify({ state }));
    },
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync('makaka-pilot.user.js', 'utf8'), context);
  context.MakakaPilot.start({ mode: 'farmer', farmKills: 1, mine: true, collect: false });
  tick(); await new Promise(resolve => setTimeout(resolve, 130));
  tick(); await new Promise(resolve => setTimeout(resolve, 20));
  const s = context.MakakaPilot.status();
  assert.equal(s.farmReportReady, true);
  assert.equal(reports, 1);
  assert.deepEqual(sent, ['/api/mine/tap']);
  assert.equal(s.server.bananas, 220);
  assert.equal(s.serverKills.counted, 0, 'a flush must not invent a battle acknowledgement');
});
