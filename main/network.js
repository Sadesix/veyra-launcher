const tls = require('node:tls');

// Node по умолчанию доверяет только своему списку корневых сертификатов, а окно лаунчера (Chromium) — хранилищу Windows.
// Антивирусы с проверкой HTTPS (ESET, Avast, Dr.Web, Kaspersky) и фильтры в сетях подписывают соединения своим корнем
// из хранилища Windows: без него каждая загрузка игры обрывается с «fetch failed», хотя окно и сайт открываются.
// Возвращает, сколько корней добавлено.
function trustSystemCertificates() {
  const current = tls.getCACertificates('default');
  const merged = [...new Set([...current, ...tls.getCACertificates('system')])];
  if (merged.length > current.length) tls.setDefaultCACertificates(merged);
  return merged.length - current.length;
}

const CERTIFICATE = /CERT|SELF_SIGNED|UNABLE_TO_(?:GET|VERIFY)|ERR_TLS|ERR_SSL/;
const OFFLINE = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN']);
const SLOW = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const DROPPED = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);
const networkCode = code => typeof code === 'string' && (CERTIFICATE.test(code) || OFFLINE.has(code) || SLOW.has(code) || DROPPED.has(code));

// Ошибка с сетевым кодом: Node прячет её в cause («fetch failed»), загрузчик @xmcl — в списке AggregateError.
function find(error, test, depth = 0) {
  if (!error || typeof error !== 'object' || depth > 6) return null;
  if (test(error)) return error;
  for (const next of [error.cause, ...(Array.isArray(error.errors) ? error.errors : [])]) {
    const found = find(next, test, depth + 1);
    if (found) return found;
  }
  return null;
}

function hostOf(value) {
  try { return new URL(String(value?.url || value)).host; } catch { return ''; }
}

// Ошибки, которым readableError уже дал текст: адрес в нём известен, повторно он не выводится.
const explained = new WeakSet();

// Понятная причина сетевого сбоя или пустая строка, если ошибка не сетевая.
function networkMessage(error, url) {
  const ready = find(error, item => explained.has(item));
  if (ready) return ready.message;
  const cause = find(error, item => networkCode(item.code));
  if (!cause) return '';
  const host = hostOf(url) || find(error, item => typeof item.hostname === 'string')?.hostname
    || hostOf(find(error, item => Array.isArray(item.urls) && item.urls.length)?.urls[0]);
  const code = cause.code;
  if (CERTIFICATE.test(code)) return 'Соединение с ' + (host || 'сервером') + ' не прошло проверку сертификата (' + code + '): его перехватывает антивирус, прокси или фильтр сети. Отключите в антивирусе проверку защищённых (HTTPS) соединений для Veyra Launcher или добавьте лаунчер в исключения';
  if (OFFLINE.has(code)) return 'Нет связи с ' + (host || 'сервером') + ' (' + code + '): проверьте интернет';
  if (SLOW.has(code)) return (host ? 'Сервер ' + host : 'Сервер') + ' не ответил вовремя (' + code + '): проверьте интернет или повторите попытку позже';
  if (code === 'ECONNREFUSED') return 'Не удалось подключиться к ' + (host || 'серверу') + ' (' + code + '): соединение не пропускает антивирус, прокси или VPN';
  return 'Соединение с ' + (host || 'сервером') + ' оборвалось (' + code + '): его мог сбросить провайдер, антивирус или VPN. Повторите попытку';
}

// Текст ошибки для окна и журнала: сетевая причина, иначе первое непустое сообщение в цепочке.
function describeError(error, url) {
  const network = networkMessage(error, url);
  if (network) return network;
  const named = find(error, item => typeof item.message === 'string' && item.message.trim());
  return named ? named.message : String(error || 'Неизвестная ошибка');
}

// Та же ошибка с понятным текстом: исходная остаётся в cause, отмена и тайм-аут сигнала не меняются.
function readableError(error, url) {
  if (!(error instanceof Error) || error.name === 'AbortError' || error.name === 'TimeoutError' || explained.has(error)) return error;
  const network = networkMessage(error, url);
  if (network) {
    const readable = new Error(network, { cause: error });
    explained.add(readable);
    return readable;
  }
  return error.message.trim() ? error : new Error(describeError(error), { cause: error });
}

// fetch, который сообщает настоящую причину сетевого сбоя вместо «fetch failed».
function readableFetch(fetchImpl) {
  return async (input, init) => {
    try { return await fetchImpl(input, init); }
    catch (error) { throw readableError(error, input); }
  };
}

module.exports = { trustSystemCertificates, networkMessage, describeError, readableError, readableFetch };
