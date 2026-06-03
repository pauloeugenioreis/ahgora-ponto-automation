const { execFile } = require('child_process');
const config = require('./config');
const logger = require('./logger');
const { sendTelegram } = require('./notify');
const gist = require('./gist-storage');

function curlGet(url) {
  return new Promise((resolve) => {
    execFile('curl', ['-s', url, '--max-time', '10'], (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

async function getUpdates() {
  const url = `https://api.telegram.org/bot${config.telegramToken}/getUpdates?timeout=0`;
  const json = await curlGet(url);
  return (json && json.ok) ? (json.result || []) : [];
}

async function confirmUpdates(updateId) {
  const url = `https://api.telegram.org/bot${config.telegramToken}/getUpdates?offset=${updateId + 1}&timeout=0`;
  return new Promise((resolve) => {
    execFile('curl', ['-s', url, '--max-time', '10'], () => resolve());
  });
}

function parseDate(text) {
  const match = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) return null;
  const [, day, month, year] = match;
  const d = parseInt(day), m = parseInt(month), y = parseInt(year);
  if (d < 1 || d > 31 || m < 1 || m > 12 || y < 2024) return null;
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}

function dateFromStr(dateStr) {
  const parts = dateStr.split('/');
  if (parts.length !== 3) return null;

  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const year = parseInt(parts[2], 10);
  const dt = new Date(Date.UTC(year, month - 1, day));

  if (
    Number.isNaN(dt.getTime()) ||
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }

  return dt;
}

function formatDate(dt) {
  return `${String(dt.getUTCDate()).padStart(2, '0')}/${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${dt.getUTCFullYear()}`;
}

function compareDateStr(a, b) {
  const da = dateFromStr(a);
  const db = dateFromStr(b);
  if (!da || !db) return 0;
  return da - db;
}

function buildRange(startDateStr, endDateStr) {
  const start = dateFromStr(startDateStr);
  const end = dateFromStr(endDateStr);
  if (!start || !end || end < start) return null;

  const range = [];
  const cursor = new Date(start.getTime());
  while (cursor <= end) {
    range.push(formatDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return range;
}

function getToday() {
  return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function getComandoPrefix() {
  if (!config.sistemaPonto || !config.sistemaPonto.trim()) return '';
  return config.sistemaPonto.trim().toLowerCase().replace(/\s+/g, '_');
}

async function checkTelegramAndProcess() {
  if (!config.telegramToken || !config.telegramChatId) {
    logger.info('Telegram não configurado — comandos ignorados');
    return false;
  }

  await gist.cleanupPastDates();

  logger.info('Verificando mensagens do Telegram...');
  const updates = await getUpdates();

  let maxUpdateId = 0;
  let processedCount = 0;
  let shouldConfirmOffset = false;

  let localDisabledDates = await gist.getDisabledDates();

  if (updates.length > 0) {
    for (const update of updates) {
      const msg = update.message;
      if (update.update_id > maxUpdateId) maxUpdateId = update.update_id;

      if (!msg || !msg.text) continue;
      if (String(msg.chat.id) !== String(config.telegramChatId)) continue;

      const rawCmd = msg.text.trim().toLowerCase().replace(/^\//, '');
      const cmdPrefix = getComandoPrefix();

      let cmd = rawCmd;
      if (cmdPrefix) {
        const prefixWithUnderscore = cmdPrefix + '_';
        if (!rawCmd.startsWith(prefixWithUnderscore) && rawCmd !== cmdPrefix) continue;
        cmd = rawCmd === cmdPrefix ? '' : rawCmd.slice(prefixWithUnderscore.length);
      }

      let reply = null;
      const prefix = config.sistemaPonto ? `${config.sistemaPonto} - ` : '';
      const cmdExemplo = cmdPrefix ? `/${cmdPrefix}_` : '/';

      if (cmd.startsWith('desativar')) {
        const matches = msg.text.match(/\d{1,2}\/\d{1,2}\/\d{4}/g) || [];
        const startDate = matches[0] ? parseDate(matches[0]) : null;
        const endDate = matches[1] ? parseDate(matches[1]) : null;

        if (!startDate || matches.length > 2) {
          reply = `${prefix}⚠️ Formato inválido.\nUse: <code>${cmdExemplo}desativar DD/MM/YYYY</code> ou <code>${cmdExemplo}desativar DD/MM/YYYY DD/MM/YYYY</code>`;
        } else if (endDate) {
          const range = buildRange(startDate, endDate);
          if (!range) {
            reply = `${prefix}⚠️ Período inválido.\nA data final deve ser maior ou igual à inicial.`;
          } else if (range.length > 366) {
            reply = `${prefix}⚠️ Período muito grande.\nUse no máximo 366 dias por comando.`;
          } else {
            const disabledSet = new Set(localDisabledDates);
            let addedCount = 0;
            for (const dateStr of range) {
              if (!disabledSet.has(dateStr)) {
                disabledSet.add(dateStr);
                addedCount++;
              }
            }

            if (addedCount === 0) {
              reply = `${prefix}ℹ️ Todas as datas desse período já estavam desativadas`;
            } else {
              localDisabledDates = Array.from(disabledSet).sort(compareDateStr);
              await gist.saveDisabledDates(localDisabledDates);
              reply = `${prefix}⏸️ Ponto <b>desativado</b> de ${startDate} até ${endDate} (${addedCount} data(s))`;
            }
          }
          shouldConfirmOffset = true;
        } else if (localDisabledDates.includes(startDate)) {
          continue;
        } else {
          await gist.disableDate(startDate);
          localDisabledDates.push(startDate);
          reply = `${prefix}⏸️ Ponto <b>desativado</b> para ${startDate}`;
          shouldConfirmOffset = true;
        }
      } else if (cmd.startsWith('reativar')) {
        const dateStr = parseDate(msg.text);
        if (!dateStr) {
          reply = `${prefix}⚠️ Formato inválido.\nUse: <code>${cmdExemplo}reativar DD/MM/YYYY</code>`;
        } else {
          const removed = await gist.enableDate(dateStr);
          if (removed) {
            localDisabledDates = localDisabledDates.filter((d) => d !== dateStr);
          }
          reply = removed
            ? `${prefix}▶️ Ponto <b>reativado</b> para ${dateStr}`
            : `${prefix}ℹ️ ${dateStr} já estava ativo`;
          shouldConfirmOffset = true;
        }
      } else if (cmd.startsWith('status')) {
        const today = getToday();
        reply = localDisabledDates.includes(today)
          ? `${prefix}⏸️ Hoje (${today}) está <b>desativado</b>`
          : `${prefix}▶️ Hoje (${today}) está <b>ativo</b>`;
        shouldConfirmOffset = true;
      } else if (cmd.startsWith('listar')) {
        if (localDisabledDates.length === 0) {
          reply = `${prefix}📋 Nenhuma data desativada`;
        } else {
          const list = localDisabledDates.map((d) => `  • ${d}`).join('\n');
          reply = `${prefix}📋 <b>Datas desativadas:</b>\n${list}`;
        }
        shouldConfirmOffset = true;
      } else {
        reply = `${prefix}🤖 <b>Comandos disponíveis:</b>\n\n` +
          `<code>${cmdExemplo}desativar DD/MM/YYYY</code> — Pula o ponto nessa data\n` +
          `<code>${cmdExemplo}desativar DD/MM/YYYY DD/MM/YYYY</code> — Pula o ponto em um período\n` +
          `<code>${cmdExemplo}reativar DD/MM/YYYY</code> — Cancela um desativar\n` +
          `<code>${cmdExemplo}status</code> — Verifica se hoje está ativo\n` +
          `<code>${cmdExemplo}listar</code> — Mostra datas desativadas`;
        shouldConfirmOffset = true;
      }

      if (reply) {
        await sendTelegram(reply);
        processedCount++;
      }
    }

    if (shouldConfirmOffset && maxUpdateId > 0) {
      await confirmUpdates(maxUpdateId);
      logger.info(`Offset avançado para ${maxUpdateId + 1}`);
    }
  }

  const today = getToday();
  const todayDisabled = localDisabledDates.includes(today);

  logger.info(`Mensagens recebidas: ${updates.length}, processadas: ${processedCount}`);
  logger.info(`Hoje (${today}) desativado: ${todayDisabled}`);
  return todayDisabled;
}

module.exports = { checkTelegramAndProcess };
