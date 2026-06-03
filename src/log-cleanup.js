const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(process.cwd(), 'logs');
const MARKER_FILE = path.join(LOGS_DIR, '.last-cleanup');
const RETENTION_DAYS = 30;

async function runMonthlyLogCleanup() {
  try {
    if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') return;

    if (!fs.existsSync(LOGS_DIR)) return;

    const now = Date.now();
    const retentionMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;

    if (fs.existsSync(MARKER_FILE)) {
      const lastCleanup = fs.statSync(MARKER_FILE).mtimeMs;
      if (now - lastCleanup < retentionMs) return;
    }

    const entries = fs.readdirSync(LOGS_DIR, { withFileTypes: true });
    let removed = 0;

    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (ent.name === '.last-cleanup') continue;

      const filePath = path.join(LOGS_DIR, ent.name);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > retentionMs) {
        fs.unlinkSync(filePath);
        removed++;
      }
    }

    fs.writeFileSync(MARKER_FILE, new Date().toISOString(), 'utf8');

    if (removed > 0) {
      const logger = require('./logger');
      logger.info(`Limpeza mensal de logs: ${removed} arquivo(s) removido(s) (mais antigos que ${RETENTION_DAYS} dias)`);
    }
  } catch (err) {
    const logger = require('./logger');
    logger.warn(`Limpeza mensal de logs falhou: ${err.message}`);
  }
}

module.exports = { runMonthlyLogCleanup };
