import { privateJson, readJson, validateLaunchUrl } from './core.mjs';
import { launchUserId } from './telegram.mjs';

export function gameAuthError() {
  return Object.assign(new Error('Игровая сессия отклонена. Настрой makaka telegram-login или обнови ссылку через makaka login.'),
    { code: 'GAME_AUTH_EXPIRED' });
}

export async function saveTelegramLaunch(provider, configPath, telegramPath, { checkAccount = true } = {}) {
  const url = validateLaunchUrl(await provider.refresh());
  const previous = await readJson(configPath, {});
  if (launchUserId(url) !== provider.userId ||
      (checkAccount && previous.url && launchUserId(previous.url) !== provider.userId)) {
    throw new Error('Telegram и сохранённая игра принадлежат разным аккаунтам. Повтори makaka telegram-login.');
  }
  await privateJson(telegramPath, provider.sessionData());
  const config = { ...previous, authMode: 'telegram', url };
  await privateJson(configPath, config);
  return config;
}

export async function withRenewedLaunch({ provider, refresh, open, run, closePage,
  stopped = async () => false, now = Date.now, log = console.log }) {
  let lastRefreshAt = null;
  const renew = async () => { await refresh(); lastRefreshAt = now(); };
  if (await stopped()) return;
  if (provider) await renew();
  while (!await stopped()) {
    try {
      await open();
      if (await stopped()) return;
      return await run();
    } catch (error) {
      if (error.code !== 'GAME_AUTH_EXPIRED' || !provider) throw error;
      if (await stopped()) return;
      if (now() - lastRefreshAt < 60000) {
        throw new Error('Свежая ссылка Telegram тоже отклонена сервером. Автоматическое повторение остановлено. Проверь makaka check.');
      }
      await closePage();
      if (await stopped()) return;
      log('Игровая сессия истекла. Получаю свежую ссылку через Telegram…');
      await renew();
    }
  }
}
