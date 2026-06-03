require('dotenv').config();

module.exports = {
  sistemaPonto: process.env.SISTEMA_PONTO || '',

  user: process.env.AHGORA_USER,
  password: process.env.AHGORA_PASS,
  mfaSecret: process.env.AHGORA_MFA_SECRET,

  loginUrl: process.env.AHGORA_LOGIN_URL,
  pontoUrl: process.env.AHGORA_PONTO_URL,

  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,

  gistToken: process.env.GH_GIST_TOKEN,
  gistId: process.env.GIST_ID,

  geoLat: parseFloat(process.env.GEO_LAT) || -3.054679,
  geoLng: parseFloat(process.env.GEO_LNG) || -60.032772,

  headless: process.env.HEADLESS !== 'false',
  debug: process.env.DEBUG === 'true',
  dryRun: process.env.DRY_RUN === 'true',
  reauth: process.env.REAUTH === 'true',
  slowMo: process.env.DEBUG === 'true' ? 80 : 0,
  timeout: 60_000,
};
