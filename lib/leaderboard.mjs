import { safeText } from './core.mjs';

export function normalizeTop(data, by, checkedAt = new Date().toISOString()) {
  if (data?.by !== by || !Array.isArray(data.rows)) throw new Error('Неизвестный формат рейтинга.');
  const count = value => Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  const rank = count(data.me?.rank);
  return { checkedAt, stale: false, rank: rank > 0 ? rank : null,
    value: count(by === 'wave' ? data.me?.max_wave : data.me?.earned),
    leaders: data.rows.slice(0, 3).map((row, i) => ({
      place: i + 1,
      name: safeText([row.first_name, row.last_name].filter(Boolean).join(' ') ||
        (row.username ? '@' + row.username : 'Макака')).slice(0, 80),
      value: count(by === 'wave' ? row.max_wave : row.earned),
    })) };
}

export function createRankings({ now = Date.now } = {}) {
  let cache = {}, generation = 0, busy = false, refreshAt = 0;
  return {
    snapshot() { return structuredClone(cache); },
    reset() { generation++; busy = false; refreshAt = 0; cache = {}; },
    async refresh(page) {
      if (busy || now() < refreshAt) return;
      const ownGeneration = generation;
      busy = true; refreshAt = now() + 60000;
      try {
        const kinds = ['wave', 'bananas'];
        const results = await Promise.allSettled(kinds.map(async by => {
          const data = await page.evaluate(by => window.MakakaPilot.top(by), by);
          return normalizeTop(data, by, new Date(now()).toISOString());
        }));
        if (ownGeneration !== generation) return;
        results.forEach((result, i) => {
          const key = kinds[i];
          cache[key] = result.status === 'fulfilled' ? result.value : {
            ...cache[key], stale: true, error: 'Рейтинг недоступен; повтор через минуту.',
          };
        });
      } finally { if (ownGeneration === generation) busy = false; }
    },
  };
}
