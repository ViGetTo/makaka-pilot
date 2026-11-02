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
import { ORIGIN, DEFAULT_OPTIONS, automaticSessionOptions, farmSessionOptions, normalUserAgent, validateLaunchUrl, filterHeaders, measurementBlockedRequest, safeStatus, redact, readJson, privateJson } from './lib/core.mjs';
import { tuneFarm } from './lib/tuning.mjs';
import { probeFastRestart } from './lib/probe.mjs';
import { createTelegramProvider, telegramCredentials } from './lib/telegram.mjs';
import { gameAuthError, saveTelegramLaunch, withRenewedLaunch } from './lib/launch.mjs';
import { createRankings } from './lib/leaderboard.mjs';
import { createConsoleView } from './lib/terminal.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const stateDir = resolve(process.env.MAKAKA_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'makaka-pilot'));
const configPath = join(stateDir, 'launch.json'), lockPath = join(stateDir, 'running.json');
const telegramPath = join(stateDir, 'telegram.json');
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
  await privateJson(configPath, { ...previous, authMode: 'link', url, options: { ...DEFAULT_OPTIONS, ...previous.options } });
  console.log('Ссылка сохранена только на телефоне. Запуск: makaka');
}

async function telegramLogin() {
  await acquire();
  let provider;
  try {
    const previous = await readJson(telegramPath, {});
    const apiId = Number(await question(`api_id из my.telegram.org${previous.apiId ? ' [' + previous.apiId + ']' : ''}: `,
      previous.apiId ? String(previous.apiId) : ''));
    const apiHash = await question('api_hash (ввод скрыт; Enter — сохранённый): ', previous.apiHash || '', true);
    // Explicit setup always creates a new session, including after revocation.
    const credentials = telegramCredentials({ apiId, apiHash, session: '', userId: '' });
    provider = await createTelegramProvider(credentials, { ask: question });
    await saveTelegramLaunch(provider, configPath, telegramPath, { checkAccount: false });
    console.log('Вход Telegram сохранён на телефоне. Ссылки будут обновляться автоматически. Запуск: makaka');
  } finally {
    await provider?.close().catch(() => {});
    const owner = await readJson(lockPath).catch(() => null);
    if (owner?.pid === process.pid) await unlink(lockPath).catch(() => {});
  }
}

async function configure() {
  const previous = await readJson(configPath, {}), opts = automaticSessionOptions(previous.options);
  console.log('Автомат: волны подряд, при отказе — фарм бананов 3 минуты. Урон покупается при наличии денег.');
  for (const [key, label, max] of [ ['farmKills', 'Пачка убийств (0 — авто)', 1000],
    ['sessionMinutes', 'Длительность, минут (0 — без конца)', 1440] ]) {
    const n = Number(await question(`${label} [${opts[key]}]: `, String(opts[key])));
    if (!Number.isFinite(n) || n < 0 || n > max) throw new Error('Недопустимое число. Настройки не изменены.');
    opts[key] = Math.floor(n);
  }
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

async function run(checkOnly = false, tuning = false, probing = false) {
  let config = await readJson(configPath);
  if (!config?.url && config?.authMode !== 'telegram') { await login(); config = await readJson(configPath); }
  if (command === 'farm') config = { ...config, options: farmSessionOptions(config.options) };
  else if (!checkOnly && !tuning && !probing) config = { ...config, options: automaticSessionOptions(config.options) };
  let url = config.authMode === 'telegram' ? null : validateLaunchUrl(config.url);
  const executablePath = await browserPath();
  await acquire();
  let browser, page, provider, view, stopping = false, last = null, terminalError = false, sessionDeadline = null;
  const rankings = createRankings();
  const stop = () => { stopping = true; };
  const stopped = async () => stopping || !!await readJson(stopPath, false);
  const closePage = async () => {
    if (page && !page.isClosed()) {
      try {
        const s = await page.evaluate(() => { window.MakakaPilot?.stop('Закрываю игровую сессию.'); return window.MakakaPilot?.status(); });
        if (s) {
          const finalStatus = { ...safeStatus(s), rankings: rankings.snapshot() };
          view?.update(finalStatus);
          await privateJson(statusPath, finalStatus);
        }
      } catch {}
      view?.close(); view = null;
      await page.close().catch(() => {});
    }
    view?.close(); view = null;
    rankings.reset();
    page = null;
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  spawnSync('termux-wake-lock', [], { stdio: 'ignore' });
  try {
    if (config.authMode === 'telegram') provider = await createTelegramProvider(await readJson(telegramPath, {}));
    const { default: puppeteer } = await import('puppeteer-core');
    browser = await puppeteer.launch({ executablePath, headless: true, timeout: 45000,
      defaultViewport: { width: 430, height: 860, deviceScaleFactor: 1 },
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
    await withRenewedLaunch({ provider, stopped, closePage,
      refresh: async () => {
        console.log('Получаю свежую ссылку игры через Telegram…');
        const fresh = await saveTelegramLaunch(provider, configPath, telegramPath);
        config = { ...fresh, options: config.options }; url = fresh.url;
      },
      open: async () => {
        terminalError = false;
        page = await browser.newPage();
        const openedPage = page;
        await page.setUserAgent({ userAgent: normalUserAgent(await browser.userAgent()) });
        await page.setRequestInterception(true);
        page.on('request', request => {
          // The official client can collect autoclicker income even on the battle tab.
          if ((tuning || probing) && measurementBlockedRequest(request.url(), request.method())) {
            request.abort('blockedbyclient').catch(() => {}); return;
          }
          const headers = filterHeaders(request.url(), request.headers());
          request.continue({ headers }).catch(() => {});
        });
        page.on('response', response => {
          if (page !== openedPage) return;
          const u = new URL(response.url());
          if (u.origin !== ORIGIN || !/^\/api\/(?:bootstrap$|state$|upgrade$|battle\/|mine\/)/.test(u.pathname)) return;
          if ([401, 403].includes(response.status())) terminalError = true;
          else if (response.status() >= 400) response.json().then(data => {
            if (page === openedPage && data.error === 'expired') terminalError = true;
          }).catch(() => {});
        });
        const source = await readFile(join(root, 'makaka-pilot.user.js'), 'utf8');
        await page.evaluateOnNewDocument(`if(location.origin === ${JSON.stringify(ORIGIN)}) {\n${source}\n}`);
        console.log('Открываю игру… Данные входа в журнал не выводятся.');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        try { await page.waitForFunction(() => !!window.MakakaPilot?.status()?.server, { timeout: 30000 }); }
        catch {
          if (terminalError || await page.evaluate(() => document.body.innerText.includes('ОТКРОЙ В TELEGRAM'))) {
            throw gameAuthError();
          }
          throw new Error('Игра не загрузилась за 30 секунд. Проверь сеть; после обновления игры может потребоваться адаптация скрипта.');
        }
        try { await page.waitForFunction(() => !!window.MakakaPilot?.status()?.battle, { timeout: 15000 }); }
        catch {
          if (terminalError) throw gameAuthError();
          throw new Error('Вход выполнен, но движок игры не обнаружен. Возможно, игра обновилась; фарм не запускался.');
        }
      },
      run: async () => {
        try {
          if (tuning && !stopping) {
            const ranked = await tuneFarm(page, { stopped: () => stopping,
              readStop: async () => !!await readJson(stopPath, false) });
            if (!ranked?.length) { console.log('Подбор остановлен. Настройки не изменены.'); return; }
            await privateJson(join(stateDir, 'tuning.json'), { measuredAt: new Date().toISOString(), samples: ranked });
            const fresh = await readJson(configPath, config);
            await privateJson(configPath, { ...fresh, options: { ...DEFAULT_OPTIONS, ...fresh.options,
              farmKills: ranked[0].kills } });
            console.log(`Выбрано ${ranked[0].kills} убийств: ${Math.round(ranked[0].perMinute)} бананов/мин в коротком замере. Запуск: makaka`);
            return;
          }
          if (probing && !stopping) {
            console.log('Проверяю быстрые убийства и выход через паузу. Покупки, кликер и сбор выключены.');
            const result = await probeFastRestart(page, { stopped: () => stopping,
              readStop: async () => !!await readJson(stopPath, false) });
            await privateJson(join(stateDir, 'probe.json'), result);
            console.log(result.message);
            console.log(`Баланс до: ${result.before?.bananas ?? '?'}; после выхода: ${result.afterExit?.bananas ?? '?'}; после перезапуска: ${result.afterRestart?.bananas ?? '?'}.`);
            console.log(`Отчёт: ${join(stateDir, 'probe.json')}`);
            return;
          }
          if (!checkOnly && !stopping) {
            const options = { ...DEFAULT_OPTIONS, ...config.options };
            if (options.sessionMinutes > 0) {
              sessionDeadline ??= Date.now() + options.sessionMinutes * 60000;
              if (Date.now() >= sessionDeadline) { console.log('Заданный сеанс завершён.'); return; }
              options.sessionMinutes = (sessionDeadline - Date.now()) / 60000;
            }
            const ok = await page.evaluate(options => window.MakakaPilot.start(options), options);
            if (!ok) throw new Error('Движок игры не обнаружен. Фарм не запущен.');
          }
          if (checkOnly) console.log('Запуск игры проверен. Бой не включался.');
          view = createConsoleView();
          do {
            if (!browser.connected) throw new Error('Браузер завершился. Проверь ограничения фоновой работы Android.');
            if (provider && await provider.keepAlive()) throw gameAuthError();
            rankings.refresh(page).catch(() => {});
            last = { ...safeStatus(await page.evaluate(() => window.MakakaPilot.status())), rankings: rankings.snapshot() };
            await privateJson(statusPath, last);
            view.update(last);
            if (checkOnly || stopping || !last.active || terminalError) break;
            if (await readJson(stopPath, false)) { stopping = true; break; }
            await delay(1000);
          } while (true);
          if (terminalError) throw gameAuthError();
        } catch (error) { if (terminalError) throw gameAuthError(); throw error; }
      },
    });
  } finally {
    await closePage();
    await browser?.close().catch(() => {});
    await provider?.close().catch(() => {});
    const owner = await readJson(lockPath).catch(() => null);
    if (owner?.pid === process.pid) await unlink(lockPath).catch(() => {});
    spawnSync('termux-wake-unlock', [], { stdio: 'ignore' });
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

try {
  if (command === 'login' || command === 'setup') await login();
  else if (command === 'telegram-login') await telegramLogin();
  else if (command === 'config') await configure();
  else if (command === 'status') {
    const status = await readJson(statusPath);
    if (status) { const view = createConsoleView(); view.update(status); view.close(); }
    else console.log('Пока нет сохранённого статуса. Запуск: makaka');
  } else if (command === 'stop') {
    if (!await readJson(lockPath)) console.log('Скрипт не запущен.');
    else { await privateJson(stopPath, { requestedAt: new Date().toISOString() }); console.log('Запрос остановки отправлен.'); }
  } else if (command === 'check') await run(true);
  else if (command === 'tune') await run(false, true);
  else if (command === 'probe') await run(false, false, true);
  else if (command === 'start' || command === 'farm') await run();
  else if (command === 'doctor') console.log(`Node ${process.version}; Chromium: ${await browserPath()}; настройки: ${stateDir}`);
  else throw new Error('Команды: makaka [start|farm|telegram-login|login|config|tune|probe|check|status|stop|doctor]');
} catch (e) { console.error(redact(e.message)); process.exitCode = 1; }
