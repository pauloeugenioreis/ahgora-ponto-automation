const https = require('https');
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
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          logger.info('Notificação Telegram enviada com sucesso');
        } else {
          logger.warn(`Telegram respondeu com status ${res.statusCode}: ${data}`);
        }
        resolve(data);
      });
    });

    req.on('error', (err) => {
      logger.warn(`Falha ao enviar Telegram: ${err.message}`);
      resolve();
    });

    req.write(body);
    req.end();
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
