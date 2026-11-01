import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gameAuthError, withRenewedLaunch } from '../lib/launch.mjs';

test('launch obtains a fresh link and renews after expiry only after closing the old game', async () => {
  let now = 0, opens = 0;
  const events = [];
  const result = await withRenewedLaunch({ provider: {}, now: () => now,
    refresh: async () => events.push('refresh'), open: async () => { opens++; events.push('open'); },
    run: async () => { events.push('run'); if (opens === 1) { now += 60001; throw gameAuthError(); } return 'resumed'; },
    closePage: async () => events.push('close'), log() {},
  });
  assert.equal(result, 'resumed');
  assert.deepEqual(events, ['refresh', 'open', 'run', 'close', 'refresh', 'open', 'run']);
});

test('a newly issued link rejected immediately cannot create an endless authorization loop', async () => {
  let refreshes = 0, opens = 0;
  await assert.rejects(withRenewedLaunch({ provider: {}, now: () => 1,
    refresh: async () => refreshes++, open: async () => { opens++; throw gameAuthError(); },
    run() {}, closePage() {}, log() {},
  }), /Свежая ссылка Telegram тоже отклонена/);
  assert.equal(refreshes, 1); assert.equal(opens, 1);
});

test('ordinary network failures and manual-link authentication errors are not retried as Telegram logins', async () => {
  for (const provider of [undefined, {}]) {
    let refreshes = 0;
    await assert.rejects(withRenewedLaunch({ provider, refresh: async () => refreshes++,
      open: async () => { throw new Error('network-offline'); }, run() {}, closePage() {},
    }), /network-offline/);
    assert.equal(refreshes, provider ? 1 : 0);
  }
  await assert.rejects(withRenewedLaunch({ open: async () => { throw gameAuthError(); }, run() {}, closePage() {} }),
    error => error.code === 'GAME_AUTH_EXPIRED');
});

test('a stop request prevents starting or renewing another game', async () => {
  let requested = true, refreshes = 0, now = 0;
  const options = { provider: {}, stopped: async () => requested, now: () => now,
    refresh: async () => refreshes++, open() {}, run: async () => { now = 60001; throw gameAuthError(); },
    closePage: async () => { requested = true; }, log() {},
  };
  await withRenewedLaunch(options); assert.equal(refreshes, 0);
  requested = false; await withRenewedLaunch(options); assert.equal(refreshes, 1);
});

test('long sessions can renew multiple times instead of exhausting a lifetime retry counter', async () => {
  let now = 0, refreshes = 0;
  const result = await withRenewedLaunch({ provider: {}, now: () => now,
    refresh: async () => refreshes++, open() {}, closePage() {}, log() {},
    run: async () => { if (refreshes >= 5) return 'done'; now += 3600000; throw gameAuthError(); },
  });
  assert.equal(result, 'done'); assert.equal(refreshes, 5);
});
