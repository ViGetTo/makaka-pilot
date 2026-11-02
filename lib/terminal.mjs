import { safeText } from './core.mjs';
import { stripVTControlCharacters } from 'node:util';

const segments = new Intl.Segmenter('ru', { granularity: 'grapheme' });
const glyphs = value => [...segments.segment(stripVTControlCharacters(String(value ?? '')))].map(x => x.segment);
const glyphWidth = glyph => {
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(glyph)) return 2;
  if (/^\p{Mark}+$/u.test(glyph)) return 0;
  const c = glyph.codePointAt(0);
  return c >= 0x1100 && (c <= 0x115f || c === 0x2329 || c === 0x232a ||
    (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe10 && c <= 0xfe6f) ||
    (c >= 0xff01 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || c >= 0x20000) ? 2 : 1;
};
export const displayWidth = value => glyphs(value).reduce((sum, glyph) => sum + glyphWidth(glyph), 0);
export function clipText(value, width) {
  const plain = safeText(value), parts = glyphs(plain);
  if (displayWidth(plain) <= width) return parts.join('');
  let text = '', used = 0;
  for (const glyph of parts) {
    const size = glyphWidth(glyph);
    if (used + size > width - 1) break;
    text += glyph; used += size;
  }
  return width > 0 ? text + '…' : '';
}
const number = value => Number.isFinite(value) ? Math.floor(value).toLocaleString('ru-RU').replace(/\u00a0/g, ' ') : '—';
const clock = value => Number.isFinite(value) ? Math.floor(Math.max(0, value) / 60).toString().padStart(2, '0') + ':' +
  Math.floor(Math.max(0, value) % 60).toString().padStart(2, '0') : '—';
const palette = { border: '90', title: '1;97', success: '1;32', gold: '1;33', info: '36', damage: '1;94', top: '35', muted: '90', warn: '33', error: '1;31' };
const paint = (value, style, color) => color ? '\x1b[' + palette[style] + 'm' + value + '\x1b[0m' : value;

export function formatStatus(status, { columns = 80, color = false } = {}) {
  const width = Math.max(24, Math.min(92, columns - 1)), inner = width - 4;
  const rows = [];
  const add = (text, style = 'info') => rows.push({ text, style });
  const auto = status.automation, server = status.server || {}, battle = status.battle;
  const stages = { farm: 'ФАРМ БАНАНОВ', prepare: 'ПОДГОТОВКА ВОЛНЫ', push: 'ПРОХОЖДЕНИЕ ВОЛН', retreat: 'ВОЗВРАТ К ФАРМУ' };
  const runtimeState = status.runtime?.state;
  const stale = runtimeState === 'unresponsive' || runtimeState === 'stopped';
  const label = runtimeState === 'unresponsive' ? 'НЕТ СВЕЖИХ ДАННЫХ' : runtimeState === 'stopped' ? 'СОХРАНЁННЫЕ ДАННЫЕ' :
    runtimeState === 'starting' ? 'ЗАПУСК СКРИПТА' : runtimeState === 'stopping' ? 'ОСТАНОВКА СКРИПТА' :
      status.active ? stages[auto?.stage] || 'РАБОТАЕТ' : 'ОСТАНОВЛЕНО';
  add(label, status.active ?
    auto?.stage === 'farm' || auto?.stage === 'retreat' ? 'warn' : 'success' : 'muted');
  add('Бананы: ' + number(server.bananas), 'gold');
  add('Доход: ' + (Number.isFinite(status.incomePerMinute) ?
    (status.incomePerMinute < 0 ? '' : '+') + number(status.incomePerMinute) + ' / мин' : '—'), 'success');
  if (status.active && status.farm && (!auto || auto.stage === 'farm')) {
    add('Фарм: ' + (status.farm.timing === 'spawn' ? 'короткий' : 'обычный') + ' · пачка ' + number(status.farm.targetKills), 'muted');
  }
  add('Рекорд: ' + number(server.bestWave) + ' · попыток: ' + number(auto?.attempts));
  add(stale ? 'Бой: нет актуальных данных' : battle?.wave ? 'Волна ' + number(battle.wave) + ': ' + number(battle.killed) + '/' + number(battle.total) + ' локально' : 'Бой: подготовка / переход');
  if (battle?.wave) add('Зачтено сервером: ' + number(status.serverKills?.counted) + '/' + number(status.serverKills?.target ?? battle.total), 'muted');
  add('Урон: ' + number(server.damage) + ' · уровень ' + number(server.damageLevel), 'damage');
  if (server.damageCost === null) add('Урон улучшен до максимума', 'damage');
  else {
    add('Цена улучшения: ' + number(server.damageCost), 'damage');
    if (Number.isFinite(server.damageCost) && Number.isFinite(server.bananas)) {
      const missing = Math.max(0, server.damageCost - server.bananas);
      add(missing ? (status.active ? 'Коплю на урон: ещё ' : 'До улучшения урона: ') + number(missing) :
        status.active ? 'Деньги на урон есть · покупаю' : 'Улучшение урона доступно', missing ? 'muted' : 'success');
    }
  }
  if (status.active && (auto?.stage === 'farm' || auto?.stage === 'prepare' && auto.nextAttemptSeconds !== null)) {
    add('До проверки волны: ' + clock(auto.nextAttemptSeconds), 'warn');
  } else if (status.active && auto?.stage === 'push') add('Осталось на попытку: ' + clock(auto.attemptSecondsLeft), 'muted');
  if (auto?.stage === 'farm' && auto.lastResult && auto.lastResult !== 'cleared') {
    const reasons = { too_fast: 'сервер отклонил волну', timeout: 'лимит попытки', damage_too_low: 'не хватает урона', failed: 'поражение' };
    add('Причина фарма: ' + (reasons[auto.lastResult] || 'волна не принята'), 'error');
  }
  const ranks = status.rankings || {};
  for (const [key, label] of [['wave', 'волнам'], ['bananas', 'добыче']]) {
    const board = ranks[key];
    add('Место по ' + label + ': ' + (board?.rank ? '#' + number(board.rank) : '—') +
      (board?.stale ? board.checkedAt ? ' · старые данные' : ' · нет данных' : ''), 'top');
  }
  if (ranks.wave?.leaders?.length) {
    const checked = new Date(ranks.wave.checkedAt);
    add('Лидеры волн' + (!Number.isNaN(+checked) ? ' · ' + checked.toLocaleTimeString('ru-RU', { hour12: false }) : ''), 'top');
    for (const row of ranks.wave.leaders) {
      const prefix = '#' + row.place + ' ', suffix = ' · ' + number(row.value);
      add(prefix + clipText(row.name, Math.max(0, inner - displayWidth(prefix + suffix))) + suffix, 'muted');
    }
  } else add(ranks.wave?.error || 'Рейтинг обновляется раз в минуту', 'muted');
  add(status.message || 'Ожидаю данные игры…', status.active ? 'info' : 'muted');
  const checked = status.checkedAt ? new Date(status.checkedAt) : null;
  const stamp = checked && !Number.isNaN(+checked) ? stale ? checked.toLocaleString('ru-RU', { hour12: false }) :
    checked.toLocaleTimeString('ru-RU', { hour12: false }) : '';
  const title = clipText('MAKAKA ' + (status.version || '') + ' · ' + stamp, width - 5);
  const frame = [paint('╭─ ' + title + ' ' + '─'.repeat(Math.max(0, width - 5 - displayWidth(title))) + '╮', 'title', color)];
  for (const { text, style } of rows) {
    const clipped = clipText(text, inner);
    frame.push(paint('│ ', 'border', color) + paint(clipped + ' '.repeat(Math.max(0, inner - displayWidth(clipped))), style, color) + paint(' │', 'border', color));
  }
  const footer = clipText(runtimeState === 'unresponsive' ? 'makaka status · makaka stop' :
    runtimeState === 'starting' || runtimeState === 'stopping' ? 'makaka stop — остановить' :
      status.active ? 'Ctrl+C — стоп' : 'makaka — запуск', width - 5);
  frame.push(paint('╰─ ' + footer + ' ' + '─'.repeat(Math.max(0, width - 5 - displayWidth(footer))) + '╯', 'border', color));
  return frame.join('\n');
}

export function createConsoleView(stream = process.stdout, env = process.env, now = Date.now) {
  const interactive = !!stream.isTTY && env.TERM !== 'dumb';
  const color = !('NO_COLOR' in env) && env.FORCE_COLOR !== '0' && (interactive || !!env.FORCE_COLOR);
  let height = 0, lastPrintAt = -Infinity, lastKey = '', cursorHidden = false;
  return {
    update(status) {
      const key = [status.active, status.automation?.stage, status.server?.damageLevel].join(':');
      if (!interactive && now() - lastPrintAt < 5000 && key === lastKey) return;
      const output = formatStatus(status, { columns: stream.columns || 80, color });
      if (interactive) {
        if (!cursorHidden) { stream.write('\x1b[?25l'); cursorHidden = true; }
        if (height) stream.write('\x1b[' + height + 'F');
        const lines = output.split('\n'), nextHeight = lines.length;
        stream.write(lines.map(line => '\x1b[2K' + line).join('\n') + '\n');
        if (height > nextHeight) {
          stream.write(('\x1b[2K\n').repeat(height - nextHeight));
          stream.write('\x1b[' + (height - nextHeight) + 'F');
        }
        height = nextHeight;
      } else stream.write(output + '\n\n');
      lastPrintAt = now(); lastKey = key;
    },
    close() { if (cursorHidden) stream.write('\x1b[?25h'); cursorHidden = false; height = 0; },
  };
}
