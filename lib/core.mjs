import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

export const ORIGIN = 'https://makaka.wivvi.net';
export const DEFAULT_OPTIONS = Object.freeze({ mode: 'auto', speed: 8,
  mine: true, collect: true, autoUpgrade: true, gearAuto: false,
  farmTarget: 0, farmKills: 0, targetWave: 0, sessionMinutes: 0, reserve: 0 });

export function automaticSessionOptions(options = {}) {
  return { ...DEFAULT_OPTIONS, ...options, mode: 'auto', speed: 8,
    farmTarget: 0, targetWave: 0, gearAuto: false, reserve: 0, autoUpgrade: true,
    // Old saved modes used a one-hour bank/target plan. Migrate them on launch.
    sessionMinutes: options.mode === 'auto' ? (options.sessionMinutes ?? 0) : 0 };
}

export const normalUserAgent = value => String(value).replace(/\bHeadlessChrome\//g, 'Chrome/');

export function farmSessionOptions(options = {}) {
  return { ...DEFAULT_OPTIONS, ...options, mode: 'farmer', speed: 8,
    farmTarget: 0, targetWave: 0, autoUpgrade: false, gearAuto: false };
}

export function validateLaunchUrl(raw) {
  let url;
  try { url = new URL(String(raw).trim()); }
  catch { throw new Error('Нужна полная ссылка игры с #tgWebAppData из Telegram.'); }
  if (url.origin !== ORIGIN || url.username || url.password || url.pathname !== '/') {
    throw new Error('Разрешена только ссылка https://makaka.wivvi.net/.');
  }
  const data = new URLSearchParams(url.hash.slice(1)).get('tgWebAppData');
  const fields = new URLSearchParams(data || '');
  if (!fields.get('user') || !fields.get('auth_date') || !fields.get('hash')) {
    throw new Error('В ссылке нет данных входа Telegram. Скопируй полную ссылку открытой игры.');
  }
  // This checks structure only. Only the game server can validate Telegram's signature.
  return url.href;
}

export function filterHeaders(url, headers) {
  let ownApi = false;
  try { const u = new URL(url); ownApi = u.origin === ORIGIN && u.pathname.startsWith('/api/'); }
  catch { return headers; }
  if (!ownApi) return headers;
  return Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'x-automation'));
}

export function safeStatus(s) {
  return { checkedAt: new Date().toISOString(), version: s.version, active: !!s.active,
    message: redact(s.message || ''), server: s.server && { wave: s.server.wave,
      bestWave: s.server.bestWave, bananas: s.server.bananas,
      damage: s.server.damage, nextDamage: s.server.nextDamage,
      damageLevel: s.server.upgrades?.dmg?.level, damageCost: s.server.upgrades?.dmg?.cost },
    battle: s.battle && { phase: s.battle.phase, wave: s.battle.wave,
      killed: s.battle.killed, total: s.battle.total }, incomePerMinute: s.incomePerMinute,
    serverKills: s.serverKills ? { counted: s.serverKills.counted, target: s.serverKills.target, waiting: !!s.serverKills.waiting } : null,
    damageUpgrades: s.stats?.damageUpgrades,
    automation: s.automation ? { stage: s.automation.stage, attempts: s.automation.attempts,
      nextAttemptSeconds: s.automation.nextAttemptSeconds, attemptSecondsLeft: s.automation.attemptSecondsLeft,
      lastResult: s.automation.history?.at(-1)?.result, combatMode: s.automation.combatMode } : null };
}

export function redact(text) {
  return String(text).replace(/https?:\/\/makaka\.wivvi\.net\/[^\s"'<>]*/gi, ORIGIN + '/[данные входа скрыты]')
    .replace(/(?:tma\s+|tgWebAppData=)[^\s"'<>]+/gi, '[данные входа скрыты]');
}

export function safeText(value) {
  return stripVTControlCharacters(redact(value ?? '')).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

export async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error('Не удалось прочитать настройки. Запусти makaka login или makaka config.'); }
}

export async function privateJson(path, data) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temp = join(dirname(path), `.${process.pid}-${Date.now()}.tmp`);
  await writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
  await chmod(path, 0o600);
}
