// ==UserScript==
// @name         Makaka Pilot
// @namespace    local.makaka.pilot
// @version      2.10.0
// @description  Автоматизация волн, улучшений и кликера для Макаки Убиваки.
// @match        https://makaka.wivvi.net/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '2.10.0';
  const AUTO_INTERVAL = 180000, AUTO_TIMEOUT = 90000;
  const DEFAULTS = {
    mode: 'auto', speed: 8, autoUpgrade: true, mine: true,
    collect: true, reserve: 0, targetWave: 0, sessionMinutes: 0, farmTarget: 0, farmKills: 0, gearAuto: false,
  };
  const MODES = new Set(['auto', 'normal', 'survival', 'turbo', 'maximum', 'farmer', 'paced']);
  const isFast = mode => ['turbo', 'maximum', 'farmer', 'paced'].includes(mode);
  const WRITABLE = new Set([
    '/api/state', '/api/upgrade', '/api/mine/tap',
    '/api/mine/collect', '/api/mine/auto',
  ]);

  function cleanConfig(value = {}) {
    const finite = (x, fallback, min, max) =>
      Number.isFinite(Number(x)) ? Math.min(max, Math.max(min, Number(x))) : fallback;
    const mode = MODES.has(value.mode) ? value.mode : DEFAULTS.mode;
    return {
      mode,
      speed: finite(value.speed ?? DEFAULTS.speed, DEFAULTS.speed, 1, 8),
      autoUpgrade: mode === 'auto' ? true : (value.autoUpgrade ?? DEFAULTS.autoUpgrade),
      mine: value.mine ?? DEFAULTS.mine,
      collect: value.collect ?? DEFAULTS.collect,
      reserve: mode === 'auto' ? 0 : finite(value.reserve ?? 0, 0, 0, 1e15),
      targetWave: Math.floor(finite(value.targetWave ?? 0, 0, 0, 1e9)),
      sessionMinutes: finite(value.sessionMinutes ?? 0, 0, 0, 1440),
      farmTarget: finite(value.farmTarget ?? 0, 0, 0, 1e15),
      farmKills: Math.floor(finite(value.farmKills ?? 0, 0, 0, 1000)),
      gearAuto: value.mode === 'auto' ? false : (value.gearAuto ?? false),
    };
  }

  function combatChoices(state, hpRatio = 1) {
    const s = state?.stats;
    if (!s || !state.upgrades) return [];
    const next = s.next || {};
    const expected = (dmg, crit, chance) => dmg * (1 + chance * (crit - 1));
    const base = expected(s.dmg, s.crit, s.crit_chance);
    const candidates = [
      ['dmg', expected(next.dmg, s.crit, s.crit_chance) / base - 1],
      ['auto', expected(s.dmg, next.crit, next.crit_chance) / base - 1],
    ];
    if (hpRatio < 0.65) {
      candidates.push(['hp', (next.hp / s.hp - 1) * (hpRatio < 0.35 ? 10 : 2)]);
    }
    return candidates.map(([kind, gain]) => ({ kind, gain, cost: state.upgrades[kind]?.cost }))
      .filter(x => Number.isFinite(x.cost) && x.cost > 0 && Number.isFinite(x.gain) && x.gain > 0)
      .map(x => ({ ...x, score: x.gain / x.cost }))
      .sort((a, b) => b.score - a.score);
  }

  function chooseCombatUpgrade(state, hpRatio = 1, reserve = 0) {
    const available = Math.max(0, (state?.bananas || 0) - reserve);
    const choices = combatChoices(state, hpRatio);
    // An urgent heal raises current HP by exactly the purchased HP increase.
    if (hpRatio < 0.35) {
      const heal = choices.find(x => x.kind === 'hp' && x.cost <= available);
      if (heal) return heal;
    }
    const affordable = choices.filter(x => x.cost <= available);
    // Save for damage when it is much better than the available critical upgrade.
    const best = choices[0];
    if (best && best.cost > available && available >= best.cost * 0.75 &&
        (!affordable[0] || best.score > affordable[0].score * 1.25)) return null;
    return affordable[0] || null;
  }

  function chooseDamageUpgrade(state) {
    const cost = state?.upgrades?.dmg?.cost;
    return Number.isFinite(cost) && cost > 0 && state.bananas >= cost ? { kind: 'dmg', cost } : null;
  }

  function energyAt(state, now) {
    const s = state.stats;
    return Math.max(0, Math.min(s.energy_max,
      state.mine.energy + Math.max(0, now - state.now) * s.regen));
  }

  function tapCount(state, now) {
    return Math.max(0, Math.min(60, Math.floor(energyAt(state, now))));
  }

  function economyChoice(state, reserve = 0) {
    const s = state.stats, n = s.next;
    return [
      { kind: 'tap', gain: (n.tap - s.tap) * s.regen },
      { kind: 'gen', gain: (n.gen - s.gen) / 3600 },
    ].map(x => ({ ...x, cost: state.upgrades[x.kind]?.cost }))
      .filter(x => Number.isFinite(x.cost) && x.cost > 0 && x.gain > 0 &&
        x.cost <= state.bananas - reserve && x.cost / x.gain <= 180)
      .sort((a, b) => a.cost / a.gain - b.cost / b.gain)[0] || null;
  }

  function battleNotBefore(wave, startedAt, path, kills) {
    if (!wave?.cats?.length || !Number.isFinite(wave.gap) || wave.gap <= 0) return startedAt;
    const count = path === '/api/battle/clear' ? wave.cats.length
      : Math.max(0, Math.min(wave.cats.length, Number(kills) || 0));
    if (!count) return startedAt;
    const margin = path === '/api/battle/clear' ? 5 : 1;
    return startedAt + (0.5 + (count - 1) * wave.gap + margin) * 1000;
  }

  function casinoExpected(bet = 100) {
    const stake = Math.max(0, Number(bet) || 0);
    // Uses the game's stated 64 equally probable results and displayed pay table.
    const returned = stake * (25 + 3 * 7 + 9 * 1.5) / 64;
    return { bet: stake, expectedReturn: returned, expectedNet: returned - stake,
      winProbability: 13 / 64, jackpotProbability: 1 / 64, assumedUniform: true };
  }

  function farmLocalLimit(wave) {
    if (!wave?.cats?.length) return 0;
    let limit = Math.min(wave.cats.length - 1, Math.max(1, wave.cats.length - 2));
    const boss = wave.cats.findIndex(cat => cat.kind === 'boss');
    if (boss >= 0) limit = Math.min(limit, boss);
    return Math.max(0, limit);
  }
  function farmPrefix(wave, speed = 1, requestedKills = 0) {
    if (!wave?.cats?.length) return { kills: 0, reward: 0, estimate: 0 };
    let reward = 0, best = { kills: 0, reward: 0, estimate: 0 };
    // Live server state can reserve two opponents even after local kills complete.
    const limit = farmLocalLimit(wave);
    const target = requestedKills > 0 ? Math.min(limit, requestedKills) : 0;
    for (let i = 0; i < limit; i++) {
      if (wave.cats[i].kind === 'boss') break;
      reward += Math.max(0, wave.cats[i].reward || 0);
      const travel = 34 / (wave.cats[i].speed || 54);
      const seconds = speed > 1
        ? Math.ceil((0.5 + i * wave.gap + travel) / speed / 2) * 2 + 1.75
        : 0.5 + i * wave.gap + 4;
      const estimate = reward / seconds;
      if (estimate > best.estimate) best = { kills: i + 1, reward, estimate };
      if (target && i + 1 === target) return { kills: target, reward, estimate };
    }
    return best;
  }
  const farmPlans = new WeakMap();
  function planForFarm(wave, speed, kills = 0) {
    if (!wave) return { kills: 0, reward: 0, estimate: 0 };
    const key = speed + ':' + kills;
    if (farmPlans.get(wave)?.key !== key) farmPlans.set(wave, { key, plan: farmPrefix(wave, speed, kills) });
    return farmPlans.get(wave).plan;
  }

  function patchEngine(engine, config, counters) {
    const saved = new Map();
    const bossFirstX = new WeakMap();
    const replace = (key, fn) => {
      saved.set(key, Object.getOwnPropertyDescriptor(engine, key));
      engine[key] = fn;
    };
    const update = engine.update;
    const hurt = engine.hurtMonkey;
    const damage = engine.damage;
    const shoot = engine.shoot;
    replace('shoot', function (manual) {
      const cfg = config();
      if (cfg.retreating) return;
      if (cfg.mode === 'farmer' && this.wave) {
        const goal = planForFarm(this.wave, cfg.speed, cfg.farmKills).kills;
        if (goal > 0 && this.killed >= goal) return;
      }
      return shoot.call(this, manual);
    });
    replace('hurtMonkey', function (amount) {
      if (config().mode !== 'normal') {
        counters.blockedDamage += Math.max(0, amount);
        return;
      }
      return hurt.call(this, amount);
    });
    replace('damage', function (cat, amount, critical, y) {
      if (['maximum', 'farmer'].includes(config().mode) && !cat.deco) amount = Math.max(amount, cat.hp);
      if (config().mode === 'paced' && !cat.deco) {
        if (cat.kind !== 'boss') amount = Math.max(amount, cat.hp);
        else {
          if (!bossFirstX.has(cat)) bossFirstX.set(cat, cat.x);
          const start = bossFirstX.get(cat), end = 190;
          const remaining = Math.max(0, Math.min(1, (cat.x - end) / Math.max(1, start - end)));
          amount = Math.max(1, cat.hp - Math.round(cat.maxHp * remaining));
        }
      }
      return damage.call(this, cat, amount, critical, y);
    });
    replace('update', function (delta) {
      const cfg = config();
      if (cfg.retreating) return;
      if (cfg.mode === 'farmer' && this.wave &&
          this.killed >= planForFarm(this.wave, cfg.speed, cfg.farmKills).kills) {
        update.call(this, delta); // Keep animations alive without accelerating an already finished prefix.
        return;
      }
      const advance = (dt) => {
        update.call(this, dt);
        if (cfg.mode === 'farmer' && this.wave && this.killed >= planForFarm(this.wave, cfg.speed, cfg.farmKills).kills) return;
        if (this.phase !== 'running') return;
        if (!this.frontCats().some(cat => !cat.deco)) return;
        const front = this.frontCats().find(cat => !cat.deco);
        if (cfg.mode === 'paced' && front && front.kind !== 'boss' && front.x > 220) return;
        if (!isFast(cfg.mode)) {
          this.tap();
        } else if (this.time - this.lastShot >= 0.02) {
          this.shoot(false);
          counters.burstShots++;
        }
      };
      if (!isFast(cfg.mode) || this.phase !== 'running') {
        advance(delta);
        return;
      }
      // Small physics steps preserve movement, collision and attack order.
      let left = Math.min(0.05, Math.max(0, delta)) * cfg.speed;
      for (let steps = 0; left > 1e-7 && steps < 64; steps++) {
        const dt = Math.min(1 / 120, left);
        advance(dt);
        left -= dt;
        if (this.phase !== 'running') break;
      }
    });
    return () => {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(engine, key, descriptor);
        else delete engine[key];
      }
    };
  }

  const Core = { cleanConfig, combatChoices, chooseCombatUpgrade, chooseDamageUpgrade, energyAt, tapCount,
    economyChoice, patchEngine, battleNotBefore, casinoExpected, farmPrefix, farmLocalLimit, WRITABLE };
  if (typeof module === 'object' && module.exports) {
    module.exports = Core;
    return;
  }
  if (location.origin !== 'https://makaka.wivvi.net') {
    throw new Error('Makaka Pilot: запусти скрипт в окне makaka.wivvi.net.');
  }
  if (window.MakakaPilot?.version === VERSION) {
    window.MakakaPilot.show();
    return;
  }
  window.MakakaPilot?.uninstall?.();

  const CONFIG_KEY = 'makaka:pilot:v1';
  let cfg;
  try { cfg = cleanConfig(JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}')); }
  catch { cfg = cleanConfig(); }
  let authorization = null;
  try {
    const raw = new URLSearchParams(location.hash.slice(1)).get('tgWebAppData');
    if (raw) authorization = 'tma ' + raw;
    else if (window.Telegram?.WebApp?.initData) authorization = 'tma ' + window.Telegram.WebApp.initData;
  } catch { /* Authorization remains in memory and can be learned from game requests. */ }

  const stats = { blockedDamage: 0, burstShots: 0, requests: 0, failures: 0,
    spent: 0, gained: 0, startBest: null, best: null, starts: 0, farmCycles: 0, damageUpgrades: 0 };
  const log = [];
  let active = false, installed = true, engine = null, bridge = null, restore = null;
  let latest = null, stateSkew = 0, baselineBalance = null;
  let host = null, shadow = null, loopTimer = null, renderTimer = null;
  let busy = false, startedAt = 0, accountingStartedAt = 0, nextRequest = 0, backoff = 0, errors = 0;
  let actionAt = 0, upgradeAt = 0, collectAt = 0, autoAt = 0;
  let lastPhase = '', failedWave = null, failCount = 0, recovering = false;
  let progressAt = Date.now(), progressMark = '', message = 'Готов. Нажми «Запустить».';
  let minimumTransition = 0, hiddenPause = false, lastBridgeAt = 0;
  let needsSync = false, requestAbort = null;
  let waveClock = null, savingUntil = 0, timingPenalty = 0;
  let lastBattleError = null;
  let acceptedWave = null, acceptedKills = 0, waitingForKills = false;
  let lastKillReply = null;
  let trial = null;
  const trials = [];
  const farmCycles = [];
  let farmRetreatAt = 0;
  let battleGeneration = 0, pendingFail = false, externallyStale = false;
  let reportKills = null, earlyReportedWave = null, lastStepAt = 0;
  let farmConfirmStartedAt = 0;
  let nativeExit = null, exiting = false, stepping = false, clearInFlight = 0;
  let runtimeFarmKills = 0;
  const battleWaiters = new Set();
  const automatic = { stage: 'prepare', nextAttemptAt: 0, deadlineAt: 0,
    attempts: 0, wave: null, rejection: null, retreatAt: 0, exitRequested: false, cooldownAfterExit: false, history: [] };
  function combatConfig() {
    if (cfg.mode !== 'auto') return cfg;
    const push = automatic.stage === 'push';
    return { ...cfg, mode: push ? 'survival' : 'farmer', speed: push ? 1 : 8,
      farmKills: runtimeFarmKills || cfg.farmKills, retreating: automatic.stage === 'retreat' };
  }
  function cancelBattle() {
    battleGeneration++;
    waitingForKills = false; acceptedKills = 0; acceptedWave = null; lastKillReply = null;
    savingUntil = 0;
    for (const cancel of battleWaiters) cancel();
    battleWaiters.clear();
  }
  function waitForBattle(ms, generation) {
    return new Promise(resolve => {
      if (generation !== battleGeneration) { resolve(); return; }
      const finish = () => { clearTimeout(timer); battleWaiters.delete(finish); resolve(); };
      const timer = setTimeout(finish, Math.max(0, ms));
      battleWaiters.add(finish);
    });
  }
  const parked = () => new Promise(() => {});
  const staleReply = () => new Response(JSON.stringify({ error: 'stale_wave', message: 'Забег уже отменён.' }),
    { status: 409, headers: { 'Content-Type': 'application/json' } });

  function note(text) {
    message = text;
    log.push({ at: new Date().toISOString(), text });
    if (log.length > 100) log.shift();
  }
  function saveConfig() {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch { /* Storage may be blocked. */ }
  }
  function syncControls() {
    if (!shadow) return;
    for (const key of Object.keys(DEFAULTS)) {
      const input = shadow.getElementById(key);
      if (input?.type === 'checkbox') input.checked = cfg[key];
      else if (input) input.value = String(cfg[key]);
    }
  }
  function findBridge() {
    const canvases = document.querySelectorAll('main canvas');
    for (const canvas of canvases) {
      const key = Object.keys(canvas).find(k => k.startsWith('__reactFiber$'));
      let f = key && canvas[key], found = null, context = null, report = null, exit = null;
      for (let depth = 0; f && depth < 30; depth++, f = f.return) {
        for (const node of [f, f.alternate]) {
          if (!node) continue;
          let hook = node.memoizedState;
          for (let j = 0; hook && j < 80; j++, hook = hook.next) {
            const value = hook.memoizedState?.current;
            if (value?.canvas === canvas && typeof value.update === 'function' &&
                typeof value.tap === 'function' && typeof value.hurtMonkey === 'function') found = value;
            const callback = hook.memoizedState?.[0];
            if (typeof callback === 'function') {
              const source = Function.prototype.toString.call(callback);
              if (source.includes('.battleKills(')) report = callback;
              if (source.includes('.battleFail(') && source.includes('.showIdle(')) exit = callback;
            }
          }
          const value = node.memoizedProps?.value;
          if (value?.state?.stats && typeof value.setState === 'function' &&
              (!context || value.state.now >= context.state.now)) context = value;
        }
      }
      if (found && context) return { engine: found, context, report, exit };
    }
    return null;
  }
  function receive(state) {
    if (!state?.stats || !state.battle || !Number.isFinite(state.now)) return;
    if (latest && state.now <= latest.now) return;
    latest = state;
    stateSkew = state.now - Date.now() / 1000;
    stats.best = state.battle.max_wave;
    if (stats.startBest === null) stats.startBest = stats.best;
    if (baselineBalance === null) baselineBalance = state.bananas;
    stats.gained = state.bananas - baselineBalance + stats.spent;
  }
  function refreshBridge() {
    const next = findBridge();
    if (!next) return false;
    bridge = next.context;
    reportKills = next.report;
    nativeExit = next.exit;
    receive(bridge.state);
    if (engine !== next.engine) {
      restore?.(); restore = null;
      engine = next.engine;
      if (active) restore = patchEngine(engine, combatConfig, stats);
    }
    lastBridgeAt = Date.now();
    return true;
  }
  function apiPath(input) {
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
      return url.origin === location.origin && /^\/api\//.test(url.pathname) ? url.pathname : null;
    } catch { return null; }
  }

  // Observe only this game's API. Never export or persist Authorization.
  const nativeFetch = window.fetch;
  const observedFetch = function (input, init) {
    if (!installed) return nativeFetch.apply(this, arguments);
    const path = apiPath(input);
    if (externallyStale && ['/api/battle/kills', '/api/battle/clear'].includes(path)) {
      return Promise.resolve(staleReply());
    }
    const invokedAt = Date.now();
    const mode = combatConfig().mode;
    const isBattle = path?.startsWith('/api/battle/');
    if (path === '/api/battle/start' || path === '/api/battle/fail') {
      cancelBattle();
      if (path === '/api/battle/fail') pendingFail = true;
    }
    const generation = battleGeneration;
    let requestBody = {};
    try { requestBody = JSON.parse(init?.body || '{}'); } catch { /* Non-JSON requests are only observed. */ }
    if (mode === 'paced' && path === '/api/battle/kills' && engine?.wave &&
        requestBody.wave === acceptedWave && requestBody.kills >= engine.wave.cats.length &&
        acceptedKills >= engine.wave.cats.length - 1 && lastKillReply) {
      // Return the last genuine acknowledgement for an unchanged cumulative report.
      // The clear endpoint remains responsible for validating the final kill.
      return Promise.resolve(lastKillReply.clone());
    }
    if (path) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      // The game adds this marker in a controlled browser. Keep Telegram auth intact.
      if (headers.has('X-Automation')) {
        headers.delete('X-Automation');
        init = { ...init, headers };
      }
      const auth = headers.get('Authorization');
      if (auth?.startsWith('tma ')) authorization = auth;
    }
    let wait = 0;
    if (waveClock && isFast(mode)) waveClock.accelerated = true;
    if (active && mode !== 'farmer' && (isFast(mode) || waveClock?.accelerated) &&
        (path === '/api/battle/kills' || path === '/api/battle/clear')) {
      if (!waveClock && engine?.wave) waveClock = { wave: engine.wave, startedAt: invokedAt, accelerated: true };
      let body;
      try { body = JSON.parse(init?.body || '{}'); } catch { body = {}; }
      if (waveClock && body.wave === waveClock.wave.wave) {
        const notBefore = Math.max(waveClock.retryAt || 0,
          battleNotBefore(waveClock.wave, waveClock.startedAt, path, body.kills) + timingPenalty);
        wait = Math.max(0, notBefore - invokedAt);
        if (wait > 0) {
          savingUntil = Math.max(savingUntil, notBefore);
          note('Ожидаю штатного времени волны перед сохранением.');
        }
      }
    }
    const args = [input, init], self = this;
    const send = () => {
      if (isBattle && (!installed || generation !== battleGeneration)) {
        return path === '/api/battle/kills' ? Promise.resolve(staleReply()) : parked();
      }
      if (path !== '/api/battle/clear') return nativeFetch.apply(self, args);
      clearInFlight++;
      return Promise.resolve().then(() => nativeFetch.apply(self, args)).finally(() => { clearInFlight--; });
    };
    let promise;
    if (path === '/api/battle/clear' && Number.isFinite(requestBody.wave) &&
        Number.isFinite(requestBody.kills) && requestBody.kills > 0) {
      waitingForKills = true;
      note('Ожидаю принятия волны сервером.');
      // The game's own running-state interval keeps reporting cumulative kills.
      // Submit its unchanged clear request only when the server counted them all.
      promise = new Promise((resolve, reject) => {
        const until = Date.now() + 15 * 60000;
        const check = () => {
          if (!installed || generation !== battleGeneration) return;
          // Some game servers reserve the final kill for the clear endpoint.
          if (acceptedWave === requestBody.wave && acceptedKills >= requestBody.kills - 1) {
            return resolve();
          }
          if (Date.now() >= until) {
            waitingForKills = false;
            stop('Сервер не подтвердил прогресс боя за 15 минут.');
            return reject(new Error('Server kill confirmation timeout.'));
          }
          setTimeout(check, 250);
        };
        check();
      }).then(async () => {
        if (wait > 0) await waitForBattle(Math.max(0, invokedAt + wait - Date.now()), generation);
        const until = Date.now() + 15 * 60000;
        for (;;) {
          if (!installed || generation !== battleGeneration) return parked();
          if (!active) { await new Promise(resolve => setTimeout(resolve, 500)); continue; }
          const response = await send();
          if (generation !== battleGeneration) return parked();
          if (trial?.generation === generation) {
            trial.attempts.push({ seconds: Math.round((Date.now() - trial.startedAt) / 100) / 10,
              status: response.status, counted: acceptedKills });
            if (response.ok) {
              trial.acceptedSeconds = Math.round((Date.now() - trial.startedAt) / 100) / 10;
              trials.push({ ...trial, attempts: trial.attempts.slice(), killProgress: trial.killProgress.slice() });
              if (trials.length > 100) trials.shift();
            }
          }
          if (cfg.mode === 'auto' && automatic.stage === 'push' && response.status >= 400 && response.status < 500 &&
              ![401, 403, 429].includes(response.status)) {
            const error = await response.clone().json().catch(() => ({}));
            if (error.error !== 'stale_wave') {
              automatic.rejection = String(error.error || 'rejected');
              lastBattleError = { path, status: response.status, code: automatic.rejection,
                message: String(error.message || ''), at: new Date().toISOString() };
              note('Сервер отклонил волну. Возвращаюсь к фарму бананов.');
              return parked();
            }
          }
          if (response.status !== 409) { waitingForKills = false; return response; }
          const error = await response.clone().json().catch(() => ({}));
          if (error.error !== 'too_fast') { waitingForKills = false; return response; }
          lastBattleError = { path, status: response.status, code: error.error,
            message: String(error.message || ''), at: new Date().toISOString() };
          if (Date.now() >= until) {
            waitingForKills = false; stop('Сервер не принял завершение волны за 15 минут.');
            return response;
          }
          note('Сервер ещё не готов завершить волну. Следующая проверка через 30 секунд.');
          await waitForBattle(30000, generation);
        }
      });
    } else {
      promise = wait > 0
        ? waitForBattle(wait, generation).then(send)
        : send();
    }
    const ownedPromise = promise.then(response => {
      if (path === '/api/battle/fail' && generation === battleGeneration) pendingFail = false;
      if (isBattle && generation !== battleGeneration) {
        return path === '/api/battle/kills' ? staleReply() : parked();
      }
      return response;
    });
    if (path === '/api/battle/fail') ownedPromise.catch(() => {
      if (generation === battleGeneration) pendingFail = false;
    });
    if (path) ownedPromise.then(response => {
      if (!installed || (isBattle && generation !== battleGeneration)) return;
      const cacheCopy = path === '/api/battle/kills' ? response.clone() : null;
      if (response.status === 401 || response.status === 403) {
        if (active) stop('Сессия истекла. Заново открой игру через Telegram.');
      }
      response.clone().json().then(data => {
        if (!installed || (isBattle && generation !== battleGeneration)) return;
        if (data.state) receive(data.state);
        if (path === '/api/battle/start' && response.ok && data.wave) {
          externallyStale = false;
          waveClock = { wave: data.wave, startedAt: Date.now(), accelerated: isFast(mode) };
          acceptedWave = data.wave.wave; acceptedKills = 0;
          lastKillReply = null;
          savingUntil = 0;
          trial = { generation, wave: data.wave.wave, startedAt: Date.now(), mode, speed: combatConfig().speed,
            startBalance: data.state?.bananas ?? latest?.bananas,
            stats: data.state?.stats ? { dmg: data.state.stats.dmg, crit: data.state.stats.crit,
              critChance: data.state.stats.crit_chance } : null,
            gear: data.state?.upgrades ? { damage: data.state.upgrades.dmg.level,
              critical: data.state.upgrades.auto.level } : null,
            totalHp: data.wave.cats.reduce((sum, cat) => sum + cat.hp, 0),
            count: data.wave.cats.length, gap: data.wave.gap, attempts: [], killProgress: [] };
          if (cfg.mode === 'auto' && automatic.stage === 'push') {
            automatic.attempts++;
            automatic.wave = data.wave.wave;
            automatic.deadlineAt = Date.now() + AUTO_TIMEOUT;
          }
        }
        if (path === '/api/battle/clear' && response.ok && cfg.mode === 'auto' &&
            ['push', 'retreat'].includes(automatic.stage)) {
          finishAutomatic('cleared');
        }
        if (path === '/api/battle/kills' && response.ok && Number.isFinite(data.counted)) {
          if (acceptedWave !== requestBody.wave) { acceptedWave = requestBody.wave; acceptedKills = 0; }
          acceptedKills = Math.max(acceptedKills, data.counted);
          lastKillReply = cacheCopy;
          if (trial?.wave === requestBody.wave && trial.killProgress.at(-1)?.counted !== acceptedKills) {
            trial.killProgress.push({ seconds: Math.round((Date.now() - trial.startedAt) / 100) / 10, counted: acceptedKills });
          }
        }
        if (path.startsWith('/api/battle/') && !response.ok && active) {
          lastBattleError = { path, status: response.status, code: String(data.error || ''),
            message: String(data.message || ''), at: new Date().toISOString() };
          if (response.status === 429) stop('Сервер ограничил частоту запросов. Автоматизация остановлена.');
          else if (data.error === 'stale_wave') {
            externallyStale = true;
            stop('Сервер сбросил бой. Останови другие запуски этого аккаунта и перезагрузи игру.');
          }
          else if (data.error === 'too_fast') {
            if (cfg.mode === 'auto' && automatic.stage === 'push') {
              automatic.rejection = 'too_fast';
              return;
            }
            // Increase waiting time before the game's own retry. No forged result or time is sent.
            timingPenalty += 15000;
            if (waveClock) {
              waveClock.accelerated = true;
              waveClock.retryAt = Date.now() + 15000;
            }
            if (timingPenalty >= 90000) stop('Сервер отклоняет время боя. Продолжи в обычном режиме.');
            else note('Сервер запросил больше времени. Добавлено ожидание перед повтором.');
          }
          else note('Сервер не принял бой: ' + String(data.error || response.status));
        }
      }).catch(() => {});
    }).catch(() => {});
    return ownedPromise;
  };
  window.fetch = observedFetch;

  async function post(path, body = {}) {
    if (!WRITABLE.has(path)) throw new Error('Этот адрес API запрещён контроллером.');
    if (!authorization) throw new Error('Ожидаю запрос игры с авторизацией.');
    stats.requests++;
    requestAbort = new AbortController();
    const timeout = setTimeout(() => requestAbort?.abort(), 15000);
    let response, data;
    try {
      response = await nativeFetch.call(window, path, {
        method: 'POST', credentials: 'same-origin', signal: requestAbort.signal,
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      data = await response.json();
    } finally {
      clearTimeout(timeout); requestAbort = null;
    }
    if (!response.ok) {
      const error = new Error(data.message || data.error || 'Ошибка ' + response.status);
      error.status = response.status;
      error.retry = Number(response.headers.get('Retry-After')) || 0;
      throw error;
    }
    errors = 0; backoff = 0;
    if (data.state) {
      receive(data.state);
      bridge?.setState(data.state);
    }
    return data;
  }
  async function request(path, body) {
    if (busy || Date.now() < nextRequest || !active || !authorization) return null;
    busy = true;
    try {
      return await post(path, body);
    } catch (error) {
      if (!active) return null;
      errors++; stats.failures++; needsSync = true;
      backoff = Math.max(error.retry * 1000, Math.min(60000, 2000 * 2 ** Math.min(errors, 5)));
      note('Пауза запросов: ' + error.message);
      if (error.status === 401 || error.status === 403) stop('Нужно заново открыть игру через Telegram.');
      else if (errors >= 8) stop('Восемь ошибок подряд. Проверь соединение и игру.');
      return null;
    } finally {
      nextRequest = Date.now() + Math.max(1100, backoff);
      busy = false;
    }
  }
  function maintainDamage(now) {
    if (busy || now < nextRequest || now < upgradeAt || !authorization || needsSync) return;
    const choice = chooseDamageUpgrade(latest);
    if (!choice) return;
    const level = latest.upgrades.dmg.level, damage = latest.stats.dmg;
    upgradeAt = now + 1200;
    request('/api/upgrade', { kind: 'dmg' }).then(result => {
      if (!result) return;
      if (result.state?.upgrades?.dmg?.level > level || result.state?.stats?.dmg > damage) {
        stats.spent += choice.cost; stats.damageUpgrades++;
        note('Повышен урон: уровень ' + (result.state.upgrades?.dmg?.level ?? '—') + ', урон ' + (result.state.stats?.dmg ?? '—') + '.');
      } else {
        needsSync = true; upgradeAt = Date.now() + 30000;
        note('Сервер ещё не подтвердил улучшение урона. Проверяю состояние.');
      }
    });
  }
  function visibleButton(match) {
    return [...document.querySelectorAll('button')].find(b =>
      b.getClientRects().length && !b.disabled && match(b.innerText.trim(), b));
  }
  function disableBuiltinAuto() {
    const button = visibleButton(text => /^АВТО\s+ВКЛ$/.test(text));
    if (button) button.click();
  }
  function finishAutomatic(result) {
    automatic.history.push({ at: new Date().toISOString(), result,
      wave: automatic.wave, bananas: latest?.bananas, bestWave: stats.best });
    if (automatic.history.length > 100) automatic.history.shift();
    const cleared = result === 'cleared';
    automatic.stage = cleared ? 'prepare' : 'farm'; automatic.deadlineAt = 0; automatic.wave = null;
    automatic.nextAttemptAt = cleared ? 0 : automatic.cooldownAfterExit || !automatic.nextAttemptAt
      ? Date.now() + AUTO_INTERVAL : automatic.nextAttemptAt;
    automatic.cooldownAfterExit = false;
    automatic.rejection = null; automatic.exitRequested = false;
    savingUntil = 0;
    minimumTransition = 0; actionAt = Date.now() + 100;
    note(cleared ? 'Сервер принял волну. Прохожу следующую.' :
      'Перехожу к фарму бананов. Следующая проверка через 3 минуты.');
  }
  function retreatAutomatic(reason, now) {
    automatic.cooldownAfterExit = automatic.stage === 'push';
    automatic.stage = 'retreat'; automatic.rejection = reason; automatic.retreatAt = now;
    automatic.exitRequested = false; automatic.pauseRequestedAt = 0; automatic.invalidated = false;
    note('Возвращаюсь к фарму: ' + reason + '.');
  }
  function requestGameExit(owner, now) {
    // Do not race a clear already being processed by the server with cancellation.
    if (clearInFlight || pendingFail || owner.exitRequested) return;
    if (!owner.invalidated) { cancelBattle(); owner.invalidated = true; }
    if (engine.phase === 'idle') return;
    const exit = visibleButton(text => text === 'ВЫЙТИ ИЗ ВОЛНЫ');
    if (exit) { owner.exitRequested = true; exit.click(); return; }
    const pause = visibleButton((text, b) => b.getAttribute('aria-label') === 'Пауза');
    if (pause && !owner.pauseRequestedAt) {
      owner.pauseRequestedAt = now; pause.click(); engine.stop(); return;
    }
    // The native React exit callback also works when the local engine has cleared
    // but the server has not made the victory overlay available yet.
    if (nativeExit && (!owner.pauseRequestedAt || now - owner.pauseRequestedAt >= 1000)) {
      owner.exitRequested = true;
      Promise.resolve().then(() => nativeExit()).catch(e => {
        if (active) stop('Не удалось выйти из волны: ' + e.message);
      });
    }
  }
  async function automaticStep(now) {
    if (['push', 'retreat'].includes(automatic.stage) && automatic.wave !== null && stats.best >= automatic.wave) {
      finishAutomatic('cleared');
    }
    if (automatic.stage === 'push') {
      if (automatic.rejection || engine.phase === 'failed' && automatic.wave !== null || now >= automatic.deadlineAt) {
        retreatAutomatic(automatic.rejection || (engine.phase === 'failed' ? 'failed' : 'timeout'), now);
      }
    }
    if (automatic.stage === 'retreat') {
      requestGameExit(automatic, now);
      if (engine.phase === 'idle' && !pendingFail && !clearInFlight) finishAutomatic(automatic.rejection);
      else if (now - automatic.retreatAt >= 30000) stop('Не удалось выйти из волны за 30 секунд. Перезапусти makaka.');
      return true;
    }
    if (automatic.stage === 'farm' && now >= automatic.nextAttemptAt) {
      automatic.stage = 'prepare';
      note('Три минуты прошли. Завершаю фарм и готовлю попытку волны.');
    }
    if (automatic.stage === 'prepare') {
      if (pendingFail || busy) return true;
      if (!['idle', 'failed', 'cleared'].includes(engine.phase) || waitingForKills) return false;
      if (now < nextRequest) return true;
      if (needsSync) {
        const result = await request('/api/state');
        if (result) needsSync = false;
        return true;
      }
      if (!active || cfg.mode !== 'auto') return true;
      automatic.stage = 'push'; automatic.wave = null;
      automatic.nextAttemptAt = 0;
      automatic.deadlineAt = Date.now() + AUTO_TIMEOUT;
      automatic.rejection = null;
      note('Прохожу волны подряд. Урон покупается по мере накопления.');
    }
    return false;
  }
  async function exitWave() {
    if (exiting) throw new Error('Выход из волны уже выполняется.');
    exiting = true;
    stop('Проверка: выхожу из волны через паузу.');
    const owner = { exitRequested: false, pauseRequestedAt: 0, invalidated: false };
    const until = Date.now() + 30000;
    try {
      while (engine?.phase !== 'idle' || pendingFail || clearInFlight) {
        if (Date.now() >= until) throw new Error('Игра не завершила выход из волны за 30 секунд.');
        requestGameExit(owner, Date.now());
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!owner.invalidated) cancelBattle();
      return summary();
    } finally { exiting = false; }
  }
  function stop(reason = 'Остановлено. Бой поставлен на паузу.', keepGear = false) {
    active = false;
    if (!keepGear && cfg.gearAuto) { cfg = { ...cfg, gearAuto: false }; saveConfig(); syncControls(); }
    requestAbort?.abort();
    disableBuiltinAuto();
    if (engine && ['running', 'cleared'].includes(engine.phase)) {
      const pause = visibleButton((text, b) => b.getAttribute('aria-label') === 'Пауза');
      pause?.click();
      engine.stop();
    }
    restore?.(); restore = null;
    note(reason);
    render();
  }
  function start(options = {}) {
    if (exiting) { note('Дождись выхода из предыдущей волны.'); return false; }
    if (externallyStale) { note('После сброса сервером нужна перезагрузка игры.'); render(); return false; }
    cfg = cleanConfig({ ...cfg, ...options }); saveConfig(); syncControls();
    visibleButton(text => text === 'Игра')?.click();
    if (!refreshBridge()) {
      note('Игра ещё загружается. Открой вкладку «Игра» и повтори запуск.'); render(); return false;
    }
    if (active) { render(); return true; }
    active = true; startedAt = Date.now(); progressAt = Date.now();
    if (!accountingStartedAt) accountingStartedAt = startedAt;
    errors = 0; backoff = 0; nextRequest = 0; recovering = false; failCount = 0;
    runtimeFarmKills = 0;
    automatic.stage = 'prepare'; automatic.nextAttemptAt = 0; automatic.cooldownAfterExit = false;
    automatic.deadlineAt = 0; automatic.wave = null; automatic.rejection = null;
    restore?.(); restore = patchEngine(engine, combatConfig, stats);
    disableBuiltinAuto();
    note(cfg.mode === 'auto' ? 'Автомат: волны подряд; при отказе — фарм бананов 3 минуты. Покупаю урон при наличии денег.' :
      cfg.mode === 'paced' ? 'Проверка: обычные враги у центра, босс получает урон постепенно.' :
      cfg.mode === 'farmer' ? 'Фармер включён. Покупки отложены до цели накопления.' :
      cfg.mode === 'survival' ? 'Штатная стрельба и защита от урона включены.' :
      cfg.mode === 'normal' ? 'Автотап и улучшения включены.' : 'Локальный режим «' +
      (cfg.mode === 'maximum' ? 'Максимум' : 'Турбо') + '» включён.');
    render(); return true;
  }
  async function step() {
    if (!installed || !active) return;
    const now = Date.now();
    if (now - lastBridgeAt > 800) refreshBridge();
    if (!engine || !latest) return;
    if (cfg.sessionMinutes > 0 && now - startedAt >= cfg.sessionMinutes * 60000) return stop('Заданный сеанс завершён.');
    if (!['auto', 'farmer'].includes(cfg.mode) && cfg.targetWave > 0 && stats.best >= cfg.targetWave) return stop('Цель достигнута: сервер сохранил волну ' + stats.best + '.');
    disableBuiltinAuto();
    if (document.hidden) {
      hiddenPause = true;
      message = 'Вкладка скрыта. Продолжу, когда ты вернёшься.';
      return;
    }
    if (hiddenPause) { hiddenPause = false; progressAt = now; }
    if (cfg.mode === 'auto') {
      maintainDamage(now);
      const handled = await automaticStep(now);
      if (!active) return;
      maintainFarmIncome(now);
      if (handled) return;
    }
    const combat = combatConfig(), mode = combat.mode;
    if (cfg.mode === 'farmer') maintainFarmIncome(now);
    const front = engine.cats?.find(c => c.state !== 'dying' && !c.deco);
    const mark = [engine.wave?.wave, engine.phase, engine.killed, front?.hp, stats.best].join(':');
    if (mark !== progressMark) { progressMark = mark; progressAt = now; }
    if (engine.phase === 'running' && engine.running && now - progressAt > 90000) {
      if (cfg.mode === 'auto') { retreatAutomatic('no_progress', now); return; }
      return stop('Бой не меняется 90 секунд. Проверь окно игры.');
    }
    if (engine.phase !== lastPhase) {
      lastPhase = engine.phase;
      if (lastPhase === 'cleared') {
        minimumTransition = now + 2800;
        note(stats.best >= engine.wave?.wave ? 'Сервер сохранил пройденную волну.' :
          'Локальный бой завершён. Ожидаю сохранения сервером.');
      }
      if (lastPhase === 'failed') {
        const wave = engine.wave?.wave;
        failCount = failedWave === wave ? failCount + 1 : 1;
        failedWave = wave;
        recovering = cfg.mode === 'normal' && failCount >= 3;
        note(recovering ? 'Три поражения: коплю на улучшение.' : 'Поражение. Подготовлю следующий бой.');
        minimumTransition = now + 2500;
      }
    }
    if (cfg.mode === 'farmer' && cfg.farmTarget > 0 && latest.bananas >= cfg.farmTarget && engine.phase === 'idle') {
      if (cfg.targetWave > 0 && stats.best >= cfg.targetWave) {
        return stop('Цели накопления и прохождения волн достигнуты.');
      }
      cfg = cleanConfig({ ...cfg, mode: 'paced', speed: 1, autoUpgrade: true });
      saveConfig(); syncControls();
      note('Цель накопления достигнута. Покупаю улучшения и прохожу волны.');
    }
    if (mode === 'farmer' && engine.phase === 'running') {
      const plan = planForFarm(engine.wave, combat.speed, combat.farmKills);
      if (plan.kills > 0 && engine.killed >= plan.kills) {
        if (acceptedWave !== engine.wave.wave || acceptedKills < plan.kills) {
          if (earlyReportedWave !== engine.wave) {
            earlyReportedWave = engine.wave;
            farmConfirmStartedAt = now;
            if (reportKills) Promise.resolve().then(() => reportKills()).catch(() => {});
          }
          message = 'Фарм: сервер подтвердил ' + acceptedKills + '/' + plan.kills + ' убийств.';
          if (cfg.mode === 'auto' && now - farmConfirmStartedAt >= 30000) {
            runtimeFarmKills = Math.max(1, Math.min(plan.kills - 1, acceptedKills || plan.kills - 1));
            retreatAutomatic('farm_confirmation_timeout', now);
          }
          return;
        }
        const exit = visibleButton(text => text === 'ВЫЙТИ ИЗ ВОЛНЫ');
        if (exit && !pendingFail && now - farmRetreatAt > 250) {
          farmRetreatAt = now; actionAt = now + 100;
          stats.farmCycles++;
          farmCycles.push({ at: new Date().toISOString(), wave: engine.wave.wave,
            kills: acceptedKills, targetKills: plan.kills,
            reward: engine.wave.cats.slice(0, acceptedKills).reduce((sum, cat) => sum + cat.reward, 0),
            seconds: trial ? Math.round((now - trial.startedAt) / 100) / 10 : null,
            bananas: latest.bananas });
          if (farmCycles.length > 100) farmCycles.shift();
          exit.click(); note('Фарм: награда сохранена. Перезапускаю волну.');
        } else if (!exit) {
          visibleButton((text, b) => b.getAttribute('aria-label') === 'Пауза')?.click();
        }
        return;
      }
    }
    if (!recovering && !pendingFail && now >= actionAt && now >= minimumTransition) {
      const resume = visibleButton(text => text === 'ПРОДОЛЖИТЬ');
      const begin = visibleButton(text => ['В бой!', 'РЕВАНШ', 'ДАЛЬШЕ', 'СРАЗУ'].includes(text));
      // The clear overlay appears only after the real game's clear request succeeds.
      const button = resume || begin;
      if (button) {
        button.click(); actionAt = now + 2200; progressAt = now; stats.starts++;
        note(resume ? 'Бой продолжен.' : 'Начинаю следующую волну.');
      }
    }
    if (['auto', 'farmer'].includes(cfg.mode) || busy || now < nextRequest || !authorization) return;
    if (needsSync) {
      const result = await request('/api/state');
      if (result) needsSync = false;
      return;
    }
    const ratio = engine.maxHp ? engine.hp / engine.maxHp : 1;
    if (cfg.mode !== 'farmer' && cfg.autoUpgrade && now >= upgradeAt) {
      const choice = chooseCombatUpgrade(latest, ratio, cfg.reserve);
      if (choice) {
        const result = await request('/api/upgrade', { kind: choice.kind });
        upgradeAt = now + 2500;
        if (result) {
          stats.spent += choice.cost; recovering = false; failCount = 0;
          note('Куплено улучшение: ' + ({ dmg: 'урон', auto: 'крит', hp: 'здоровье' }[choice.kind]) + '.');
        }
        return;
      }
    }
    const serverNow = now / 1000 + stateSkew;
    const pending = Math.min(latest.stats.gen * latest.stats.storage_hours,
      latest.stats.gen * Math.max(0, serverNow - latest.mine.since) / 3600);
    if (cfg.collect && pending >= 1 && now >= collectAt) {
      collectAt = now + 30000;
      const result = await request('/api/mine/collect');
      if (result) note('Собран доход генератора.');
      return;
    }
    if (cfg.mine && latest.stats.autoclick > 0 && latest.features?.autoclick !== false && now >= autoAt) {
      autoAt = now + 5000;
      await request('/api/mine/auto'); return;
    }
    if (recovering && cfg.autoUpgrade && now >= upgradeAt) {
      const choice = economyChoice(latest, cfg.reserve);
      if (choice) {
        upgradeAt = now + 3000;
        const result = await request('/api/upgrade', { kind: choice.kind });
        if (result) { stats.spent += choice.cost; note('Улучшен доход: ' + choice.kind + '.'); }
        return;
      }
    }
    if (cfg.mine) {
      const taps = tapCount(latest, serverNow);
      if (taps > 0) await request('/api/mine/tap', { taps });
    }
  }

  function maintainFarmIncome(now) {
    if (busy || now < nextRequest || !authorization || !latest) return;
    if (needsSync) {
      request('/api/state').then(result => { if (result) needsSync = false; });
      return;
    }
    const serverNow = now / 1000 + stateSkew;
    const pending = Math.min(latest.stats.gen * latest.stats.storage_hours,
      latest.stats.gen * Math.max(0, serverNow - latest.mine.since) / 3600);
    if (cfg.collect && pending >= 1 && now >= collectAt) {
      collectAt = now + 30000;
      request('/api/mine/collect').then(result => { if (result) note('Собран доход генератора.'); });
    } else if (cfg.mine && latest.stats.autoclick > 0 && latest.features?.autoclick !== false && now >= autoAt) {
      autoAt = now + 5000;
      request('/api/mine/auto');
    } else if (cfg.mine) {
      const taps = tapCount(latest, serverNow);
      if (taps > 0) request('/api/mine/tap', { taps });
    }
  }

  function summary() {
    stats.gained = latest && baselineBalance !== null ? latest.bananas - baselineBalance + stats.spent : 0;
    return {
      version: VERSION, active, config: { ...cfg }, message,
      automation: cfg.mode === 'auto' ? { ...automatic, history: automatic.history.slice(),
        combatMode: combatConfig().mode,
        nextAttemptSeconds: automatic.nextAttemptAt ? Math.max(0, Math.ceil((automatic.nextAttemptAt - Date.now()) / 1000)) : null,
        attemptSecondsLeft: automatic.deadlineAt ? Math.max(0, Math.ceil((automatic.deadlineAt - Date.now()) / 1000)) : null } : null,
      server: latest ? { wave: latest.battle.wave, bestWave: latest.battle.max_wave,
        bananas: latest.bananas, upgrades: latest.upgrades, damage: latest.stats.dmg, nextDamage: latest.stats.next?.dmg } : null,
      battle: engine ? { phase: engine.phase, wave: engine.wave?.wave,
        hp: engine.hp, maxHp: engine.maxHp, killed: engine.wave ? engine.killed : 0,
        total: engine.wave?.cats?.length ?? 0, paused: !engine.running } : null,
      stats: { ...stats }, seconds: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0,
      saveWaitSeconds: Math.max(0, Math.ceil((savingUntil - Date.now()) / 1000)),
      lastBattleError,
      serverKills: { wave: acceptedWave, counted: acceptedKills, waiting: waitingForKills,
        target: combatConfig().mode === 'farmer' ? planForFarm(engine?.wave, combatConfig().speed, combatConfig().farmKills).kills : engine?.wave?.cats?.length },
      farmReportReady: !!reportKills,
      exitReady: !!nativeExit, battleGeneration, clearInFlight,
      currentTrial: trial ? JSON.parse(JSON.stringify(trial)) : null,
      trials: JSON.parse(JSON.stringify(trials)),
      farmCycles: JSON.parse(JSON.stringify(farmCycles)),
      incomePerMinute: accountingStartedAt ? Math.round(stats.gained / Math.max(0.05, (Date.now() - accountingStartedAt) / 60000)) : 0,
      gearLoop: window.MakakaPilot?.gear?.status?.() || null,
      authorizationReady: !!authorization, log: log.slice(-40),
    };
  }
  function download() {
    const blob = new Blob([JSON.stringify(summary(), null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob); link.download = 'makaka-pilot-report.json';
    link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
  function buildPanel() {
    if (host || !document.body) return;
    host = document.createElement('div'); host.id = 'makaka-pilot';
    host.style.cssText = 'position:fixed;right:10px;top:8px;z-index:2147483000;max-width:calc(100vw - 20px);color-scheme:dark';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host{all:initial;font:13px/1.4 system-ui,sans-serif;color:#f1e8d0}
      *{box-sizing:border-box}button,select,input{font:inherit}button,select{cursor:pointer}
      details{width:282px;border:1px solid #776236;border-radius:12px;background:#171b15;box-shadow:0 5px 24px #0008;overflow:hidden}
      summary{padding:10px 12px;cursor:pointer;background:#272d20;font-weight:700;list-style:none}
      summary:before{content:'▸';margin-right:8px;color:#f4ca55}details[open] summary:before{content:'▾'}
      section{padding:10px 12px}label{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
      select,input[type=number]{background:#0d120c;color:#f1e8d0;border:1px solid #5b654d;border-radius:5px;padding:4px;width:127px}
      input[type=checkbox]{accent-color:#e8c54e}input[type=number]{width:80px}
      .row{display:flex;gap:7px}button{border:1px solid #69764e;background:#39472b;color:#fff0bc;padding:7px 10px;border-radius:6px}
      .row button{flex:1}.stop{background:#623d30}#data{white-space:pre-line;padding:9px;background:#0e140c;border-radius:6px;margin-bottom:9px}
      #msg{min-height:38px;color:#c3ceb8;font-size:12px;margin:8px 0}small{display:block;color:#a5af9b;font-size:11px;margin:6px 0}
      .footer{display:flex;justify-content:space-between}.footer button{border:0;background:none;font-size:11px;padding:3px}
    </style>
    <details><summary id="badge">MK Pilot · готов</summary><section>
      <label>Режим <select id="mode"><option value="auto">Автомат: фарм + волны</option><option value="farmer">Фармер бананов</option><option value="paced">Бой у центра (опытный)</option><option value="survival">Защита</option><option value="normal">Обычный</option><option value="turbo">Турбо (опытный)</option><option value="maximum">Максимум (опытный)</option></select></label>
      <label>Скорость боя <select id="speed"><option value="1">×1</option><option value="2">×2</option><option value="4">×4</option><option value="8">×8</option></select></label>
      <small id="explain"></small>
      <div id="data">Ожидаю загрузки игры…</div>
      <label>Покупать боевые улучшения <input id="autoUpgrade" type="checkbox"></label>
      <label>Подбирать снаряжение для босса <input id="gearAuto" type="checkbox"></label>
      <label>Автокликер бананов <input id="mine" type="checkbox"></label>
      <label>Собирать генератор <input id="collect" type="checkbox"></label>
      <label>Резерв бананов <input id="reserve" type="number" min="0" step="1000"></label>
      <label>Копить до (0 — без конца) <input id="farmTarget" type="number" min="0" step="10000"></label>
      <label>Цель: волна (0 — без цели) <input id="targetWave" type="number" min="0"></label>
      <label>Минут (0 — без конца) <input id="sessionMinutes" type="number" min="0" max="1440"></label>
      <div class="row"><button id="start">Запустить</button><button id="stop" class="stop">Стоп</button></div>
      <div id="msg"></div>
      <small>Скрытая вкладка ставит игру на паузу. Звёзды и казино не используются.</small>
      <div class="footer"><button id="report">Скачать отчёт</button><button id="remove">Убрать скрипт</button></div>
    </section></details>`;
    for (const key of Object.keys(DEFAULTS)) {
      const input = shadow.getElementById(key);
      if (!input) continue;
      if (input.type === 'checkbox') input.checked = cfg[key]; else input.value = String(cfg[key]);
      input.addEventListener('change', () => {
        const value = input.type === 'checkbox' ? input.checked : input.value;
        cfg = cleanConfig({ ...cfg, [key]: value }); saveConfig(); render();
      });
    }
    shadow.getElementById('start').onclick = () => start();
    shadow.getElementById('stop').onclick = () => stop();
    shadow.getElementById('report').onclick = download;
    shadow.getElementById('remove').onclick = uninstall;
    host.addEventListener('pointerdown', e => e.stopPropagation());
    document.body.append(host);
    render();
  }
  function render() {
    if (!shadow) return;
    shadow.getElementById('mode').disabled = active;
    shadow.getElementById('speed').disabled = active;
    shadow.getElementById('gearAuto').disabled = cfg.mode === 'auto';
    shadow.getElementById('autoUpgrade').disabled = cfg.mode === 'auto';
    shadow.getElementById('reserve').disabled = cfg.mode === 'auto';
    const wave = latest?.battle.max_wave;
    shadow.getElementById('badge').textContent = 'MK Pilot · ' + (active ? 'работает' : 'стоп') +
      (wave != null ? ' · рекорд ' + wave : '');
    shadow.getElementById('explain').textContent = cfg.mode === 'auto'
      ? 'Прохожу волны подряд. При отказе фармлю бананы 3 минуты. Покупаю урон при наличии полной цены.'
      : cfg.mode === 'paced'
      ? 'Обычные враги погибают у центра. Босс теряет здоровье по мере движения. Зачёт подтверждает сервер.'
      : cfg.mode === 'farmer'
      ? 'Убиваю выгодную пачку, жду зачёта награды и перезапускаю бой. Покупки — после накопления цели.'
      : cfg.mode === 'survival'
      ? 'Защита от урона, штатные урон и скорострельность. Скорость ×1. Рекомендуется для продвижения.'
      : cfg.mode === 'normal'
      ? 'Штатная скорострельность, выбор улучшений, восстановление после поражений. Скорость ×1.'
      : cfg.mode === 'turbo'
        ? 'Защита от урона и ускоренная стрельба. Урон за выстрел остаётся штатным.'
        : 'Защита от урона, один выстрел на противника и ускорение локального боя.';
    const n = v => Math.floor(v || 0).toLocaleString('ru-RU');
    shadow.getElementById('data').textContent = latest
      ? 'Сохранённая волна: ' + n(latest.battle.max_wave) + '\nБананы: ' + n(latest.bananas) +
        '\nБой: ' + n(engine?.wave?.wave || latest.battle.wave) + ' · ' + n(engine?.killed) + '/' + n(engine?.wave?.cats?.length) +
        '\nЗдоровье: ' + n(engine?.hp) + '/' + n(engine?.maxHp) +
        '\nФарм: ' + n(stats.farmCycles) + ' забегов · ' + n(summary().incomePerMinute) + '/мин' +
        (cfg.mode === 'auto' ? '\nАвтомат: ' + ({ farm: 'фарм', prepare: 'подготовка', push: 'попытка волны', retreat: 'возврат к фарму' }[automatic.stage]) +
          (automatic.nextAttemptAt ? ' · проверка через ' + n(summary().automation.nextAttemptSeconds) + ' с' : '') : '')
      : 'Ожидаю загрузки игры…';
    const waitSeconds = Math.max(0, Math.ceil((savingUntil - Date.now()) / 1000));
    shadow.getElementById('msg').textContent = waitingForKills
      ? 'Сервер подтвердил ' + acceptedKills + '/' + (engine?.wave?.cats?.length || '?') + ' убийств. Ожидаю принятия волны.'
      : waitSeconds > 0 ? 'Сохранение прогресса: ожидание ' + waitSeconds + ' с по времени появления противников.' : message;
    for (const button of document.querySelectorAll('main button')) {
      if (/^(Урон|Крит|Хилки)(?:\s|$)/.test(button.innerText.trim())) {
        if (active && ['auto', 'farmer'].includes(cfg.mode)) { button.dataset.mkFarmLocked = '1'; button.disabled = true; }
        else if (button.dataset.mkFarmLocked) { delete button.dataset.mkFarmLocked; button.disabled = false; }
      }
    }
  }
  function onKey(event) {
    if (event.altKey && event.code === 'KeyM' && !event.repeat) {
      event.preventDefault(); active ? stop() : start();
    }
  }
  function uninstall() {
    if (!installed) return;
    stop('Скрипт удалён из текущей страницы.'); installed = false;
    clearInterval(loopTimer); clearInterval(renderTimer);
    document.removeEventListener('keydown', onKey);
    if (window.fetch === observedFetch) window.fetch = nativeFetch;
    authorization = null; host?.remove();
    delete window.MakakaPilot;
  }
  const api = {
    version: VERSION, start, stop, exitWave, status: summary, uninstall,
    async top(by = 'wave') {
      if (!['wave', 'bananas'].includes(by)) throw new Error('Неизвестный вид рейтинга.');
      if (!authorization) throw new Error('Данные входа ещё не получены.');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await nativeFetch.call(window, '/api/top?by=' + by, {
          method: 'GET', credentials: 'same-origin', signal: controller.signal,
          headers: { Authorization: authorization },
        });
        if (!response.ok) throw new Error('Рейтинг временно недоступен.');
        return await response.json();
      } finally { clearTimeout(timer); }
    },
    configure(options) {
      cfg = cleanConfig({ ...cfg, ...options }); saveConfig();
      syncControls();
      render(); return { ...cfg };
    },
    show() { if (shadow) shadow.querySelector('details').open = true; },
    async verify() {
      if (busy) throw new Error('Сначала дождись завершения текущего запроса.');
      busy = true;
      try { await post('/api/state'); return summary(); }
      finally { busy = false; }
    },
    report: download,
    casino: casinoExpected,
  };
  window.MakakaPilot = api;
  document.addEventListener('keydown', onKey);
  loopTimer = setInterval(() => {
    buildPanel();
    const now = Date.now();
    if (active && !stepping && now - lastStepAt >= (['auto', 'farmer'].includes(cfg.mode) ? 100 : 250)) {
      lastStepAt = now;
      stepping = true;
      step().catch(e => stop('Ошибка контроллера: ' + e.message)).finally(() => { stepping = false; });
    }
  }, 100);
  renderTimer = setInterval(() => { if (!active) refreshBridge(); render(); }, 1000);
  buildPanel(); refreshBridge();
})();

// Coordinate one gear upgrade at a time after a failed boss attempt.
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.MakakaPilot) return;
  const pilot = window.MakakaPilot;
  let stage = 'idle', plan = null, lastKey = '', internalExit = false;
  const history = [];
  const key = s => [s.server.upgrades.dmg.level, s.server.upgrades.auto.level].join(':');
  function record(action, extra = {}) {
    history.push({ at: new Date().toISOString(), action, ...extra });
    if (history.length > 60) history.shift();
  }
  function button(match) {
    return [...document.querySelectorAll('button')].find(b =>
      b.getClientRects().length && !b.disabled && match(b.innerText.trim(), b));
  }
  function beginFarm(s) {
    const candidates = ['dmg', 'auto'].map(kind => ({ kind, ...s.server.upgrades[kind] }))
      .filter(x => Number.isFinite(x.cost) && x.cost > 0).sort((a, b) => a.cost - b.cost);
    const candidate = candidates[0];
    if (!candidate) { pilot.stop('Нет доступного боевого улучшения.'); return false; }
    plan = { kind: candidate.kind, cost: candidate.cost, key: key(s), levels: {
      damage: s.server.upgrades.dmg.level, critical: s.server.upgrades.auto.level } };
    lastKey = plan.key; stage = 'exit'; internalExit = true;
    pilot.stop('Сервер отклонил босса. Коплю на следующий уровень снаряжения.', true);
    record('farm_for_upgrade', { ...plan });
    return true;
  }
  pilot.gear = {
    status() { return { stage, plan: plan ? { ...plan } : null, history: history.slice() }; },
    farmNow() { pilot.configure({ gearAuto: true }); return beginFarm(pilot.status()); },
    start() { pilot.configure({ gearAuto: true, mode: 'paced', autoUpgrade: false }); pilot.start(); },
    stop() { pilot.configure({ gearAuto: false }); stage = 'idle'; plan = null; },
  };
  const timer = setInterval(() => {
    if (window.MakakaPilot !== pilot) { clearInterval(timer); return; }
    const s = pilot.status();
    if (!s.config.gearAuto || s.config.mode === 'auto' || !s.server || !s.battle) { stage = 'idle'; return; }
    if (s.server.bestWave >= s.config.targetWave && s.config.targetWave > 0) {
      stage = 'done'; return;
    }
    if (stage === 'idle' && s.active) stage = s.config.mode === 'farmer' ? 'farm' : 'push';
    if (stage === 'push') {
      if (!s.active) { pilot.configure({ gearAuto: false }); stage = 'idle'; return; }
      const failures = s.currentTrial?.attempts.filter(a => a.status === 409).length || 0;
      const trialGear = s.currentTrial?.gear;
      const fresh = trialGear && [trialGear.damage, trialGear.critical].join(':') === key(s);
      if (s.config.mode === 'paced' && fresh && failures >= 2 && key(s) !== lastKey) beginFarm(s);
      return;
    }
    if (stage === 'exit' || stage === 'exit_push') {
      if (s.battle.phase === 'idle' || s.battle.phase === 'failed') {
        if (stage === 'exit_push') {
          pilot.configure({ mode: 'paced', speed: 1, autoUpgrade: false, mine: false, collect: false });
          pilot.start(); stage = 'push'; internalExit = false;
        } else {
          pilot.configure({ mode: 'farmer', speed: 8, autoUpgrade: false, mine: true, collect: true,
            farmTarget: plan.cost + s.config.reserve });
          pilot.start(); stage = 'farm'; internalExit = false;
        }
      } else {
        const exit = button(text => text === 'ВЫЙТИ ИЗ ВОЛНЫ');
        if (exit) exit.click();
        else button((text, b) => b.getAttribute('aria-label') === 'Пауза')?.click();
      }
      return;
    }
    if (stage === 'farm') {
      if (!s.active && !internalExit) { pilot.configure({ gearAuto: false }); stage = 'idle'; return; }
      if (s.config.mode === 'paced' && plan && key(s) !== plan.key) {
        record('upgrade_completed', { before: plan.levels,
          after: { damage: s.server.upgrades.dmg.level, critical: s.server.upgrades.auto.level },
          balance: s.server.bananas });
        pilot.configure({ autoUpgrade: false, speed: 1 });
        stage = 'exit_push'; internalExit = true; plan = null;
        pilot.stop('Улучшение куплено. Перезапускаю проверку с новым снаряжением.', true);
      }
    }
  }, 750);
})();
