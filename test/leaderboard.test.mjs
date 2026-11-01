import { test } from 'node:test';
import assert from 'node:assert/strict';
import browser from './helpers/browser.cjs';
import { normalizeTop, createRankings } from '../lib/leaderboard.mjs';

const board = by => ({ by, me: { rank: 42, max_wave: 64, earned: 9000000, pub: 'private-id' },
  rows: [{ first_name: 'Альфа', max_wave: 300, earned: 100000000, pub: 'unneeded-id' },
    { first_name: 'Бета\x1b[2J\n', max_wave: 299, earned: 90000000 },
    { username: 'gamma', max_wave: 298, earned: 80000000 }], other: 'ignore' });

test('the official top response yields the account rank and leaders using lifetime earnings for bananas', () => {
  const wave = normalizeTop(board('wave'), 'wave');
  assert.equal(wave.rank, 42); assert.equal(wave.leaders[0].value, 300);
  assert.equal(wave.leaders[1].name, 'Бета'); assert.equal(wave.leaders[2].name, '@gamma');
  assert.equal(JSON.stringify(wave).includes('private-id'), false);
  assert.equal(JSON.stringify(wave).includes('unneeded-id'), false);
  assert.equal(normalizeTop(board('bananas'), 'bananas').value, 9000000);
  assert.throws(() => normalizeTop(board('wave'), 'bananas'));
});

test('top reads use GET and an unavailable leaderboard never stops an active battle', async () => {
  const b = browser({ top: { wave: board('wave'), bananas: board('bananas') } }); b.start();
  assert.equal((await b.pilot.top('wave')).me.rank, 42);
  assert.equal(b.sent.at(-1).method, 'GET'); assert.equal(b.sent.at(-1).path, '/api/top');
  const count = b.sent.length;
  await assert.rejects(b.pilot.top('other')); assert.equal(b.sent.length, count);
  const unavailable = browser({ topStatus: 403 }); unavailable.start();
  await assert.rejects(unavailable.pilot.top('wave'), /недоступен/);
  assert.equal(unavailable.pilot.status().active, true);
});

test('rankings refresh at most once a minute and retain explicitly stale results on failure', async () => {
  let now = 0, fail = false, calls = 0;
  const ranks = createRankings({ now: () => now });
  const page = { async evaluate(_fn, by) { calls++; if (fail) throw new Error('offline'); return board(by); } };
  await ranks.refresh(page); await ranks.refresh(page);
  assert.equal(calls, 2); assert.equal(ranks.snapshot().wave.rank, 42);
  fail = true; now = 60000; await ranks.refresh(page);
  assert.equal(calls, 4); assert.equal(ranks.snapshot().wave.rank, 42);
  assert.equal(ranks.snapshot().wave.stale, true);
  assert.match(ranks.snapshot().wave.error, /через минуту/);
});

test('results from a closed game cannot overwrite rankings fetched by a renewed session', async () => {
  const ranks = createRankings();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const old = ranks.refresh({ async evaluate(_fn, by) { await gate; return board(by); } });
  ranks.reset();
  await ranks.refresh({ async evaluate(_fn, by) { return { ...board(by), me: { rank: 7 } }; } });
  release(); await old;
  assert.equal(ranks.snapshot().wave.rank, 7);
});
