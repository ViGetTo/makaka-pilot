import { ORIGIN, validateLaunchUrl } from './core.mjs';

export const GAME_BOT = 'makaka_killer_bot';

export function telegramCredentials(value = {}, requireSession = false) {
  const apiId = Number(value.apiId), apiHash = String(value.apiHash || '').trim();
  if (!Number.isSafeInteger(apiId) || apiId <= 0 || apiId > 2147483647 || !/^[a-f\d]{32}$/i.test(apiHash)) {
    throw new Error('Нужны собственные api_id и api_hash из my.telegram.org. Ввод: makaka telegram-login.');
  }
  if (requireSession && (!value.session || !/^\d+$/.test(String(value.userId || '')))) {
    throw new Error('Нет сохранённой сессии Telegram. Выполни makaka telegram-login.');
  }
  return { version: 1, apiId, apiHash, session: String(value.session || ''), userId: String(value.userId || '') };
}

export function launchUserId(raw) {
  const url = new URL(validateLaunchUrl(raw));
  const data = new URLSearchParams(new URLSearchParams(url.hash.slice(1)).get('tgWebAppData'));
  let user;
  try { user = JSON.parse(data.get('user')); } catch { /* Invalid data is rejected below. */ }
  if (!/^\d+$/.test(String(user?.id || ''))) throw new Error('В ссылке игры нет корректного идентификатора аккаунта.');
  return String(user.id);
}

export function telegramFailure(error) {
  // RPC errors may contain request arguments. Only expose known, fixed messages.
  const code = String(error?.errorMessage || '');
  if (/FLOOD_WAIT|PHONE_NUMBER_FLOOD|API_ID_PUBLISHED_FLOOD/.test(code)) {
    return Object.assign(new Error('Telegram ограничил частоту входа. Повтори позже; автоматического подбора кодов нет.'), { code: 'TELEGRAM_ACCESS' });
  }
  const messages = {
    API_ID_INVALID: 'Telegram отклонил api_id/api_hash. Проверь данные через makaka telegram-login.',
    PHONE_NUMBER_INVALID: 'Telegram отклонил номер. Нужен номер существующего аккаунта с кодом страны.',
    PHONE_CODE_INVALID: 'Неверный код входа Telegram.',
    PHONE_CODE_EXPIRED: 'Код Telegram истёк. Повтори makaka telegram-login.',
    PASSWORD_HASH_INVALID: 'Неверный пароль двухэтапной проверки Telegram.',
    SESSION_REVOKED: 'Сессия Telegram отозвана. Выполни makaka telegram-login.',
    SESSION_EXPIRED: 'Сессия Telegram истекла. Выполни makaka telegram-login.',
    AUTH_KEY_UNREGISTERED: 'Сессия Telegram больше не действует. Выполни makaka telegram-login.',
    AUTH_KEY_DUPLICATED: 'Сессия Telegram используется на другом устройстве. Выполни makaka telegram-login на этом телефоне.',
    USER_DEACTIVATED: 'Аккаунт Telegram недоступен.',
    USER_DEACTIVATED_BAN: 'Аккаунт Telegram недоступен.',
    YOU_BLOCKED_USER: 'Бот игры заблокирован в Telegram. Разблокируй его и открой игру.',
    BOT_WEBVIEW_DISABLED: 'Telegram не открыл игру. Открой @makaka_killer_bot и запусти игру один раз.',
  };
  return Object.assign(new Error(messages[code] || 'Не удалось получить доступ через Telegram. Проверь сеть и makaka telegram-login.'),
    { code: 'TELEGRAM_ACCESS' });
}

export async function createTelegramProvider(value, { ask, notice = console.log,
  loadSdk = () => import('teleproto'), now = Date.now } = {}) {
  const credentials = telegramCredentials(value, !ask);
  const { Api, TelegramClient, Logger, sessions, utils } = await loadSdk();
  let client;
  try {
    client = new TelegramClient(new sessions.StringSession(credentials.session), credentials.apiId, credentials.apiHash, {
      baseLogger: new Logger('none'), connectionRetries: 2, reconnectRetries: 2,
      requestRetries: 1, retryDelay: 1000, timeout: 10, floodSleepThreshold: 0,
      catchUp: false, deviceModel: 'Makaka Pilot (Termux)', appVersion: '2.11.0',
      langCode: 'ru', systemLangCode: 'ru',
    });
  } catch { throw new Error('Не удалось прочитать сессию Telegram. Выполни makaka telegram-login.'); }
  let peer, bot, queryId = null, prolongAt = 0, closed = false;
  const close = async () => { if (closed) return; closed = true; queryId = null; await client.destroy(); };
  const bounded = async task => {
    let timer;
    try {
      return await Promise.race([task(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Telegram request timeout.')), 45000);
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    if (ask) {
      let lastError, failures = 0;
      try {
        await client.start({
          phoneNumber: () => ask('Номер Telegram с кодом страны (ввод скрыт): ', '', true),
          phoneCode: () => ask('Код входа от Telegram (ввод скрыт): ', '', true),
          password: () => ask('Пароль 2FA Telegram (ввод скрыт): ', '', true),
          emailAddress: () => ask('Email, запрошенный Telegram (ввод скрыт): ', '', true),
          emailVerification: () => ask('Код из письма Telegram (ввод скрыт): ', '', true),
          acceptTermsOfService: async () => false,
          onError: async error => {
            lastError = error; failures++;
            notice(telegramFailure(error).message);
            return failures >= 3 || !['PHONE_CODE_INVALID', 'PASSWORD_HASH_INVALID'].includes(error.errorMessage);
          },
        });
      } catch (error) { throw telegramFailure(lastError || error); }
    } else await bounded(() => client.connect());
    const me = await bounded(() => client.getMe());
    if (me.bot || !me.id) throw Object.assign(new Error('Для входа нужен пользовательский аккаунт Telegram.'), { code: 'TELEGRAM_ACCESS' });
    if (credentials.userId && credentials.userId !== String(me.id)) {
      throw Object.assign(new Error('Сессия Telegram принадлежит другому аккаунту. Повтори makaka telegram-login.'), { code: 'TELEGRAM_ACCESS' });
    }
    credentials.userId = String(me.id);
  } catch (error) {
    await close().catch(() => {});
    if (error.code === 'TELEGRAM_ACCESS') throw error;
    throw telegramFailure(error);
  }
  return {
    userId: credentials.userId,
    sessionData() {
      const session = client.session.save();
      if (!session) throw new Error('Не удалось сохранить сессию Telegram. Повтори makaka telegram-login.');
      return { ...credentials, session };
    },
    async refresh() {
      if (closed) throw new Error('Соединение Telegram закрыто.');
      let result;
      try {
        result = await bounded(async () => {
          if (!client.connected) await client.connect();
          peer ||= await client.getInputEntity(GAME_BOT);
          bot ||= utils.getInputUser(peer);
          try { return await client.invoke(new Api.messages.RequestMainWebView({ peer, bot, platform: 'android' })); }
          catch (error) {
            if (!['BOT_INVALID', 'BOT_APP_INVALID', 'BOT_WEBVIEW_DISABLED'].includes(error.errorMessage)) throw error;
            return client.invoke(new Api.messages.RequestWebView({ peer, bot, platform: 'android', fromBotMenu: true, url: ORIGIN + '/' }));
          }
        });
      } catch (error) { throw telegramFailure(error); }
      const url = validateLaunchUrl(result.url);
      if (launchUserId(url) !== credentials.userId) throw new Error('Telegram вернул ссылку для другого аккаунта. Вход остановлен.');
      queryId = result.queryId && String(result.queryId) !== '0' ? result.queryId : null;
      prolongAt = now() + 60000;
      return url;
    },
    async keepAlive() {
      if (closed || queryId === null || now() < prolongAt) return false;
      prolongAt = now() + 60000;
      try {
        await bounded(() => client.invoke(new Api.messages.ProlongWebView({ peer, bot, queryId })));
        return false;
      } catch (error) {
        if (error.errorMessage === 'QUERY_ID_INVALID') { queryId = null; return true; }
        throw telegramFailure(error);
      }
    },
    close,
  };
}
