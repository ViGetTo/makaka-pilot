const vm = require('node:vm');
const fs = require('node:fs');

module.exports = function browser({ clearAccepted = false, killLimit = 4, holdClear = false } = {}) {
  let now = 1000000, tick, timerId = 0, paused = false, phase = 'idle', reported = 0;
  const timers = new Map(), sent = [];
  let releaseClear;
  const clearGate = holdClear ? new Promise(resolve => { releaseClear = resolve; }) : Promise.resolve();
  let state = { now: 1000, bananas: 1000000, battle: { wave: 65, max_wave: 64 },
    stats: { dmg: 100, crit: 2, crit_chance: .2, hp: 100, gen: 0, tap: 22,
      regen: 0, energy_max: 300, storage_hours: 3,
      next: { dmg: 120, crit: 2.2, crit_chance: .21, hp: 110 } },
    mine: { energy: 0, since: 1000 },
    upgrades: { dmg: { level: 1, cost: 100 }, auto: { level: 1, cost: 200 }, hp: { level: 1, cost: 300 } } };
  const canvas = {}, engine = { canvas, phase: 'idle', running: false, killed: 0, hp: 100, maxHp: 100, cats: [],
    update() {}, hurtMonkey() {}, damage(cat, amount) { cat.hp -= amount; }, tap() {}, shoot() {}, frontCats() { return []; },
    stop() { this.running = false; }, showIdle() { this.phase = 'idle'; this.wave = null; phase = 'idle'; paused = false; } };
  const provider = { state, setState(next) { this.state = next; } };
  const backend = {
    async battleKills() {
      if (!engine.wave || engine.killed <= reported) return;
      const response = await context.fetch('/api/battle/kills', { method: 'POST',
        body: JSON.stringify({ wave: engine.wave.wave, kills: engine.killed }) });
      if (response.ok) reported = (await response.json()).counted;
    },
    async battleFail() { await context.fetch('/api/battle/fail', { method: 'POST', body: '{}' }); },
  };
  const report = async () => backend.battleKills();
  const exit = async () => { await report(); engine.showIdle(); await backend.battleFail(); };
  canvas.__reactFiber$test = { memoizedState: { memoizedState: { current: engine },
    next: { memoizedState: [report], next: { memoizedState: [exit], next: null } } },
    memoizedProps: { value: provider } };
  const button = (text, action, label = null) => ({ innerText: text, disabled: false,
    getClientRects: () => [1], getAttribute: () => label, click: action });
  const buttons = () => {
    if (paused) return [button('ПРОДОЛЖИТЬ', () => { paused = false; }), button('ВЫЙТИ ИЗ ВОЛНЫ', exit)];
    if (phase === 'running') return [button('', () => { paused = true; engine.stop(); }, 'Пауза')];
    return [button('В бой!', async () => {
      phase = 'starting';
      const response = await context.fetch('/api/battle/start', { method: 'POST', body: '{}' });
      const data = await response.json();
      engine.wave = data.wave; engine.killed = 0; engine.phase = 'running'; phase = 'running';
    })];
  };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = { URL, URLSearchParams, Headers, Request, Response, AbortController, Blob,
    Date: Clock, Math, JSON, Number, Set, Map, Object, Error,
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval(fn, ms) { if (ms === 100) tick = fn; return 1; }, clearInterval() {},
    location: { origin: 'https://makaka.wivvi.net', href: 'https://makaka.wivvi.net/', hash: '#tgWebAppData=test-only' },
    localStorage: { getItem: () => null, setItem() {} },
    document: { body: null, hidden: false, querySelectorAll: s => s === 'main canvas' ? [canvas] : s === 'button' ? buttons() : [],
      addEventListener() {}, removeEventListener() {} },
    async fetch(input, init) {
      const path = new URL(input, 'https://makaka.wivvi.net').pathname;
      const body = JSON.parse(init?.body || '{}'); sent.push({ path, body });
      state = { ...state, now: state.now + 1 };
      let data = {}, status = 200;
      if (path.endsWith('/start')) {
        reported = 0;
        data.wave = { wave: state.battle.wave, gap: 1.6,
          cats: Array.from({ length: 4 }, (_, i) => ({ hp: 100, speed: 54, reward: 10, kind: i === 3 ? 'boss' : 'cat' })) };
      } else if (path.endsWith('/kills')) {
        data.counted = Math.min(body.kills, killLimit);
        state.bananas += Math.max(0, data.counted - reported) * 10;
      } else if (path.endsWith('/clear')) {
        await clearGate;
        if (!clearAccepted) { status = 409; data = { error: 'too_fast' }; }
        else { state.battle = { wave: state.battle.wave + 1, max_wave: state.battle.wave }; phase = 'cleared'; }
      } else if (path === '/api/upgrade') {
        state.bananas -= state.upgrades[body.kind].cost;
        state.upgrades = structuredClone(state.upgrades); state.upgrades[body.kind].level++;
      }
      provider.state = state;
      return new Response(JSON.stringify({ ...data, state }), { status });
    },
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync('makaka-pilot.user.js', 'utf8'), context);
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
  async function advance(ms = 100) {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    await flush(); tick(); await flush();
  }
  const pilot = context.MakakaPilot;
  const start = options => pilot.start({ mode: 'auto', mine: false, collect: false,
    autoUpgrade: false, farmKills: 2, sessionMinutes: 0, ...options });
  return { context, pilot, engine, sent, start, advance, flush, releaseClear,
    async enterPush(options) { start(options); await advance(180000); },
    async clear() {
      engine.killed = engine.wave.cats.length; engine.phase = 'cleared';
      const progress = backend.battleKills(); await advance(6500); await progress; await flush();
      return { promise: context.fetch('/api/battle/clear', { method: 'POST',
        body: JSON.stringify({ wave: engine.wave.wave, kills: engine.killed }) }) };
    },
  };
};
