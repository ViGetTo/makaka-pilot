import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORIGIN, normalUserAgent, validateLaunchUrl, filterHeaders, safeStatus, redact, readJson, privateJson } from '../lib/core.mjs';

const example = ORIGIN + '/#tgWebAppData=' + encodeURIComponent(new URLSearchParams({
  user: '{"id":1}', auth_date: '1', hash: 'test-only-not-a-real-signature' }).toString());

test('normalizes the headless label without inventing a browser version or platform', () => {
  assert.equal(normalUserAgent('Linux aarch64 HeadlessChrome/156.0.1 Safari/537.36'), 'Linux aarch64 Chrome/156.0.1 Safari/537.36');
  assert.equal(normalUserAgent('normal browser'), 'normal browser');
});

test('accepts a full launch link without pretending to validate its signature', () => {
  assert.equal(validateLaunchUrl('  ' + example + '  '), example);
});
test('rejects missing Telegram data and foreign origins before navigating', () => {
  for (const value of [ORIGIN, 'https://example.com/#tgWebAppData=x', example.replace('https:', 'http:'),
    example.replace('.net/', '.net.evil/'), example.replace('.net/', '.net/not-the-game/')]) {
    assert.throws(() => validateLaunchUrl(value));
  }
});
test('removes only the automation marker on same-origin API requests', () => {
  const headers = { authorization: 'tma test-only', 'X-AuToMaTiOn': '1', 'content-type': 'application/json' };
  const filtered = filterHeaders(ORIGIN + '/api/bootstrap', headers);
  assert.deepEqual(filtered, { authorization: 'tma test-only', 'content-type': 'application/json' });
  assert.equal(headers['X-AuToMaTiOn'], '1');
  for (const url of ['https://example.com/api/state', ORIGIN + '/public', 'invalid']) assert.equal(filterHeaders(url, headers), headers);
});
test('status export excludes launch URL, authorization and logs', () => {
  const s = safeStatus({ active: true, version: 'test', url: example, authorization: 'secret', log: [example],
    config: { url: example }, server: { wave: 61, bestWave: 60, bananas: 123, auth: 'secret' } });
  assert.equal(s.server.bestWave, 60);
  assert.equal(JSON.stringify(s).includes('secret'), false);
  assert.equal(JSON.stringify(s).includes('tgWebAppData'), false);
});
test('error messages redact launch links and Telegram credentials', () => {
  assert.equal(redact('Navigation failed: ' + example).includes('auth_date'), false);
  assert.equal(redact('Authorization tma test-only').includes('test-only'), false);
});
test('settings are saved atomically outside the checkout with private permissions', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'makaka-test-'));
  try {
    const path = join(temp, 'private', 'launch.json');
    assert.equal(await readJson(path), null);
    await privateJson(path, { test: 1 });
    await privateJson(path, { test: 2 });
    assert.deepEqual(await readJson(path), { test: 2 });
    if (process.platform !== 'win32') {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(join(temp, 'private'))).mode & 0o777, 0o700);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
