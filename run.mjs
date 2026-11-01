#!/usr/bin/env node
import { readFile, mkdir, open, unlink, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { ORIGIN, DEFAULT_OPTIONS, normalUserAgent, validateLaunchUrl, filterHeaders, safeStatus, redact, readJson, privateJson } from './lib/core.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const stateDir = resolve(process.env.MAKAKA_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'makaka-pilot'));
const configPath = join(stateDir, 'launch.json'), lockPath = join(stateDir, 'running.json');
const stopPath = join(stateDir, 'stop.request'), statusPath = join(stateDir, 'status.json');
const command = process.argv[2] || 'start';

async function question(prompt, fallback, secret = false) {
  if (!process.stdin.isTTY) throw new Error('Для настройки открой Termux и выполни makaka login.');
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const rl = createInterface({ input: process.stdin, output: secret ? muted : process.stdout, terminal: true });
  try {
    if (secret) process.stdout.write(prompt);
    const answer = (await rl.question(secret ? '' : prompt)).trim();
    return answer || fallback;
  } finally { rl.close(); if (secret) process.stdout.write('\n'); }
}

async function login() {
  const previous = await readJson(configPath, {});
  const value = await question('Вставь полную ссылку игры из Telegram (ввод скрыт): ', '', true);
  const url = validateLaunchUrl(value);
  await privateJson(configPath, { ...previous, url, options: { ...DEFAULT_OPTIONS, ...previous.options } });
  console.log('Ссылка сохранена только на телефоне. Запуск: makaka');
}

async function configure() {
  const previous = await readJson(configPath, {}), opts = { ...DEFAULT_OPTIONS, ...previous.options };
  const mode = await question(`Режим farmer/paced [${opts.mode}]: `, opts.mode);
  if (!['farmer', 'paced'].includes(mode)) throw new Error('Укажи farmer или paced.');
  opts.mode = mode;
  for (const [key, label, max] of [ ['farmTarget', 'Копить до (0 — без конца)', 1e15],
    ['targetWave', 'Целевая волна (0 — без цели)', 1e9], ['sessionMinutes', 'Длительность, минут', 1440] ]) {
    const n = Number(await question(`${label} [${opts[key]}]: `, String(opts[key])));
    if (!Number.isFinite(n) || n < (key === 'sessionMinutes' ? 1 : 0) || n > max) throw new Error('Недопустимое число. Настройки не изменены.');
    opts[key] = Math.floor(n);
  }
  opts.speed = mode === 'farmer' ? 8 : 1;
  opts.autoUpgrade = (await question('Покупать улучшения при прохождении? y/N: ', 'n')).toLowerCase() === 'y';
  opts.gearAuto = false;
  await privateJson(configPath, { ...previous, options: opts });
  console.log('Настройки сохранены. Запуск: makaka');
}

async function browserPath() {
  const explicit = process.env.MAKAKA_CHROMIUM;
  const names = process.platform === 'win32' ? ['chrome.exe'] : ['chromium-browser', 'chromium', 'google-chrome'];
  const candidates = explicit ? [explicit] : [
    ...String(process.env.PATH || '').split(delimiter).flatMap(p => names.map(n => join(p, n))),
    ...(process.env.PREFIX ? [join(process.env.PREFIX, 'lib', 'chromium', 'chrome')] : []),
  ];
  for (const path of candidates) { try { await access(path, constants.X_OK); return path; } catch {} }
  throw new Error('Chromium не найден. В Termux: pkg install x11-repo && pkg install chromium');
}

async function acquire() {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await handle.close();
      await unlink(stopPath).catch(e => { if (e.code !== 'ENOENT') throw e; });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const other = await readJson(lockPath);
      let alive = false;
      if (Number.isInteger(other?.pid) && other.pid > 0) {
        try { process.kill(other.pid, 0); alive = true; }
        catch (err) { if (err.code !== 'ESRCH') alive = true; }
      }
      if (alive || attempt) throw new Error('Makaka уже запущена. Статус: makaka status. Остановить: makaka stop.');
      await unlink(lockPath);
    }
  }
}

async function run(checkOnly = false) {
  let config = await readJson(configPath);
  if (!config?.url) { await login(); config = await readJson(configPath); }
  const url = validateLaunchUrl(config.url), executablePath = await browserPath();
  await acquire();
  let browser, page, stopping = false, last = null, terminalError = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  spawnSync('termux-wake-lock', [], { stdio: 'ignore' });
  try {
    const { default: puppeteer } = await import('puppeteer-core');
    browser = await puppeteer.launch({ executablePath, headless: true, timeout: 45000,
      defaultViewport: { width: 430, height: 860, deviceScaleFactor: 1 },
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
    page = await browser.newPage();
    await page.setUserAgent({ userAgent: normalUserAgent(await browser.userAgent()) });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const headers = filterHeaders(request.url(), request.headers());
      request.continue({ headers }).catch(() => {});
    });
    page.on('response', response => {
      const u = new URL(response.url());
      if (u.origin === ORIGIN && /^\/api\/(?:bootstrap$|state$|upgrade$|battle\/|mine\/)/.test(u.pathname)
          && [401, 403].includes(response.status())) terminalError = true;
    });
    const source = await readFile(join(root, 'makaka-pilot.user.js'), 'utf8');
    await page.evaluateOnNewDocument(`if(location.origin === ${JSON.stringify(ORIGIN)}) {\n${source}\n}`);
    console.log('Открываю игру… Данные входа в журнал не выводятся.');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    try { await page.waitForFunction(() => !!window.MakakaPilot?.status()?.server, { timeout: 30000 }); }
    catch {
      if (terminalError || await page.evaluate(() => document.body.innerText.includes('ОТКРОЙ В TELEGRAM'))) {
        throw new Error('Сервер отклонил сессию. Открой игру заново в Telegram и выполни makaka login со свежей ссылкой.');
      }
      throw new Error('Игра не загрузилась за 30 секунд. Проверь сеть; после обновления игры может потребоваться адаптация скрипта.');
    }
    try { await page.waitForFunction(() => !!window.MakakaPilot?.status()?.battle, { timeout: 15000 }); }
    catch { throw new Error('Вход выполнен, но движок игры не обнаружен. Возможно, игра обновилась; фарм не запускался.'); }
    if (!checkOnly && !stopping) {
      const ok = await page.evaluate(options => window.MakakaPilot.start(options), { ...DEFAULT_OPTIONS, ...config.options });
      if (!ok) throw new Error('Движок игры не обнаружен. Фарм не запущен.');
    }
    console.log(checkOnly ? 'Запуск игры проверен. Бой не включался.' : 'Работает. Остановить: Ctrl+C или makaka stop в другой сессии.');
    let tick = 0;
    do {
      if (!browser.connected) throw new Error('Браузер завершился. Проверь ограничения фоновой работы Android.');
      last = safeStatus(await page.evaluate(() => window.MakakaPilot.status()));
      await privateJson(statusPath, last);
      if (tick++ % 5 === 0 || !last.active || checkOnly) console.log(
        `Бананы: ${last.server?.bananas ?? '?'} | рекорд: ${last.server?.bestWave ?? '?'} | бой: ${last.battle?.wave ?? '-'} ${last.battle?.killed ?? 0}/${last.battle?.total ?? '-'} | ${last.incomePerMinute ?? 0}/мин | ${last.message || ''}`);
      if (checkOnly || stopping || !last.active || terminalError) break;
      if (await readJson(stopPath, false)) { stopping = true; break; }
      await delay(1000);
    } while (true);
    if (terminalError) throw new Error('Сессия отклонена. Обнови ссылку: makaka login.');
  } finally {
    if (page && !page.isClosed()) {
      try {
        const s = await page.evaluate(() => { window.MakakaPilot?.stop('Остановлено из Termux.'); return window.MakakaPilot?.status(); });
        if (s) await privateJson(statusPath, safeStatus(s));
      } catch {}
    }
    await browser?.close().catch(() => {});
    const owner = await readJson(lockPath).catch(() => null);
    if (owner?.pid === process.pid) await unlink(lockPath).catch(() => {});
    spawnSync('termux-wake-unlock', [], { stdio: 'ignore' });
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

try {
  if (command === 'login' || command === 'setup') await login();
  else if (command === 'config') await configure();
  else if (command === 'status') {
    const status = await readJson(statusPath);
    console.log(status ? JSON.stringify(status, null, 2) : 'Пока нет сохранённого статуса. Запуск: makaka');
  } else if (command === 'stop') {
    if (!await readJson(lockPath)) console.log('Скрипт не запущен.');
    else { await privateJson(stopPath, { requestedAt: new Date().toISOString() }); console.log('Запрос остановки отправлен.'); }
  } else if (command === 'check') await run(true);
  else if (command === 'start') await run();
  else if (command === 'doctor') console.log(`Node ${process.version}; Chromium: ${await browserPath()}; настройки: ${stateDir}`);
  else throw new Error('Команды: makaka [start|login|config|check|status|stop|doctor]');
} catch (e) { console.error(redact(e.message)); process.exitCode = 1; }
