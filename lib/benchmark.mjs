const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function chooseFarmBenchmark(samples) {
  if (samples.length !== 2 || samples.some(s => !Number.isInteger(s.cycles) || s.cycles < 5 ||
      !Number.isFinite(s.seconds) || s.seconds <= 0 || !Number.isFinite(s.gain) || s.gain <= 0) ||
      samples[0].profile !== samples[1].profile) throw new Error('Нет двух сопоставимых полных замеров.');
  const measured = samples.map(s => ({ ...s, perMinute: s.gain / s.seconds * 60 }));
  const improvement = measured[1].perMinute / measured[0].perMinute - 1;
  const improved = improvement >= 0.05;
  const selected = measured[improved ? 1 : 0];
  return { samples: measured, improvement, improved, selected, goalReached: selected.perMinute >= 100000 };
}

export async function benchmarkFarm(page, { stopped = () => false, readStop = async () => false, log = console.log } = {}) {
  if (stopped() || await readStop()) return null;
  await page.waitForFunction(() => !!window.MakakaPilot?.status().farmOffer, { timeout: 15000 });
  if (stopped() || await readStop()) return null;
  const initial = await page.evaluate(() => {
    const s = window.MakakaPilot.status();
    if (!s.farmOffer?.elite) throw new Error('Не найден элитный противник для короткого забега. Замер не начат.');
    return { offer: s.farmOffer, timing: s.config.farmTiming, kills: s.config.farmKills };
  });
  const variants = [
    { label: 'Текущий фарм', farmTiming: initial.timing || 'legacy', farmKills: initial.kills || 0 },
    { label: 'Короткий забег до элитного', farmTiming: 'spawn', farmKills: initial.offer.elite.kills },
  ];
  const samples = [];
  try {
    for (const variant of variants) {
      if (stopped() || await readStop()) return null;
      log(`${variant.label}: пять циклов без покупок, генератора и кликера…`);
      await page.evaluate(async () => { await window.MakakaPilot.exitWave(); await window.MakakaPilot.verify(); });
      const before = await page.evaluate(({ variant, expectedWave }) => {
        const p = window.MakakaPilot, s = p.status();
        if (s.server.wave !== expectedWave) throw new Error('Волна изменилась до начала замера.');
        const profile = JSON.stringify({ wave: s.server.wave, best: s.server.bestWave,
          damage: s.server.damage, combat: s.server.combat, economy: s.server.economy,
          gear: Object.entries(s.server.upgrades).map(([k, v]) => [k, v.level]).sort() });
        const before = { profile, bananas: s.server.bananas, spent: s.stats.spent };
        if (!p.start({ mode: 'farmer', speed: 8, ...variant, farmCycleLimit: 5, farmTarget: 0,
          targetWave: 0, autoUpgrade: false, gearAuto: false, mine: false, collect: false, sessionMinutes: 3 })) {
          throw new Error('Не удалось начать замер.');
        }
        return before;
      }, { variant, expectedWave: initial.offer.wave });
      const deadline = Date.now() + 190000;
      let complete = null, printedCycles = -1;
      while (Date.now() < deadline) {
        if (stopped() || await readStop()) return null;
        const state = await page.evaluate(() => {
          const s = window.MakakaPilot.status();
          return { active: s.active, session: s.session, transitioning: s.transitioning, message: s.message,
            config: s.config, bananas: s.server.bananas, spent: s.stats.spent,
            profile: JSON.stringify({ wave: s.server.wave, best: s.server.bestWave,
              damage: s.server.damage, combat: s.server.combat, economy: s.server.economy,
              gear: Object.entries(s.server.upgrades).map(([k, v]) => [k, v.level]).sort() }),
            cycles: s.farmCycles.slice(-5), reports: s.currentTrial?.killReports || [] };
        });
        if (state.profile !== before.profile || state.spent !== before.spent || state.config.mode !== 'farmer' ||
            state.config.farmTiming !== variant.farmTiming || state.config.farmKills !== variant.farmKills ||
            state.config.mine || state.config.collect || state.config.autoUpgrade || state.config.gearAuto) {
          throw new Error('Замер прерван: изменились волна, снаряжение, расходы или настройки.');
        }
        if (state.session.cycles !== printedCycles) {
          printedCycles = state.session.cycles;
          log(`${variant.label}: завершено циклов ${printedCycles}/5.`);
        }
        if (!state.active) {
          if (!state.session.completed) throw new Error('Замер прерван: ' + state.message);
          if (state.transitioning) { await sleep(100); continue; }
          const persisted = await page.evaluate(async () => {
            await window.MakakaPilot.verify(); return window.MakakaPilot.status().server.bananas;
          });
          if (persisted !== state.bananas) throw new Error('Баланс после проверки изменился. Замер не сохранён.');
          complete = { ...variant, profile: before.profile, cycles: state.session.cycles,
            seconds: (state.session.stoppedAt - state.session.startedAt) / 1000,
            gain: persisted - before.bananas, reports: state.reports, cyclesDetail: state.cycles };
          break;
        }
        await sleep(300);
      }
      if (!complete) throw new Error('Пять циклов не завершились за три минуты.');
      samples.push(complete);
      log(`${variant.label}: ${Math.round(complete.gain / complete.seconds * 60).toLocaleString('ru-RU')} бананов/мин.`);
    }
    return { measuredAt: new Date().toISOString(), candidate: initial.offer.elite, ...chooseFarmBenchmark(samples) };
  } finally {
    await page.evaluate(() => window.MakakaPilot.exitWave());
  }
}
