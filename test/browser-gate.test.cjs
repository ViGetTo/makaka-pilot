'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('a genuine stale wave stops the farmer and suppresses repeated network reports', async () => {
  let reports = 0;
  const canvas = {};
  const engine = { canvas, phase: 'idle', running: false, hp: 100, maxHp: 100,
    update() {}, hurtMonkey() {}, damage() {}, tap() {}, shoot() {}, frontCats() { return []; }, stop() {} };
  canvas.__reactFiber$test = { memoizedState: { memoizedState: { current: engine }, next: null },
    memoizedProps: { value: { state: { now: 1, bananas: 0, stats: {}, battle: { wave: 55, max_wave: 54 } }, setState() {} } } };
  const context = {
    URL, URLSearchParams, Headers, Request, Response, AbortController, Date, Math, JSON, Number, Set, Map, Object, Error, Blob,
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    location: { origin: 'https://makaka.wivvi.net', href: 'https://makaka.wivvi.net/', hash: '' },
    localStorage: { getItem: () => null, setItem() {} },
    document: { body: null, querySelectorAll: s => s === 'main canvas' ? [canvas] : [], addEventListener() {}, removeEventListener() {} },
    async fetch(input) {
      const path = new URL(input, 'https://makaka.wivvi.net').pathname;
      if (path.endsWith('/start')) return new Response(JSON.stringify({ wave: { wave: 55, gap: 1.6, cats: [{ hp: 10 }, { hp: 10 }] } }));
      reports++;
      return new Response(JSON.stringify({ error: 'stale_wave' }), { status: 409 });
    },
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync('makaka-pilot.user.js', 'utf8'), context);
  context.MakakaPilot.start({ mode: 'farmer', mine: false });
  await context.fetch('/api/battle/start', { method: 'POST', body: '{}' });
  await new Promise(resolve => setTimeout(resolve, 20));
  await context.fetch('/api/battle/kills', { method: 'POST', body: '{"wave":55,"kills":1}' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(context.MakakaPilot.status().active, false);
  assert.equal(context.MakakaPilot.status().serverKills.counted, 0);
  for (let i = 0; i < 3; i++) {
    const response = await context.fetch('/api/battle/kills', { method: 'POST', body: '{"wave":55,"kills":1}' });
    assert.equal(response.status, 409);
  }
  assert.equal(reports, 1);
  assert.equal(context.MakakaPilot.start(), false);
});

test('game launch strips the automation marker while preserving auth, request data and other origins', async () => {
  const sent = [];
  const nativeFetch = async (input, init) => {
    sent.push({ input, init, headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)) });
    return new Response('{}', { status: 200 });
  };
  const context = {
    URL, URLSearchParams, Headers, Request, Response, AbortController,
    Date, Math, JSON, Number, Set, Map, Object, Error, Blob,
    fetch: nativeFetch, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    location: { origin: 'https://makaka.wivvi.net', href: 'https://makaka.wivvi.net/', hash: '' },
    localStorage: { getItem: () => null, setItem() {} },
    document: { body: null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} },
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync('makaka-pilot.user.js', 'utf8'), context);
  const headers = new Headers({ Authorization: 'tma test-only', 'X-Automation': '1', 'Content-Type': 'application/json' });
  const init = { method: 'POST', body: '{"test":1}', credentials: 'include', headers };
  await context.fetch('/api/bootstrap', init);
  assert.equal(sent[0].headers.has('X-Automation'), false);
  assert.equal(sent[0].headers.get('Authorization'), 'tma test-only');
  assert.equal(sent[0].headers.get('Content-Type'), 'application/json');
  assert.equal(sent[0].init.body, init.body);
  assert.equal(sent[0].init.credentials, 'include');
  assert.equal(headers.get('X-Automation'), '1', 'caller headers must remain unchanged');
  const request = new Request('https://makaka.wivvi.net/api/state', init);
  await context.fetch(request);
  assert.equal(sent[1].input, request);
  assert.equal(sent[1].headers.has('X-Automation'), false);
  assert.equal(sent[1].headers.get('Authorization'), 'tma test-only');
  assert.equal(request.headers.get('X-Automation'), '1');
  assert.equal(await request.clone().text(), init.body);
  for (const url of ['https://other.example/api/bootstrap', '/public']) {
    await context.fetch(url, init);
    assert.equal(sent.at(-1).init, init);
    assert.equal(sent.at(-1).headers.get('X-Automation'), '1');
  }
  const clean = { method: 'POST', headers: { Authorization: 'tma test-only' } };
  await context.fetch('/api/state', clean);
  assert.equal(sent.at(-1).init, clean);
  context.MakakaPilot.uninstall();
  assert.equal(context.fetch, nativeFetch);
});

test('clear waits for cumulative progress and retries until the backend accepts the final kill', async () => {
  let confirmed = 0;
  const sent = [];
  const canvas = {};
  const engine = { canvas, phase: 'idle', running: false, hp: 100, maxHp: 100,
    update() {}, hurtMonkey() {}, damage() {}, tap() {}, frontCats() { return []; }, stop() {} };
  canvas.__reactFiber$test = {
    memoizedState: { memoizedState: { current: engine }, next: null },
    memoizedProps: { value: { state: { now: 1, bananas: 0, stats: {}, battle: { wave: 55, max_wave: 54 } }, setState() {} } },
  };
  const fakeFetch = async (input) => {
    const path = new URL(input, 'https://makaka.wivvi.net/').pathname;
    sent.push(path);
    const body = path.endsWith('/start') ? { wave: { wave: 55, cats: [{}, {}], gap: 1.6 } }
      : path.endsWith('/kills') ? { counted: confirmed }
      : path.endsWith('/clear') ? { saved: true } : {};
    if (path.endsWith('/clear') && confirmed < 2) return new Response(JSON.stringify({ error: 'too_fast' }), { status: 409 });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const context = {
    URL, URLSearchParams, Headers, Request, Response, AbortController,
    Date, Math, JSON, Number, Set, Map, Object, Error, Blob,
    fetch: fakeFetch, setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 10)), clearTimeout,
    setInterval: () => 1, clearInterval: () => {},
    location: { origin: 'https://makaka.wivvi.net', href: 'https://makaka.wivvi.net/', hash: '' },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { body: null, querySelectorAll: selector => selector === 'main canvas' ? [canvas] : [], addEventListener: () => {}, removeEventListener: () => {} },
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync('makaka-pilot.user.js', 'utf8'), context);
  assert.equal(context.MakakaPilot.start({ mine: false, collect: false, autoUpgrade: false }), true);
  const pause = () => new Promise(resolve => setTimeout(resolve, 20));
  await context.fetch('/api/battle/start', { method: 'POST', body: '{}' });
  await pause();
  let clearResolved = false;
  const clearing = context.fetch('/api/battle/clear', {
    method: 'POST', body: JSON.stringify({ wave: 55, kills: 2 }),
  }).then(r => { clearResolved = true; return r.json(); });
  await pause();
  assert.equal(sent.includes('/api/battle/clear'), false);
  confirmed = 1;
  const progress = context.fetch('/api/battle/kills', { method: 'POST', body: JSON.stringify({ wave: 55, kills: 2 }) });
  assert.equal(sent.at(-1), '/api/battle/kills', 'farmer must not add its own spawn-time delay');
  await progress;
  await pause();
  assert.equal(clearResolved, false);
  assert.equal(context.MakakaPilot.status().serverKills.counted, 1);
  confirmed = 2;
  await context.fetch('/api/battle/kills', { method: 'POST', body: JSON.stringify({ wave: 55, kills: 2 }) });
  const result = await clearing;
  assert.equal(result.saved, true);
  assert.ok(sent.filter(path => path === '/api/battle/clear').length >= 2);
  await pause();
  assert.equal(context.MakakaPilot.status().serverKills.counted, 2);
});

test('paced mode caches a genuine kill acknowledgement before the game consumes its response', async () => {
  const sent = [], canvas = {};
  const wave = { wave: 55, gap: 1.6, cats: [{ hp: 100, reward: 10 }, { hp: 100, reward: 10 }] };
  const engine = { canvas, wave, phase: 'idle', running: false, hp: 100, maxHp: 100,
    update() {}, hurtMonkey() {}, damage() {}, tap() {}, frontCats() { return []; }, stop() {} };
  canvas.__reactFiber$test = { memoizedState: { memoizedState: { current: engine }, next: null },
    memoizedProps: { value: { state: { now: 1, bananas: 0, stats: {}, battle: { wave: 55, max_wave: 54 } }, setState() {} } } };
  const context = {
    URL, URLSearchParams, Headers, Request, Response, AbortController, Date, Math, JSON, Number, Set, Map, Object, Error, Blob,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 10)), clearTimeout,
    setInterval: () => 1, clearInterval() {},
    location: { origin: 'https://makaka.wivvi.net', href: 'https://makaka.wivvi.net/', hash: '' },
    localStorage: { getItem: () => null, setItem() {} },
    document: { body: null, querySelectorAll: selector => selector === 'main canvas' ? [canvas] : [], addEventListener() {}, removeEventListener() {} },
    async fetch(input) {
      const path = new URL(input, 'https://makaka.wivvi.net/').pathname; sent.push(path);
      return new Response(JSON.stringify(path.endsWith('/start') ? { wave } : { counted: 1 }), { status: 200 });
    },
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync('makaka-pilot.user.js', 'utf8'), context);
  context.MakakaPilot.start({ mode: 'paced' });
  await (await context.fetch('/api/battle/start', { method: 'POST', body: '{}' })).json();
  await new Promise(resolve => setTimeout(resolve, 20));
  await (await context.fetch('/api/battle/kills', { method: 'POST', body: JSON.stringify({ wave: 55, kills: 1 }) })).json();
  await new Promise(resolve => setTimeout(resolve, 20));
  const before = sent.length;
  const cached = await (await context.fetch('/api/battle/kills', { method: 'POST', body: JSON.stringify({ wave: 55, kills: 2 }) })).json();
  assert.equal(sent.length, before);
  assert.equal(cached.counted, 1);
  assert.equal(context.MakakaPilot.status().currentTrial.killProgress.at(-1).counted, 1);
});

test('an aborted clear cannot complete a restarted battle with the same wave number', async () => {
  const sent = [], canvas = {};
  const wave = { wave: 60, gap: 1.6, cats: [{ hp: 100 }, { hp: 100 }] };
  const engine = { canvas, wave, phase: 'idle', running: false, hp: 100, maxHp: 100,
    update() {}, hurtMonkey() {}, damage() {}, tap() {}, frontCats() { return []; }, stop() {} };
  canvas.__reactFiber$test = { memoizedState: { memoizedState: { current: engine }, next: null },
    memoizedProps: { value: { state: { now: 1, bananas: 0, stats: {}, battle: { wave: 60, max_wave: 59 } }, setState() {} } } };
  const context = {
    URL, URLSearchParams, Headers, Request, Response, AbortController, Date, Math, JSON, Number, Set, Map, Object, Error, Blob,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 10)), clearTimeout, setInterval: () => 1, clearInterval() {},
    location: { origin: 'https://makaka.wivvi.net', href: 'https://makaka.wivvi.net/', hash: '' },
    localStorage: { getItem: () => null, setItem() {} },
    document: { body: null, querySelectorAll: selector => selector === 'main canvas' ? [canvas] : [], addEventListener() {}, removeEventListener() {} },
    async fetch(input) {
      const path = new URL(input, 'https://makaka.wivvi.net/').pathname; sent.push(path);
      return new Response(JSON.stringify(path.endsWith('/start') ? { wave }
        : path.endsWith('/kills') ? { counted: 1 } : { saved: true }), { status: 200 });
    },
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync('makaka-pilot.user.js', 'utf8'), context);
  context.MakakaPilot.start({ mode: 'normal' });
  const pause = () => new Promise(resolve => setTimeout(resolve, 20));
  await context.fetch('/api/battle/start', { method: 'POST', body: '{}' }); await pause();
  let oldResolved = false;
  context.fetch('/api/battle/clear', { method: 'POST', body: JSON.stringify({ wave: 60, kills: 2 }) }).then(() => { oldResolved = true; });
  await context.fetch('/api/battle/fail', { method: 'POST', body: '{}' });
  await context.fetch('/api/battle/start', { method: 'POST', body: '{}' }); await pause();
  await context.fetch('/api/battle/kills', { method: 'POST', body: JSON.stringify({ wave: 60, kills: 1 }) }); await pause();
  assert.equal(sent.filter(x => x.endsWith('/clear')).length, 0);
  assert.equal(oldResolved, false);
  await context.fetch('/api/battle/clear', { method: 'POST', body: JSON.stringify({ wave: 60, kills: 2 }) });
  assert.equal(sent.filter(x => x.endsWith('/clear')).length, 1);
});
