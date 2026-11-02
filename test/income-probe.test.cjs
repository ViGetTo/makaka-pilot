const { test } = require('node:test');
const assert = require('node:assert/strict');
const browser = require('./helpers/browser.cjs');

test('the fast-restart diagnostic sends native kill reports immediately and never submits a wave bonus', async () => {
  const b = browser();
  b.start({ mode: 'maximum', speed: 8, probe: 'fast-restart' });
  await b.advance();
  b.engine.killed = b.engine.wave.cats.length;
  const reporting = b.context.fetch('/api/battle/kills', { method: 'POST',
    body: JSON.stringify({ wave: b.engine.wave.wave, kills: b.engine.killed }) });
  await b.flush();
  assert.equal(b.sent.at(-1).path, '/api/battle/kills', 'the diagnostic must not measure its own report delay');
  await reporting;
  await b.flush();
  assert.equal(b.pilot.status().currentTrial.killReports.at(-1).counted, 4);
  assert.equal(b.pilot.status().currentTrial.killReports.at(-1).reported, 4);
  b.context.fetch('/api/battle/clear', { method: 'POST',
    body: JSON.stringify({ wave: b.engine.wave.wave, kills: b.engine.killed }) });
  await b.flush();
  assert.equal(b.sent.some(r => r.path.endsWith('/clear')), false, 'kill income must be isolated from a clear bonus');
  b.pilot.stop();
  b.start({ mode: 'maximum', speed: 8 });
  const sentBefore = b.sent.length;
  b.context.fetch('/api/battle/kills', { method: 'POST',
    body: JSON.stringify({ wave: b.engine.wave.wave, kills: b.engine.killed }) });
  await b.flush();
  assert.equal(b.sent.length, sentBefore, 'an ordinary run must restore its original report timing');
  b.pilot.stop();
});

test('missing native acknowledgement is inconclusive, rather than evidence that fast kills are unpaid', async () => {
  const { classifyRestartProbe } = await import('../lib/probe.mjs');
  const state = { bananas: 1000, wave: 65, bestWave: 64, gear: { dmg: 1 } };
  const result = { before: state, afterExit: state, afterRestart: state,
    local: { wave: 65, killed: 18, total: 18 }, reports: [] };
  assert.equal(classifyRestartProbe(result).verdict, 'inconclusive');
});

test('a native acknowledgement is recorded before the caller can cancel the battle', async () => {
  const b = browser();
  b.start({ mode: 'maximum', speed: 8, probe: 'fast-restart' });
  await b.advance();
  b.engine.killed = 4;
  const response = await b.context.fetch('/api/battle/kills', { method: 'POST', body: JSON.stringify({ wave: 65, kills: 4 }) });
  await response.json();
  assert.equal(b.pilot.status().currentTrial.killReports.at(-1)?.counted, 4,
    'reading the original body must not race the receipt used by the diagnostic');
  b.pilot.stop();
});

test('measurement excludes native passive income and upgrades without affecting battles, auth or other origins', async () => {
  const { measurementBlockedRequest } = await import('../lib/core.mjs');
  for (const path of ['mine/auto', 'mine/collect', 'mine/tap', 'upgrade']) {
    assert.equal(measurementBlockedRequest('https://makaka.wivvi.net/api/' + path, 'POST'), true);
    assert.equal(measurementBlockedRequest('https://other.example/api/' + path, 'POST'), false);
    assert.equal(measurementBlockedRequest('https://makaka.wivvi.net/api/' + path, 'GET'), false);
  }
  for (const path of ['battle/start', 'battle/kills', 'battle/fail', 'state', 'bootstrap', 'top?by=wave']) {
    assert.equal(measurementBlockedRequest('https://makaka.wivvi.net/api/' + path, 'POST'), false);
  }
  assert.equal(measurementBlockedRequest('invalid', 'POST'), false);
});
