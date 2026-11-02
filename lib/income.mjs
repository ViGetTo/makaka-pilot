import { setTimeout as delay } from 'node:timers/promises';

export async function probeTapBoost(page, { stopped = () => false, readStop = async () => false } = {}) {
  if (stopped() || await readStop()) throw new Error('Проверка усиления остановлена.');
  let complete = false;
  const probe = page.evaluate(() => window.MakakaPilot.probeIncomeBoost());
  // Observe both outcomes immediately, including a rejection during the polling delay.
  const outcome = probe.then(value => ({ value }), error => ({ error })).finally(() => { complete = true; });
  while (!complete) {
    if (stopped() || await readStop()) {
      await page.evaluate(() => window.MakakaPilot.stop('Проверка усиления остановлена.'));
      await outcome;
      throw new Error('Проверка усиления остановлена.');
    }
    await delay(100);
  }
  const result = await outcome;
  if (result.error) throw result.error;
  return result.value;
}
