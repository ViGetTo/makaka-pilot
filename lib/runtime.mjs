import { mkdir, open, readFile, readlink, stat, unlink } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { uptime } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { privateJson, readJson } from './core.mjs';

export async function readRuntimeOwner(stateDir) {
  const path = join(stateDir, 'running.json');
  try {
    const raw = await readFile(path, 'utf8');
    try { return JSON.parse(raw); }
    catch { return { invalid: true, modifiedAt: (await stat(path)).mtimeMs }; }
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function processIdentity(pid, script, signal = process.kill) {
  try { signal(pid, 0); }
  catch (error) {
    // All Termux runners share the app UID. EPERM after reboot means this PID now belongs to another app/system service.
    return { alive: error.code !== 'ESRCH', foreignUser: process.platform === 'linux' && error.code === 'EPERM' };
  }
  const result = { alive: true };
  if (process.platform !== 'linux') return result;
  try {
    const text = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (['Z', 'X'].includes(fields[0])) return { alive: false };
    result.startTicks = fields[19];
  } catch {}
  try { result.bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(); } catch {}
  try {
    const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
    const cwd = args[1] && !isAbsolute(args[1]) ? await readlink(`/proc/${pid}/cwd`) : '';
    result.scriptMatches = /^node(?:js)?$/.test(basename(args[0])) && !!args[1] && resolve(cwd, args[1]) === resolve(script);
  } catch {}
  return result;
}

export function requestRuntime(owner, action, timeout = 3000) {
  return new Promise((resolveReply, reject) => {
    if (!Number.isInteger(owner?.port) || owner.port < 1 || owner.port > 65535 || !owner.token || !owner.runId) {
      reject(new Error('Нет локального соединения со скриптом.')); return;
    }
    const req = request({ hostname: '127.0.0.1', port: owner.port, path: '/' + action,
      method: action === 'stop' ? 'POST' : 'GET', agent: false,
      headers: { 'x-makaka-token': owner.token } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; if (body.length > 262144) req.destroy(new Error('Слишком большой ответ статуса.')); });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const reply = JSON.parse(body);
          if (response.statusCode !== 200 || reply.runId !== owner.runId) throw new Error('Скрипт не подтвердил локальное соединение.');
          resolveReply(reply);
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('Скрипт не ответил на локальный запрос.')), timeout);
    req.once('close', () => clearTimeout(timer));
    req.once('error', reject);
    req.end();
  });
}

export async function inspectOwner(owner, script, { identity = processIdentity, control = requestRuntime } = {}) {
  if (!owner) return { kind: 'stale', owner };
  // Another launch may be between open(wx) and writeFile. Never reclaim a fresh partial write.
  if (owner.invalid) return { kind: Date.now() - owner.modifiedAt > 10000 ? 'stale' : 'unknown', owner };
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return { kind: 'stale', owner };
  const live = await identity(owner.pid, script);
  if (!live.alive || live.foreignUser || owner.bootId && live.bootId && owner.bootId !== live.bootId ||
      owner.startTicks && live.startTicks && owner.startTicks !== live.startTicks) return { kind: 'stale', owner };
  if (live.scriptMatches === false && !(owner.startTicks && owner.startTicks === live.startTicks)) return { kind: 'stale', owner };
  if (owner.runId) {
    try { await control(owner, 'health', 1000); return { kind: 'running', owner }; } catch {}
    // A paused or unresponsive matching process still owns the session: do not start a duplicate.
    return { kind: 'unresponsive', owner };
  }
  // Compatibility with <=2.11.0, which stored only a PID and wall-clock date.
  const beforeBoot = process.platform === 'linux' && Date.parse(owner.startedAt) < Date.now() - uptime() * 1000 - 5000;
  if (owner.pid === process.pid || beforeBoot || live.scriptMatches === false) return { kind: 'stale', owner };
  return { kind: live.scriptMatches === true ? 'running' : 'unknown', owner };
}

export async function acquireRuntime({ stateDir, script, initialStatus, onStatus, onStop = () => {} }) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const identity = await processIdentity(process.pid, script);
  const owner = { pid: process.pid, startedAt: new Date().toISOString(), runId: randomUUID(), token: randomUUID(),
    bootId: identity.bootId, startTicks: identity.startTicks };
  let snapshot, queue = Promise.resolve(), closed = false, acquired = false;
  const saveStatus = (data, state = 'running') => {
    const next = { ...data, runtime: { state, pid: owner.pid, runId: owner.runId } };
    queue = queue.catch(() => {}).then(async () => {
      if (closed) return snapshot;
      if ((await readRuntimeOwner(stateDir))?.runId !== owner.runId) return snapshot;
      await privateJson(join(stateDir, 'status.json'), next); snapshot = next;
      return snapshot;
    });
    return queue;
  };
  const server = createServer(async (req, res) => {
    const send = (code, data) => { if (!res.destroyed) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); } };
    if (req.headers['x-makaka-token'] !== owner.token) { send(403, {}); return; }
    try {
      if (req.method === 'GET' && req.url === '/health') send(200, { runId: owner.runId });
      else if (req.method === 'GET' && req.url === '/status') send(200, { runId: owner.runId, status: await onStatus?.() || snapshot });
      else if (req.method === 'POST' && req.url === '/stop') { onStop(); send(200, { runId: owner.runId }); }
      else send(404, {});
    } catch { send(503, { runId: owner.runId }); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  owner.port = server.address().port;
  const closeServer = async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); };
  try {
    const lockPath = join(stateDir, 'running.json');
    for (let attempt = 0; attempt < 3; attempt++) {
      let handle;
      try {
        handle = await open(lockPath, 'wx', 0o600);
        acquired = true;
        await handle.writeFile(JSON.stringify(owner));
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const other = await readRuntimeOwner(stateDir), checked = await inspectOwner(other, script);
        if (checked.kind !== 'stale' || attempt === 2) {
          const busy = new Error('Makaka уже запущена. Статус: makaka status. Остановить: makaka stop.');
          busy.code = 'MAKAKA_RUNNING'; throw busy;
        }
        // Recheck the owner so cleanup cannot delete a replacement session's lock.
        if (JSON.stringify(await readRuntimeOwner(stateDir)) === JSON.stringify(other)) await unlink(lockPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      } finally { await handle?.close(); }
    }
    await unlink(join(stateDir, 'stop.request')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await saveStatus(initialStatus, 'starting');
  } catch (error) {
    await closeServer();
    if (acquired && (await readRuntimeOwner(stateDir))?.runId === owner.runId) await unlink(join(stateDir, 'running.json'));
    throw error;
  }
  return { owner, saveStatus, get snapshot() { return snapshot; },
    async close() {
      if (closed) return;
      try {
        await saveStatus({ ...snapshot, active: false, incomePerMinute: 0, battle: null, serverKills: null, automation: null,
          message: snapshot?.active || snapshot?.runtime?.state === 'starting' ? 'Скрипт остановлен.' : snapshot?.message }, 'stopped');
      } finally {
        closed = true;
        await closeServer();
        if ((await readRuntimeOwner(stateDir))?.runId === owner.runId) await unlink(join(stateDir, 'running.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    } };
}

function archivedStatus(status, state, message) {
  return { ...status, active: false, incomePerMinute: null, battle: null, serverKills: null, automation: null,
    runtime: { state }, message,
    rankings: Object.fromEntries(Object.entries(status?.rankings || {}).map(([key, data]) => [key, { ...data, stale: true }])) };
}

export async function currentStatus(stateDir, script) {
  const saved = await readJson(join(stateDir, 'status.json'));
  const checked = await inspectOwner(await readRuntimeOwner(stateDir), script);
  if (checked.kind === 'stale') return archivedStatus(saved, 'stopped', 'Скрипт не запущен. Показаны последние сохранённые данные.');
  if (checked.kind === 'running') {
    try {
      if (checked.owner.runId) {
        const reply = await requestRuntime(checked.owner, 'status');
        if (reply.status?.runtime?.runId === checked.owner.runId &&
            (reply.status.runtime.state === 'starting' || Date.now() - Date.parse(reply.status.checkedAt) < 5000)) return reply.status;
      } else {
        // A pre-upgrade runner has no control endpoint; wait for its next one-second snapshot.
        for (let i = 0; i < 8; i++) {
          await delay(250);
          const next = await readJson(join(stateDir, 'status.json'));
          if (next?.checkedAt !== saved?.checkedAt && Date.now() - Date.parse(next?.checkedAt) < 5000) return next;
        }
      }
    } catch {}
  }
  return archivedStatus(saved, 'unresponsive', 'Процесс не отвечает. Свежие данные игры недоступны.');
}

export async function requestStop(stateDir, script) {
  const checked = await inspectOwner(await readRuntimeOwner(stateDir), script);
  if (checked.kind === 'stale') return false;
  if (checked.kind === 'unknown') throw new Error('Не удалось подтвердить процесс Makaka. Запрос остановки не отправлен.');
  if (checked.owner.runId) {
    try { await requestRuntime(checked.owner, 'stop'); return true; } catch {}
  }
  await privateJson(join(stateDir, 'stop.request'), { requestedAt: new Date().toISOString(), runId: checked.owner.runId });
  return true;
}
