import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { privateJson } from '../lib/core.mjs';
import { acquireRuntime, inspectOwner, processIdentity, currentStatus, requestRuntime, requestStop, readRuntimeOwner } from '../lib/runtime.mjs';

const exec = promisify(execFile), script = resolve('run.mjs');
const fixture = async t => {
  const dir = await mkdtemp(join(tmpdir(), 'makaka-runtime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
const saved = { version: '2.11.0', active: true, checkedAt: '2026-11-01T01:00:00Z',
  server: { bananas: 1609218, bestWave: 68 }, battle: { wave: 69, killed: 14, total: 18 },
  incomePerMinute: 46532, automation: { stage: 'prepare', nextAttemptSeconds: 0 }, message: 'Старый бой' };
const cli = (dir, command) => exec(process.execPath, [script, command], {
  env: { ...process.env, MAKAKA_STATE_DIR: dir, NO_COLOR: '1' }, timeout: 10000 });

test('status cannot present a dead session as live when Android reused its PID for another program', async t => {
  const dir = await fixture(t);
  await privateJson(join(dir, 'running.json'), { pid: process.pid, startedAt: saved.checkedAt });
  await privateJson(join(dir, 'status.json'), saved);
  const result = await cli(dir, 'status');
  assert.match(result.stdout, /не запущен/);
  assert.match(result.stdout, /СОХРАНЁННЫЕ ДАННЫЕ/);
  assert.doesNotMatch(result.stdout, /ПОДГОТОВКА ВОЛНЫ|\+46 532|Ctrl\+C/);
  assert.equal(JSON.parse(await readFile(join(dir, 'status.json'), 'utf8')).active, true,
    'reading status must not rewrite historical game data');
});

const initialStatus = () => ({ version: '2.11.1', checkedAt: new Date().toISOString(), active: false, message: 'Запускаю…' });
const session = async (t, dir, hooks = {}) => {
  const runtime = await acquireRuntime({ stateDir: dir, script, initialStatus: initialStatus(), ...hooks });
  t.after(() => runtime.close());
  return runtime;
};

test('reclaiming an obsolete PID lock also invalidates the old active snapshot immediately', async t => {
  const dir = await fixture(t);
  await privateJson(join(dir, 'status.json'), saved);
  await privateJson(join(dir, 'running.json'), { pid: process.pid, startedAt: saved.checkedAt });
  await privateJson(join(dir, 'stop.request'), { requestedAt: saved.checkedAt });
  const runtime = await session(t, dir);
  const stored = JSON.parse(await readFile(join(dir, 'status.json'), 'utf8'));
  assert.equal(stored.runtime.runId, runtime.owner.runId);
  assert.equal(stored.runtime.state, 'starting'); assert.equal(stored.active, false);
  assert.equal(stored.server, undefined); assert.equal(stored.battle, undefined);
  await assert.rejects(readFile(join(dir, 'stop.request')), { code: 'ENOENT' });
});

test('a matching PID from a different boot or process start is stale even when signal zero succeeds', async () => {
  const owner = { pid: 1234, bootId: 'old-boot', startTicks: '111', runId: 'old-run' };
  for (const live of [{ alive: true, bootId: 'new-boot', startTicks: '111' },
    { alive: true, bootId: 'old-boot', startTicks: '222' }, { alive: false }, { alive: true, foreignUser: true }]) {
    let calls = 0;
    assert.equal((await inspectOwner(owner, script, { identity: async () => live, control: async () => calls++ })).kind, 'stale');
    assert.equal(calls, 0);
  }
});

test('currentStatus requests fresh game data and a second CLI launch shows them without replacing the live owner', async t => {
  const dir = await fixture(t); let refreshes = 0, runtime;
  runtime = await session(t, dir, { onStatus: () => runtime.saveStatus({ ...saved,
    checkedAt: new Date().toISOString(), server: { ...saved.server, bananas: 9000000 + ++refreshes } }) });
  const current = await currentStatus(dir, script);
  assert.equal(current.server.bananas, 9000001); assert.equal(current.active, true);
  const result = await cli(dir, 'status');
  assert.match(result.stdout, /9 000 002/); assert.doesNotMatch(result.stdout, /1 609 218/);
  await assert.rejects(cli(dir, 'start'), error => {
    assert.match(error.stderr, /уже запущена/); assert.match(error.stdout, /9 000 003/); return true;
  });
  assert.equal((await readRuntimeOwner(dir)).runId, runtime.owner.runId);
});

test('an old game snapshot or an unresponsive process is never presented as a current battle or income', async t => {
  const dir = await fixture(t); let runtime;
  runtime = await session(t, dir, { onStatus: () => runtime.saveStatus(saved) });
  const current = await currentStatus(dir, script);
  assert.equal(current.active, false); assert.equal(current.incomePerMinute, null);
  assert.equal(current.battle, null); assert.equal(current.runtime.state, 'unresponsive');
  await assert.rejects(acquireRuntime({ stateDir: dir, script, initialStatus: initialStatus() }), { code: 'MAKAKA_RUNNING' });
});

test('stop reaches the confirmed runner and rejects the wrong local token', async t => {
  const dir = await fixture(t); let stops = 0;
  const runtime = await session(t, dir, { onStop: () => stops++ });
  await assert.rejects(requestRuntime({ ...runtime.owner, token: 'wrong' }, 'stop'));
  assert.equal(stops, 0); assert.equal(await requestStop(dir, script), true); assert.equal(stops, 1);
  assert.equal((await readRuntimeOwner(dir)).runId, runtime.owner.runId);
});

test('a stale stop request cannot target the unrelated process now holding the old PID', async t => {
  const dir = await fixture(t);
  await privateJson(join(dir, 'running.json'), { pid: process.pid, startedAt: saved.checkedAt });
  assert.equal(await requestStop(dir, script), false);
  await assert.rejects(readFile(join(dir, 'stop.request')), { code: 'ENOENT' });
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test('unreadable process identity and a slow control endpoint do not authorize a duplicate session', async t => {
  const old = { pid: 1234, startedAt: new Date().toISOString() };
  const checked = await inspectOwner(old, script, { identity: async () => ({ alive: true }) });
  assert.equal(checked.kind, 'unknown');
  const dir = await fixture(t);
  const runtime = await session(t, dir, { onStatus: () => new Promise(() => {}) });
  await assert.rejects(requestRuntime(runtime.owner, 'status', 100), /не ответил/);
  assert.equal((await inspectOwner(runtime.owner, script)).kind, 'running');
  await assert.rejects(acquireRuntime({ stateDir: dir, script, initialStatus: initialStatus() }), { code: 'MAKAKA_RUNNING' });
});

test('closing an old owner cannot remove a replacement lock or overwrite its status', async t => {
  const dir = await fixture(t), runtime = await session(t, dir);
  const replacement = { ...runtime.owner, runId: 'replacement-owner' };
  await privateJson(join(dir, 'running.json'), replacement);
  await privateJson(join(dir, 'status.json'), { active: true, message: 'replacement-status' });
  await runtime.close();
  assert.equal((await readRuntimeOwner(dir)).runId, replacement.runId);
  assert.equal(JSON.parse(await readFile(join(dir, 'status.json'), 'utf8')).message, 'replacement-status');
});

test('a fresh partial lock is preserved but an old corrupted lock can be recovered', async t => {
  const dir = await fixture(t), path = join(dir, 'running.json');
  await writeFile(path, '{');
  await assert.rejects(acquireRuntime({ stateDir: dir, script, initialStatus: initialStatus() }), { code: 'MAKAKA_RUNNING' });
  assert.equal(await readFile(path, 'utf8'), '{');
  const old = new Date(Date.now() - 30000); await utimes(path, old, old);
  const runtime = await session(t, dir);
  assert.equal((await readRuntimeOwner(dir)).runId, runtime.owner.runId);
});

test('a forcibly killed runner leaves recoverable files and its saved active battle cannot block a new launch', async t => {
  const dir = await fixture(t);
  const child = spawn(process.execPath, [resolve('test/helpers/runtime-session.mjs'), dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await new Promise((done, reject) => {
    child.stdout.once('data', done); child.once('error', reject); child.once('exit', code => reject(new Error('Fixture exited: ' + code)));
  });
  const old = await readRuntimeOwner(dir);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  assert.equal((await inspectOwner(old, script)).kind, 'stale');
  const runtime = await session(t, dir);
  assert.notEqual(runtime.owner.runId, old.runId);
  assert.equal(runtime.snapshot.active, false);
});

test('Linux identity contains boot and start information and distinguishes an unrelated command', async () => {
  const live = await processIdentity(process.pid, script);
  assert.equal(live.alive, true);
  if (process.platform === 'linux') {
    assert.match(live.startTicks, /^\d+$/); assert.ok(live.bootId); assert.equal(live.scriptMatches, false);
    const foreign = await processIdentity(1234, script, () => { throw Object.assign(new Error(), { code: 'EPERM' }); });
    assert.equal(foreign.foreignUser, true);
  }
});

test('the actual start command reclaims an obsolete lock and releases it even if setup cannot continue', async t => {
  const dir = await fixture(t);
  await privateJson(join(dir, 'running.json'), { pid: process.pid, startedAt: saved.checkedAt });
  await privateJson(join(dir, 'status.json'), saved);
  await assert.rejects(cli(dir, 'start'), error => {
    assert.match(error.stderr, /Для настройки открой Termux/); assert.doesNotMatch(error.stderr, /уже запущена/); return true;
  });
  assert.equal(await readRuntimeOwner(dir), null);
  assert.equal(JSON.parse(await readFile(join(dir, 'status.json'), 'utf8')).active, false);
});

test('concurrent status and report writes cannot collide when they start in the same millisecond', async t => {
  const dir = await fixture(t), originalNow = Date.now;
  Date.now = () => 1793620000000;
  try {
    await Promise.all(Array.from({ length: 12 }, (_, i) => privateJson(join(dir, 'report-' + i + '.json'), { i })));
    for (let i = 0; i < 12; i++) assert.deepEqual(JSON.parse(await readFile(join(dir, 'report-' + i + '.json'), 'utf8')), { i });
  } finally { Date.now = originalNow; }
});
