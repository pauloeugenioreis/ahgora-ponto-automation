const https = require('https');
const config = require('./config');
const logger = require('./logger');

const GIST_FILENAME = 'app-ahgora-disabled-dates.json';

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getDisabledDates() {
  if (!config.gistToken || !config.gistId) {
    logger.warn('Gist não configurado — persistência desativada');
    return [];
  }

  try {
    const res = await request({
      hostname: 'api.github.com',
      path: `/gists/${config.gistId}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.gistToken}`,
        'User-Agent': 'ahgora-ponto-automation',
        'Accept': 'application/vnd.github+json',
      },
    });

    if (res.status !== 200) {
      logger.warn(`Erro ao ler Gist (status ${res.status}): ${res.data.substring(0, 200)}`);
      return [];
    }

    const gist = JSON.parse(res.data);
    const file = gist.files[GIST_FILENAME];
    if (!file) {
      logger.warn(`Arquivo ${GIST_FILENAME} não encontrado no Gist`);
      return [];
    }

    return JSON.parse(file.content);
  } catch (err) {
    logger.warn(`Falha ao ler Gist: ${err.message}`);
    return [];
  }
}

async function saveDisabledDates(dates) {
  if (!config.gistToken || !config.gistId) return;

  try {
    const body = JSON.stringify({
      files: {
        [GIST_FILENAME]: {
          content: JSON.stringify(dates, null, 2),
        },
      },
    });

    const res = await request({
      hostname: 'api.github.com',
      path: `/gists/${config.gistId}`,
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${config.gistToken}`,
        'User-Agent': 'ahgora-ponto-automation',
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, body);

    if (res.status === 200) {
      logger.info('Gist atualizado com sucesso');
    } else {
      logger.warn(`Erro ao salvar Gist (status ${res.status}): ${res.data.substring(0, 200)}`);
    }
  } catch (err) {
    logger.warn(`Falha ao salvar Gist: ${err.message}`);
  }
}

async function disableDate(dateStr) {
  const dates = await getDisabledDates();
  if (dates.includes(dateStr)) return false;
  dates.push(dateStr);
  dates.sort((a, b) => {
    const [da, ma, ya] = a.split('/');
    const [db, mb, yb] = b.split('/');
    return new Date(`${ya}-${ma}-${da}`) - new Date(`${yb}-${mb}-${db}`);
  });
  await saveDisabledDates(dates);
  return true;
}

async function enableDate(dateStr) {
  const dates = await getDisabledDates();
  const idx = dates.indexOf(dateStr);
  if (idx === -1) return false;
  dates.splice(idx, 1);
  await saveDisabledDates(dates);
  return true;
}

async function isDisabled(dateStr) {
  const dates = await getDisabledDates();
  return dates.includes(dateStr);
}

async function cleanupPastDates() {
  const dates = await getDisabledDates();
  const todayStr = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const [td, tm, ty] = todayStr.split('/');
  const todayISO = `${ty}-${tm}-${td}`;

  const filtered = dates.filter((d) => {
    const [dd, dm, dy] = d.split('/');
    const dISO = `${dy}-${dm}-${dd}`;
    return dISO >= todayISO;
  });

  if (filtered.length !== dates.length) {
    logger.info(`Limpeza: removidas ${dates.length - filtered.length} data(s) passada(s)`);
    await saveDisabledDates(filtered);
  }
}

module.exports = {
  getDisabledDates,
  saveDisabledDates,
  disableDate,
  enableDate,
  isDisabled,
  cleanupPastDates,
};
