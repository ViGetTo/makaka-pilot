import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseFarmBenchmark, benchmarkFarm } from '../lib/benchmark.mjs';

test('a sustained closed-cycle gain beats a larger payout only when real elapsed income improves by five percent', () => {
  const base = { profile: 'same-gear-and-wave', cycles: 5, gain: 150000, seconds: 130 };
  const candidate = { profile: base.profile, cycles: 5, gain: 47460, seconds: 28 };
  const result = chooseFarmBenchmark([base, candidate]);
  assert.equal(result.improved, true); assert.equal(result.goalReached, true);
  assert.equal(result.selected.gain, 47460);
  assert.equal(result.selected.perMinute, 47460 / 28 * 60);
  const noise = chooseFarmBenchmark([base, { ...base, gain: 155000 }]);
  assert.equal(noise.improved, false); assert.equal(noise.selected.gain, 150000);
});

test('incomplete runs, changed gear, missing income and invalid timings cannot select a new farming configuration', () => {
  const base = { profile: 'same', cycles: 5, gain: 100, seconds: 10 };
  for (const change of [{ cycles: 1 }, { profile: 'new-gear' }, { gain: 0 }, { seconds: 0 }, { seconds: NaN }]) {
    assert.throws(() => chooseFarmBenchmark([base, { ...base, ...change }]), /полных замеров/);
  }
});

test('a pre-existing stop request starts no measurement or browser actions', async () => {
  let calls = 0;
  const result = await benchmarkFarm({ evaluate() { calls++; } }, { readStop: async () => true });
  assert.equal(result, null); assert.equal(calls, 0);
});
