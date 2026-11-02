const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function classifyRestartProbe(result) {
  const { before, afterExit, afterRestart, local } = result;
  const balances = [before?.bananas, afterExit?.bananas, afterRestart?.bananas];
  if (!balances.every(Number.isFinite) || !local?.total || local.killed !== local.total ||
      before.wave !== afterExit.wave || before.wave !== afterRestart.wave ||
      before.bestWave !== afterExit.bestWave || before.bestWave !== afterRestart.bestWave ||
      JSON.stringify(before.gear) !== JSON.stringify(afterExit.gear) ||
      JSON.stringify(before.gear) !== JSON.stringify(afterRestart.gear)) {
    return { verdict: 'inconclusive', message: 'Результат неоднозначен: бой, рекорд или снаряжение изменились. Смотри probe.json.' };
  }
  const gain = afterExit.bananas - before.bananas;
  const ack = result.reports?.findLast(r => r.wave === before.wave && r.reported === local.total &&
    r.status === 200 && Number.isInteger(r.counted) && r.counted >= 0 && r.counted <= r.reported);
  if (!ack) return { verdict: 'inconclusive', gain,
    message: 'Нет подтверждённого ответа сервера на отчёт обо всех локальных убийствах. Выплата не проверена.' };
  if (afterRestart.bananas !== afterExit.bananas) {
    return { verdict: 'inconclusive', gain, message: 'Баланс изменился после перезапуска. Сохранение награды не подтверждено.' };
  }
  if (gain > 0 && ack.counted > 0) return { verdict: 'paid', gain, countedKills: ack.counted,
    message: `Сервер сохранил ${gain} бананов после выхода и перезапуска. Зачтено ${ack.counted}/${local.total} убийств. Это один опыт, а не устойчивый доход в минуту; бонус прохождения не проверялся.` };
  if (gain === 0) return { verdict: 'unpaid', gain: 0,
    message: 'Сервер не начислил бананы в этой проверке быстрого выхода. Локальные убийства не означают выплату.' };
  if (gain > 0) return { verdict: 'inconclusive', gain,
    message: 'Баланс вырос, но сервер не подтвердил ни одного убийства. Источник дохода не установлен.' };
  return { verdict: 'inconclusive', gain, message: 'Баланс уменьшился. Причину нельзя определить этой проверкой.' };
}

export async function probeFastRestart(page, { stopped = () => false, readStop = async () => false } = {}) {
  const result = { measuredAt: new Date().toISOString(), version: '2.10.1',
    scenario: 'maximum_x8_native_kill_reports_then_pause_flush_exit_and_restart',
    mine: false, collect: false, purchases: false };
  const snapshot = async () => page.evaluate(() => {
    const s = window.MakakaPilot.status();
    return { ...s.server, gear: Object.fromEntries(Object.entries(s.server.upgrades || {})
      .map(([key, value]) => [key, value.level])), upgrades: undefined };
  });
  const waitUntil = async (fn, arg, timeout = 45000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (stopped() || await readStop()) throw new Error('Проверка остановлена.');
      const value = await page.evaluate(fn, arg);
      if (value) return value;
      await sleep(50);
    }
    throw new Error('Игра не завершила этап проверки за 45 секунд.');
  };
  try {
    await page.evaluate(async () => { await window.MakakaPilot.exitWave(); await window.MakakaPilot.verify(); });
    result.before = await snapshot();
    const previous = await page.evaluate(() => {
      const p = window.MakakaPilot, generation = p.status().currentTrial?.generation;
      if (!p.start({ mode: 'maximum', speed: 8, probe: 'fast-restart', mine: false, collect: false,
        autoUpgrade: false, gearAuto: false, farmTarget: 0, targetWave: 0, sessionMinutes: 1 })) {
        throw new Error('Не удалось запустить проверку.');
      }
      return generation ?? null;
    });
    result.local = await waitUntil(generation => {
      const s = window.MakakaPilot.status();
      if (!s.active) throw new Error(s.message);
      if (s.currentTrial?.generation === generation) return null;
      if (!s.battle?.total || s.battle.killed < s.battle.total) return null;
      return { wave: s.battle.wave, killed: s.battle.killed, total: s.battle.total,
        seconds: (Date.now() - s.currentTrial.startedAt) / 1000 };
    }, previous);
    await page.evaluate(async () => {
      await window.MakakaPilot.exitWave({ flushKills: true });
      await window.MakakaPilot.verify();
    });
    result.afterExit = await snapshot();
    result.reports = await page.evaluate(() => window.MakakaPilot.status().currentTrial?.killReports || []);
    const generation = await page.evaluate(() => {
      const p = window.MakakaPilot, generation = p.status().currentTrial?.generation;
      if (!p.start({ mode: 'normal', speed: 1, mine: false, collect: false,
        autoUpgrade: false, gearAuto: false, farmTarget: 0, targetWave: 0, sessionMinutes: 1 })) {
        throw new Error('Не удалось перезапустить волну.');
      }
      return generation ?? null;
    });
    await waitUntil(generation => {
      const p = window.MakakaPilot, s = p.status();
      if (!s.active) throw new Error(s.message);
      if (!s.currentTrial || s.currentTrial.generation === generation) return false;
      p.stop('Перезапуск проверен.');
      return true;
    }, generation);
    await page.evaluate(() => window.MakakaPilot.verify());
    result.afterRestart = await snapshot();
    return { ...result, ...classifyRestartProbe(result) };
  } finally {
    await page.evaluate(() => window.MakakaPilot.exitWave());
  }
}
