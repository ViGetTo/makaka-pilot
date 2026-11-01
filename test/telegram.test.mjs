import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTelegramProvider, telegramCredentials, telegramFailure, launchUserId, GAME_BOT } from '../lib/telegram.mjs';
import { privateJson, readJson, ORIGIN } from '../lib/core.mjs';
import { saveTelegramLaunch } from '../lib/launch.mjs';

const credentials = { apiId: 123, apiHash: '0'.repeat(32), session: 'test-session', userId: '42' };
const launch = (id = 42, tag = 'test-only') => ORIGIN + '/#tgWebAppData=' + encodeURIComponent(new URLSearchParams({
  user: JSON.stringify({ id }), auth_date: '123', hash: tag }).toString());
const rpc = code => Object.assign(new Error('DO-NOT-PRINT-REQUEST-ARGUMENTS'), { errorMessage: code });

function sdkFixture({ fallback = false, mainError, selfError, userId = '42', url = launch(), queryExpired = false } = {}) {
  const calls = [], notices = [], prompts = [];
  let options, destroyed = false;
  const request = name => class { constructor(args) { this.className = name; Object.assign(this, args); } };
  const sdk = { Api: { messages: { RequestMainWebView: request('main'), RequestWebView: request('menu'), ProlongWebView: request('keep') } },
    sessions: { StringSession: class { constructor(value) { this.value = value; } } },
    Logger: class { constructor(level) { this.level = level; } }, utils: { getInputUser: value => ({ bot: value }) },
    TelegramClient: class {
      constructor(session, _id, _hash, opts) { options = opts; this.session = { save: () => session.value || 'new-test-session' }; }
      async connect() { calls.push('connect'); this.connected = true; }
      async getMe() { calls.push('self'); if (selfError) throw rpc(selfError); return { id: userId }; }
      async getInputEntity(name) { calls.push(name); return 'test-peer'; }
      async start(callbacks) {
        calls.push('start');
        await callbacks.phoneNumber(); await callbacks.phoneCode(); await callbacks.password();
        assert.equal(await callbacks.acceptTermsOfService(), false);
        assert.equal(callbacks.firstAndLastNames, undefined, 'a new account must not be registered');
        this.connected = true;
      }
      async invoke(request) {
        calls.push(request);
        if (request.className === 'main' && (fallback || mainError)) throw rpc(mainError || 'BOT_INVALID');
        if (request.className === 'keep') { if (queryExpired) throw rpc('QUERY_ID_INVALID'); return true; }
        return { url, queryId: 99n };
      }
      async destroy() { destroyed = true; }
    },
  };
  return { loadSdk: async () => sdk, calls, notices, prompts,
    notice: value => notices.push(value), ask: async (_label, _fallback, hidden) => {
      prompts.push(hidden); return 'private-input';
    }, get options() { return options; }, get destroyed() { return destroyed; } };
}

test('Telegram setup uses hidden code/password prompts and stores no phone, code or password', async () => {
  const fixture = sdkFixture();
  const provider = await createTelegramProvider({ ...credentials, session: '', userId: '' }, fixture);
  const url = await provider.refresh();
  assert.equal(launchUserId(url), '42'); assert.equal(provider.userId, '42');
  assert.deepEqual(fixture.prompts, [true, true, true]);
  assert.deepEqual(Object.keys(provider.sessionData()).sort(), ['apiHash', 'apiId', 'session', 'userId', 'version']);
  assert.equal(JSON.stringify(provider.sessionData()).includes('private-input'), false);
  assert.equal(fixture.options.baseLogger.level, 'none');
  assert.equal(fixture.options.floodSleepThreshold, 0);
  assert.equal(fixture.calls.includes(GAME_BOT), true);
  assert.equal(fixture.calls.some(call => call.className === 'main'), true);
  assert.equal(fixture.calls.some(call => call.className === 'menu'), false);
  await provider.close(); assert.equal(fixture.destroyed, true);
});

test('background refresh reuses a session without requesting a code and prolongs only once per minute', async () => {
  let now = 0;
  const fixture = sdkFixture();
  const provider = await createTelegramProvider(credentials, { loadSdk: fixture.loadSdk, now: () => now });
  await provider.refresh();
  assert.equal(fixture.calls.includes('start'), false);
  assert.equal(await provider.keepAlive(), false);
  now = 60000; await provider.keepAlive(); await provider.keepAlive();
  assert.equal(fixture.calls.filter(call => call.className === 'keep').length, 1);
  await provider.close(); now += 60000; await provider.keepAlive();
  assert.equal(fixture.calls.filter(call => call.className === 'keep').length, 1);
});

test('menu fallback requests the game URL and is limited to a bot without a main mini app', async () => {
  const fixture = sdkFixture({ fallback: true });
  const provider = await createTelegramProvider(credentials, { loadSdk: fixture.loadSdk });
  await provider.refresh();
  const menu = fixture.calls.find(call => call.className === 'menu');
  assert.equal(menu.url, ORIGIN + '/'); assert.equal(menu.fromBotMenu, true);
  assert.equal(menu.platform, 'android');
  await provider.close();
  const limited = sdkFixture({ mainError: 'FLOOD_WAIT_120' });
  const blocked = await createTelegramProvider(credentials, { loadSdk: limited.loadSdk });
  await assert.rejects(blocked.refresh(), /ограничил частоту/);
  assert.equal(limited.calls.some(call => call.className === 'menu'), false);
  await blocked.close();
});

test('an expired Telegram webview requests renewal while a different account is rejected', async () => {
  let now = 0;
  const fixture = sdkFixture({ queryExpired: true });
  const provider = await createTelegramProvider(credentials, { loadSdk: fixture.loadSdk, now: () => now });
  await provider.refresh(); now = 60000;
  assert.equal(await provider.keepAlive(), true); assert.equal(await provider.keepAlive(), false);
  await provider.close();
  const wrong = sdkFixture({ userId: '99' });
  await assert.rejects(createTelegramProvider(credentials, { loadSdk: wrong.loadSdk }), /другому аккаунту/);
  assert.equal(wrong.destroyed, true);
  const foreign = sdkFixture({ url: launch(99) });
  const other = await createTelegramProvider(credentials, { loadSdk: foreign.loadSdk });
  await assert.rejects(other.refresh(), /другого аккаунта/); await other.close();
});

test('invalid credentials, revoked sessions and raw RPC messages never echo secret values', () => {
  assert.throws(() => telegramCredentials({ apiId: -1, apiHash: 'DO-NOT-PRINT' }), /api_id/);
  assert.throws(() => telegramCredentials({ ...credentials, session: '' }, true), /telegram-login/);
  for (const code of ['AUTH_KEY_UNREGISTERED', 'PHONE_CODE_INVALID', 'UNEXPECTED_SERVER_ERROR']) {
    const message = telegramFailure(rpc(code)).message;
    assert.equal(message.includes('DO-NOT-PRINT'), false);
    assert.equal(message.includes(code), false);
  }
});

test('a revoked saved Telegram session closes without starting another interactive login', async () => {
  const fixture = sdkFixture({ selfError: 'SESSION_REVOKED' });
  await assert.rejects(createTelegramProvider(credentials, { loadSdk: fixture.loadSdk }), /Сессия Telegram отозвана/);
  assert.equal(fixture.calls.includes('start'), false); assert.equal(fixture.destroyed, true);
});

test('the installed SDK serializes the exact Mini App request with a silent logger', async () => {
  const sdk = await import('teleproto');
  let wireBytes, logger;
  class OfflineClient extends sdk.TelegramClient {
    constructor(...args) { super(...args); logger = args[3].baseLogger; }
    async start() {}
    async connect() {}
    async getMe() { return { id: 42n }; }
    async getInputEntity() { return new sdk.Api.InputPeerUser({ userId: 100n, accessHash: 200n }); }
    async invoke(request) { wireBytes = request.getBytes(); return { url: launch() }; }
    async destroy() {}
  }
  const provider = await createTelegramProvider({ ...credentials, session: '' }, {
    ask: async () => { throw new Error('unexpected prompt'); }, loadSdk: async () => ({ ...sdk, TelegramClient: OfflineClient }),
  });
  await provider.refresh();
  assert.equal(logger.logLevel, 'none'); assert.ok(wireBytes.length > 16);
  assert.equal(wireBytes.readUInt32LE(0), sdk.Api.messages.RequestMainWebView.CONSTRUCTOR_ID);
  await provider.close();
});

test('signed launches are saved privately outside the checkout and unrelated settings survive', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'makaka-telegram-test-'));
  try {
    const configPath = join(temp, 'state', 'launch.json'), telegramPath = join(temp, 'state', 'telegram.json');
    const old = { url: launch(), authMode: 'link', options: { farmKills: 15, reserve: 123 }, custom: true };
    await privateJson(configPath, old);
    const provider = { userId: '42', refresh: async () => launch(42, 'fresh-test'), sessionData: () => credentials };
    await saveTelegramLaunch(provider, configPath, telegramPath);
    const next = await readJson(configPath);
    assert.equal(next.authMode, 'telegram'); assert.equal(next.url, launch(42, 'fresh-test'));
    assert.deepEqual(next.options, old.options); assert.equal(next.custom, true);
    assert.deepEqual(await readJson(telegramPath), credentials);
    assert.equal((await stat(telegramPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(temp, 'state'))).mode & 0o777, 0o700);
    await assert.rejects(saveTelegramLaunch({ ...provider, refresh: async () => launch(99) }, configPath, telegramPath), /разным аккаунтам/);
    assert.deepEqual(await readJson(configPath), next, 'a failed refresh must not replace the working link');
    await assert.rejects(saveTelegramLaunch({ ...provider, refresh: async () => 'https://example.com/' }, configPath, telegramPath));
    assert.deepEqual(await readJson(configPath), next);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
