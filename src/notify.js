const { execFile } = require('child_process');
const config = require('./config');
const logger = require('./logger');

async function sendTelegram(message) {
  if (!config.telegramToken || !config.telegramChatId) {
    logger.info('Telegram não configurado — notificação ignorada');
    return;
  }

  const url = `https://api.telegram.org/bot${config.telegramToken}/sendMessage`;
  const body = JSON.stringify({
    chat_id: config.telegramChatId,
    text: message,
    parse_mode: 'HTML',
  });

  return new Promise((resolve) => {
    execFile('curl', [
      '-s', '-X', 'POST', url,
      '-H', 'Content-Type: application/json',
      '-d', body,
      '--max-time', '15',
    ], (err, stdout) => {
      if (err) {
        logger.warn(`Falha ao enviar Telegram: ${err.message}`);
        return resolve();
      }
      try {
        const res = JSON.parse(stdout);
        if (res.ok) {
          logger.info('Notificação Telegram enviada com sucesso');
        } else {
          logger.warn(`Telegram erro: ${stdout.substring(0, 200)}`);
        }
      } catch {
        logger.warn(`Telegram resposta inválida: ${stdout.substring(0, 100)}`);
      }
      resolve();
    });
  });
}

async function notifySuccess() {
  const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const prefix = config.sistemaPonto ? `${config.sistemaPonto} - ` : '';
  await sendTelegram(`✅ <b>${prefix}Ponto registrado!</b>\n📅 ${now} (Brasília)`);
}

async function notifyError(errorMsg) {
  const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const prefix = config.sistemaPonto ? `${config.sistemaPonto} - ` : '';
  await sendTelegram(`❌ <b>${prefix}Erro ao bater ponto</b>\n📅 ${now} (Brasília)\n⚠️ ${errorMsg}`);
}

module.exports = { sendTelegram, notifySuccess, notifyError };
