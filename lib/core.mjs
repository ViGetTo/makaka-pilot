import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const ORIGIN = 'https://makaka.wivvi.net';
export const DEFAULT_OPTIONS = Object.freeze({ mode: 'farmer', speed: 8,
  mine: true, collect: true, autoUpgrade: false, gearAuto: false,
  farmTarget: 1000000, farmKills: 0, targetWave: 60, sessionMinutes: 60, reserve: 0 });

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
      bestWave: s.server.bestWave, bananas: s.server.bananas },
    battle: s.battle && { phase: s.battle.phase, wave: s.battle.wave,
      killed: s.battle.killed, total: s.battle.total }, incomePerMinute: s.incomePerMinute };
}

export function redact(text) {
  return String(text).replace(/https?:\/\/makaka\.wivvi\.net\/[^\s"'<>]*/gi, ORIGIN + '/[данные входа скрыты]')
    .replace(/(?:tma\s+|tgWebAppData=)[^\s"'<>]+/gi, '[данные входа скрыты]');
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
