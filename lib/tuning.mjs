export const TUNE_PREFIXES = Object.freeze(Array.from({ length: 16 }, (_, i) => i + 1));

export function rankFarmSamples(samples) {
  return samples.filter(s => Number.isFinite(s.gain) && s.gain > 0 &&
    Number.isFinite(s.seconds) && s.seconds > 0 && Number.isInteger(s.cycles) && s.cycles >= 2)
    .map(s => ({ ...s, perMinute: s.gain / s.seconds * 60 }))
    .sort((a, b) => b.perMinute - a.perMinute);
}

export async function tuneFarm(page, { stopped, readStop, log = console.log, prefixes = TUNE_PREFIXES, cycles = 2 }) {
  const samples = [];
  for (const kills of prefixes) {
    if (stopped() || await readStop()) return null;
    log(`Проверяю пачку: ${kills} убийств, циклов: ${cycles}…`);
    const started = await page.evaluate(({ kills, cycles }) => {
      const p = window.MakakaPilot, before = p.status();
      const gearKey = state => JSON.stringify(Object.entries(state.server.upgrades).map(([key, value]) => [key, value.level]));
      const b = window.__mkTune = { started: Date.now(), beforeCycles: before.stats.farmCycles,
        beforeBananas: before.server.bananas, gear: gearKey(before), wave: before.server.wave, finished: false };
      const ok = p.start({ mode: 'farmer', speed: 8, farmKills: kills, farmTiming: 'legacy', farmTarget: 0,
        targetWave: 0, autoUpgrade: false, gearAuto: false, mine: false, collect: false, sessionMinutes: 3 });
      if (!ok) return false;
      b.timer = setInterval(() => {
        const s = p.status();
        if (gearKey(s) !== b.gear || s.server.wave !== b.wave || s.config.mode !== 'farmer' || s.config.farmKills !== kills) {
          const reason = 'Подбор прерван: изменились снаряжение, волна или режим.';
          p.stop(reason); clearInterval(b.timer); b.error = reason;
        } else if (s.stats.farmCycles - b.beforeCycles >= cycles && s.battle?.phase === 'idle' && !s.transitioning) {
          p.stop('Пачка измерена.'); clearInterval(b.timer);
          b.finished = { kills, cycles: s.stats.farmCycles - b.beforeCycles,
            gain: s.server.bananas - b.beforeBananas, seconds: (Date.now() - b.started) / 1000 };
        } else if (!s.active) { clearInterval(b.timer); b.error = s.message; }
      }, 50);
      return true;
    }, { kills, cycles });
    if (!started) throw new Error('Не удалось начать измерение пачки. Перезагрузи игру.');
    const deadline = Date.now() + 190000;
    let result;
    while (Date.now() < deadline) {
      if (stopped() || await readStop()) return null;
      const b = await page.evaluate(() => ({ finished: window.__mkTune.finished, error: window.__mkTune.error }));
      if (b.error) throw new Error('Подбор прерван: ' + b.error);
      if (b.finished) { result = b.finished; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!result) throw new Error('Сервер не завершил измерение пачки за три минуты.');
    samples.push(result);
    log(`${kills}: ${Math.round(result.gain / result.seconds * 60).toLocaleString('ru-RU')} бананов/мин по серверному балансу.`);
  }
  return rankFarmSamples(samples);
}
