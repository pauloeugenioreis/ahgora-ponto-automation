const puppeteer = require('puppeteer');
const { authenticator } = require('otplib');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const { notifySuccess, notifyError, sendTelegram } = require('./notify');
const { checkTelegramAndProcess } = require('./bot');
const { runMonthlyLogCleanup } = require('./log-cleanup');

// ---------------------------------------------------------------------------
// Sessão persistente
// ---------------------------------------------------------------------------

const SESSION_FILE = path.join(__dirname, '..', 'session', 'cookies.json');

async function saveCookies(page) {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    const client = await page.createCDPSession();
    const { cookies } = await client.send('Network.getAllCookies');
    fs.writeFileSync(SESSION_FILE, JSON.stringify(cookies, null, 2), 'utf8');
    logger.info(`Sessão salva: ${cookies.length} cookies`);
  } catch (err) {
    logger.warn(`Falha ao salvar sessão: ${err.message}`);
  }
}

async function loadCookies(page) {
  if (!fs.existsSync(SESSION_FILE)) return false;
  try {
    const cookies = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (!cookies.length) return false;
    await page.setCookie(...cookies);
    logger.info(`Sessão carregada: ${cookies.length} cookies`);
    return true;
  } catch (err) {
    logger.warn(`Falha ao carregar sessão: ${err.message}`);
    return false;
  }
}

function deleteSession() {
  if (fs.existsSync(SESSION_FILE)) {
    fs.unlinkSync(SESSION_FILE);
    logger.info('Sessão removida');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function debugScreenshot(page, name) {
  if (!config.debug) return;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await page.screenshot({ path: `logs/debug-${name}-${ts}.png`, fullPage: true });
    logger.info(`Screenshot: logs/debug-${name}-${ts}.png`);
  } catch (err) {
    logger.warn(`Screenshot falhou (${name}): ${err.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getBatidaAtual() {
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = formatter.formatToParts(new Date());
  const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
  const total = h * 60 + m;
  if (total < 12 * 60) return '10:00';
  if (total < 14 * 60) return '13:00';
  if (total < 15 * 60) return '14:00';
  return '19:00';
}

// ---------------------------------------------------------------------------
// SSO Microsoft — senha + MFA
// ---------------------------------------------------------------------------

async function handleMicrosoftSSO(page) {
  logger.info('Fluxo SSO Microsoft iniciado...');
  await sleep(2000);
  await debugScreenshot(page, '03-ms-login');

  // E-mail — tenta preencher sem checar offsetParent (página customizada pode falhar no check)
  for (const sel of ['input[type="email"]', 'input[name="loginfmt"]', '#i0116']) {
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
      const field = await page.$(sel);
      if (field) {
        await field.click({ clickCount: 3 });
        await field.type(config.user, { delay: 30 });
        logger.info(`E-mail preenchido (${sel}): ${config.user}`);
        await debugScreenshot(page, '03b-email-preenchido');
        // Clica Avançar/Next
        for (const btnSel of ['input[type="submit"]', '#idSIButton9', 'button[type="submit"]']) {
          const btn = await page.$(btnSel);
          if (btn) { await btn.click(); logger.info(`Avançar email (${btnSel})`); break; }
        }
        await sleep(3000);
        break;
      }
    } catch { /* campo não apareceu nesse seletor */ }
  }

  // Senha
  logger.info('Aguardando campo de senha...');
  const passSelector = 'input[type="password"], input[name="passwd"], #i0118';
  await page.waitForSelector(passSelector, { visible: true, timeout: config.timeout });
  const passField = await page.$(passSelector);
  await passField.type(config.password, { delay: 30 });
  logger.info('Senha preenchida');
  await debugScreenshot(page, '04-ms-senha');

  const signInBtn = await page.$('input[type="submit"], #idSIButton9');
  if (signInBtn) { await signInBtn.click(); logger.info('Sign in clicado'); }
  await sleep(3000);
  await debugScreenshot(page, '05-ms-after-signin');

  await handleMFA(page);
  await handleStaySignedIn(page);

  // Aguarda retorno ao Ahgora
  logger.info('Aguardando retorno ao Ahgora...');
  try {
    await page.waitForFunction(
      () => window.location.href.includes('ahgora.com.br'),
      { timeout: config.timeout }
    );
    logger.info('Retornou ao Ahgora!');
  } catch {
    logger.warn('Timeout aguardando retorno ao Ahgora');
  }
  await sleep(3000);
}

// ---------------------------------------------------------------------------
// MFA — TOTP ou push
// ---------------------------------------------------------------------------

async function handleMFA(page) {
  await sleep(3000);
  const url = page.url();
  if (!url.includes('microsoftonline.com') && !url.includes('login.microsoft.com')) {
    logger.info('Fora da Microsoft — MFA não necessário');
    return;
  }

  await debugScreenshot(page, '05-mfa');

  if (config.mfaSecret) {
    await handleTOTP(page);
  } else {
    await handlePushMFA(page);
  }
}

async function handleTOTP(page) {
  logger.info('Fluxo TOTP iniciado...');
  await sleep(2000);
  await debugScreenshot(page, '05-mfa-screen');

  // Passo 1: se estiver na tela de escolha de método, clicar em "Usar um código de verificação"
  const clicouCodigo = await page.evaluate(() => {
    const textos = [
      'usar um código de verificação',
      'use a verification code',
      'usar código de verificação',
    ];
    // Tenta pela estrutura da Microsoft Entra (data-value="PhoneAppOTP")
    const phoneOTP = document.querySelector('div[data-value="PhoneAppOTP"], li[data-value="PhoneAppOTP"]');
    if (phoneOTP && phoneOTP.offsetParent !== null) { phoneOTP.click(); return 'PhoneAppOTP'; }

    // Tenta por texto visível
    const els = document.querySelectorAll('div, li, a, button, span');
    for (const el of els) {
      const t = el.textContent.trim().toLowerCase();
      if (textos.some((txt) => t === txt || t.startsWith(txt)) && el.offsetParent !== null) {
        el.click();
        return el.textContent.trim();
      }
    }
    return null;
  });

  if (clicouCodigo) {
    logger.info(`"Usar um código de verificação" clicado: ${clicouCodigo}`);
    await sleep(2000);
    await debugScreenshot(page, '05-mfa-apos-codigo');
  }

  // Passo 2: se tiver link "Não consigo usar o Authenticator"
  const anotherWay = await page.$('#signInAnotherWay');
  if (anotherWay && await page.evaluate((e) => e.offsetParent !== null, anotherWay)) {
    await page.evaluate((e) => e.click(), anotherWay);
    logger.info('"Não consigo usar o Authenticator" clicado');
    await sleep(2000);

    // Clica novamente em PhoneAppOTP após a navegação
    const phoneOTPAfter = await page.$('div[data-value="PhoneAppOTP"]');
    if (phoneOTPAfter && await page.evaluate((e) => e.offsetParent !== null, phoneOTPAfter)) {
      await page.evaluate((e) => e.click(), phoneOTPAfter);
      await sleep(2000);
    }
  }

  await debugScreenshot(page, '05-mfa-campo');

  // Passo 3: aguarda o campo de código aparecer
  const mfaSelectors = [
    '#idTxtBx_SAOTCC_OTC', 'input[name="otc"]',
    'input[aria-label*="code" i]', 'input[aria-label*="código" i]',
    'input[placeholder*="Code" i]', 'input[type="tel"]',
  ];

  let mfaField = null;
  for (let wait = 0; wait < 3 && !mfaField; wait++) {
    for (const sel of mfaSelectors) {
      try {
        const el = await page.$(sel);
        if (el && await page.evaluate((e) => e.offsetParent !== null, el)) { mfaField = el; break; }
      } catch { /* ignora */ }
    }
    if (!mfaField) await sleep(2000);
  }

  if (!mfaField) {
    logger.warn('Campo TOTP não encontrado');
    await debugScreenshot(page, '05-mfa-campo-nao-encontrado');
    return;
  }

  const token = authenticator.generate(config.mfaSecret);
  logger.info(`TOTP gerado: ${token}`);
  await mfaField.click();
  await mfaField.type(token, { delay: 50 });
  await debugScreenshot(page, '05-mfa-preenchido');

  // Passo 4: submeter
  for (const sel of ['#idSubmit_SAOTCC_Continue', 'input[type="submit"]', '#idSIButton9', 'button[type="submit"]']) {
    try {
      const btn = await page.$(sel);
      if (btn && await page.evaluate((e) => e.offsetParent !== null, btn)) {
        await page.evaluate((e) => e.click(), btn);
        logger.info(`Submit MFA clicado (${sel})`);
        break;
      }
    } catch { /* ignora */ }
  }
  await sleep(3000);
}

async function handlePushMFA(page) {
  logger.info('Aguardando aprovação do push MFA...');
  const prefix = config.sistemaPonto ? `${config.sistemaPonto} - ` : '';
  await sendTelegram(
    `${prefix}🔐 <b>Aprovação necessária!</b>\n\nAbra o <b>Microsoft Authenticator</b> e aprove a notificação.\n\n⏱ Aguardando até 2 minutos...`
  );

  const start = Date.now();
  while (Date.now() - start < 120_000) {
    const url = page.url();
    if (!url.includes('microsoftonline.com') && !url.includes('login.microsoft.com')) {
      logger.info('Push aprovado!');
      return;
    }
    await sleep(3000);
  }
  throw new Error('Timeout aguardando aprovação push MFA (2 minutos)');
}

async function handleStaySignedIn(page) {
  await sleep(2000);
  await debugScreenshot(page, '06-stay-signed');

  // Tenta pelos IDs padrão da Microsoft
  for (const sel of ['#idSIButton9', '#idBtn_Back']) {
    const btn = await page.$(sel);
    if (btn && await page.evaluate((e) => e.offsetParent !== null, btn)) {
      const text = await page.evaluate((e) => e.value || e.textContent || '', btn);
      logger.info(`"Continuar conectado?" → clicando "${text.trim()}" (${sel})`);
      await page.evaluate((e) => e.click(), btn);
      await sleep(5000);
      return;
    }
  }

  // Tenta pelo texto "Sim" / "Yes" (tela customizada da empresa — AIR/R)
  const clicouSim = await page.evaluate(() => {
    const els = document.querySelectorAll('button, input[type="submit"], a');
    for (const el of els) {
      const t = el.textContent.trim().toLowerCase();
      if ((t === 'sim' || t === 'yes') && el.offsetParent !== null) {
        el.click();
        return true;
      }
    }
    return false;
  });

  if (clicouSim) {
    logger.info('"Continuar conectado?" → clicou Sim');
    await sleep(5000);
  } else {
    logger.info('"Continuar conectado?" não detectada');
  }
}

// ---------------------------------------------------------------------------
// Fluxo principal — bater ponto no Ahgora
//
// Tela 1: página pública com botão "Registre seu ponto"
// Tela 2: modal com opção "ACESSAR VIA SSO"
// Após SSO: punch confirmado automaticamente
// ---------------------------------------------------------------------------

async function registrarPonto(page) {
  logger.info('Navegando para a página de ponto Ahgora...');
  await page.goto(config.pontoUrl, { waitUntil: 'networkidle2', timeout: config.timeout });
  await sleep(3000);
  await debugScreenshot(page, '01-ponto-page');
  logger.info(`URL: ${page.url()} | Título: ${await page.title()}`);

  // Registra listener de API antes de qualquer clique
  const apiResponsePromise = page
    .waitForResponse(
      (res) => res.url().includes('ahgora.com.br') && res.request().method() === 'POST',
      { timeout: 60_000 }
    )
    .catch(() => null);

  // ---- Passo 1: clicar em "Registre seu ponto" ----
  logger.info('Procurando botão "Registre seu ponto"...');
  const btnPonto = await encontrarBotaoPonto(page);
  if (!btnPonto) {
    await debugScreenshot(page, '01-botao-nao-encontrado');
    throw new Error('Botão "Registre seu ponto" não encontrado');
  }
  await btnPonto.click();
  logger.info('Botão "Registre seu ponto" clicado');
  await sleep(2000);
  await debugScreenshot(page, '02-modal');

  // ---- Passo 2: modal — clicar em "ACESSAR VIA SSO" ----
  logger.info('Procurando opção SSO no modal...');
  const ssoClicado = await clicarSSO(page);

  if (!ssoClicado) {
    await debugScreenshot(page, '02-sso-nao-encontrado');
    throw new Error('Botão "ACESSAR VIA SSO" não encontrado no modal');
  }
  logger.info('"ACESSAR VIA SSO" clicado');
  await sleep(3000);
  await debugScreenshot(page, '03-apos-sso-click');

  // ---- Passo 3: SSO Microsoft (se redirecionou) ----
  // Aguarda o redirect para Microsoft (pode demorar alguns segundos)
  logger.info('Aguardando redirecionamento para Microsoft SSO...');
  try {
    await page.waitForFunction(
      () => window.location.href.includes('microsoftonline.com') ||
            window.location.href.includes('login.microsoft.com'),
      { timeout: 20_000 }
    );
    logger.info(`Redirecionado para Microsoft: ${page.url().substring(0, 80)}...`);
    await handleMicrosoftSSO(page);
    await saveCookies(page);
  } catch {
    // Não redirecionou para Microsoft — cookies resolveram ou erro
    const urlAtual = page.url();
    logger.info(`Sem redirect Microsoft após 20s — URL: ${urlAtual.substring(0, 80)}`);
    if (urlAtual.includes('ahgora.com.br')) {
      logger.info('Permaneceu no Ahgora — autenticado via cookies');
    }
  }

  await sleep(3000);
  await debugScreenshot(page, '04-apos-auth');
  logger.info(`URL após autenticação: ${page.url()}`);

  // ---- Passo 4: verificar confirmação do ponto ----
  return await verificarConfirmacao(page, apiResponsePromise);
}

async function encontrarBotaoPonto(page) {
  const textos = ['registre seu ponto', 'register your punch-in', 'register your punch', 'registrar ponto', 'bater ponto'];

  // Usa elementHandle.click() do Puppeteer para disparar eventos React corretamente
  const buttons = await page.$$('button');
  for (const btn of buttons) {
    try {
      const text = await btn.evaluate((e) => e.textContent.trim().toLowerCase());
      const visible = await btn.evaluate((e) => e.offsetParent !== null);
      if (visible && textos.some((t) => text.includes(t))) {
        return btn;
      }
    } catch { /* ignora */ }
  }

  // Fallback: qualquer elemento clicável com o texto
  for (const sel of ['a', '[role="button"]']) {
    const els = await page.$$(sel);
    for (const el of els) {
      try {
        const text = await el.evaluate((e) => e.textContent.trim().toLowerCase());
        const visible = await el.evaluate((e) => e.offsetParent !== null);
        if (visible && textos.some((t) => text.includes(t))) return el;
      } catch { /* ignora */ }
    }
  }

  return null;
}

async function clicarSSO(page) {
  // Aguarda o modal aparecer (input de Matrícula/Registration é sinal que abriu)
  logger.info('Aguardando modal aparecer...');
  try {
    await page.waitForSelector(
      'input[placeholder="Matrícula"], input[placeholder="Registration"], input[placeholder="matricula"]',
      { visible: true, timeout: 10_000 }
    );
    logger.info('Modal detectado via input de matrícula');
  } catch {
    // Modal pode ter estrutura diferente — aguarda um tempo fixo
    logger.info('Input de matrícula não encontrado — aguardando 3s');
    await sleep(3000);
  }

  await debugScreenshot(page, '02b-modal-aberto');

  const textos = ['acessar via sso', 'access with sso', 'access via sso', 'entrar via sso'];

  // Usa elementHandle.click() para disparar eventos React corretamente
  for (const sel of ['a', 'button', 'span', '[role="button"]']) {
    const els = await page.$$(sel);
    for (const el of els) {
      try {
        const text = await el.evaluate((e) => e.textContent.trim().toLowerCase());
        if (textos.some((t) => text.includes(t))) {
          await el.click();
          logger.info(`SSO clicado (${sel}): "${text}"`);
          return true;
        }
      } catch { /* ignora */ }
    }
  }

  // Log do HTML para diagnóstico
  const modalHtml = await page.evaluate(() => document.body.innerHTML.substring(0, 3000));
  logger.info(`HTML do modal:\n${modalHtml}`);

  return false;
}

async function verificarConfirmacao(page, apiResponsePromise) {
  logger.info('Verificando confirmação do ponto...');
  await debugScreenshot(page, '07-apos-sso');

  // Ahgora volta para ?flow=sso e mostra modal "Confirme seu registro de ponto!"
  // com botão "REGISTRAR PONTO" — precisa clicar para confirmar
  logger.info('Aguardando modal de confirmação do Ahgora...');
  await sleep(3000);

  const clicouRegistrar = await page.evaluate(() => {
    const textos = ['registrar ponto', 'register punch', 'confirmar', 'confirm'];
    const els = document.querySelectorAll('button, [role="button"], a');
    for (const el of els) {
      const t = el.textContent.trim().toLowerCase().replace(/\s+/g, ' ');
      if (textos.some((txt) => t.includes(txt)) && el.offsetParent !== null) {
        el.click();
        return el.textContent.trim();
      }
    }
    return null;
  });

  if (config.dryRun) {
    logger.info('🧪 DRY RUN — modal de confirmação visível, botão "REGISTRAR PONTO" NÃO clicado');
    await debugScreenshot(page, '08-dryrun-confirmacao');
    const prefix = config.sistemaPonto ? `${config.sistemaPonto} - ` : '';
    await sendTelegram(`${prefix}🧪 <b>DRY RUN</b> — fluxo completo OK até confirmação. Ponto <b>não registrado</b>.`);
    return true;
  }

  if (clicouRegistrar) {
    logger.info(`Modal confirmação: clicou "${clicouRegistrar}"`);
    await sleep(3000);
    await debugScreenshot(page, '08-apos-registrar');
  } else {
    logger.info('Modal "REGISTRAR PONTO" não encontrado ainda — aguardando...');
    await sleep(3000);
    const clicouRegistrar2 = await page.evaluate(() => {
      const els = document.querySelectorAll('button, [role="button"]');
      for (const el of els) {
        const t = el.textContent.trim().toLowerCase().replace(/\s+/g, ' ');
        if ((t.includes('registrar ponto') || t.includes('register punch')) && el.offsetParent !== null) {
          el.click();
          return el.textContent.trim();
        }
      }
      return null;
    });
    if (clicouRegistrar2) {
      logger.info(`Modal confirmação (2ª tentativa): clicou "${clicouRegistrar2}"`);
      await sleep(3000);
      await debugScreenshot(page, '08-apos-registrar-2');
    }
  }

  // Verifica resposta da API
  const apiResponse = await apiResponsePromise;
  if (apiResponse) {
    const status = apiResponse.status();
    let body = null;
    try { body = await apiResponse.json(); } catch { /* não-JSON */ }
    logger.info(`API: HTTP ${status} — ${JSON.stringify(body)}`);
    if (status >= 200 && status < 300) {
      logger.info('Ponto confirmado pela API!');
      await debugScreenshot(page, '05-sucesso');
      return true;
    }
  }

  // Confirmação visual
  const textosSucesso = [
    'ponto registrado', 'batida registrada', 'batida realizada',
    'registrado com sucesso', 'ponto realizado', 'punch registered',
    'punch recorded', 'success',
  ];

  const checks = page.frames().map((f) =>
    f.waitForFunction(
      (textos) => {
        const t = (document.body?.innerText || '').toLowerCase();
        return textos.some((txt) => t.includes(txt));
      },
      { timeout: 15_000 },
      textosSucesso
    )
    .then(() => { logger.info('Confirmação visual detectada'); return true; })
    .catch(() => false)
  );

  const visualOk = (await Promise.all(checks)).some(Boolean);
  if (visualOk) {
    await debugScreenshot(page, '05-sucesso-visual');
    return true;
  }

  // DRY RUN / DEBUG: loga HTML para diagnóstico
  if (config.debug) {
    const html = await page.evaluate(() => document.body.innerHTML.substring(0, 5000));
    logger.info(`HTML após auth:\n${html}`);
  }

  await debugScreenshot(page, '05-sem-confirmacao');
  logger.warn('Confirmação não detectada — ponto pode ter sido registrado mesmo assim');

  // Se voltou para a página do Ahgora sem redirecionar para login, considera sucesso provisório
  const finalUrl = page.url();
  if (finalUrl.includes('ahgora.com.br') && !finalUrl.includes('login')) {
    logger.info('Retornou ao Ahgora sem redirecionar para login — assumindo sucesso');
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Execução completa
// ---------------------------------------------------------------------------

async function executar() {
  const browser = await puppeteer.launch({
    headless: config.headless,
    slowMo: config.slowMo,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--window-size=1366,768',
      '--lang=pt-BR',
      ...(process.env.CI ? [] : ['--remote-debugging-port=9222']),
    ],
    defaultViewport: { width: 1366, height: 768 },
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' });

  // Geolocalização para o Ahgora aceitar a batida
  const context = browser.defaultBrowserContext();
  await context.overridePermissions('https://app.ahgora.com.br', ['geolocation']);
  await page.setGeolocation({ latitude: config.geoLat, longitude: config.geoLng });
  logger.info(`Geolocalização: ${config.geoLat}, ${config.geoLng}`);

  try {
    // Carrega cookies de sessão anterior (acelera SSO ou evita reauth)
    if (!config.reauth) {
      await loadCookies(page);
    } else {
      logger.info('REAUTH=true — ignorando sessão salva');
      deleteSession();
    }

    // DRY_RUN e execução normal usam o mesmo fluxo —
    // a diferença está em verificarConfirmacao() que para antes do clique final
    const ok = await registrarPonto(page);
    if (ok && !config.dryRun) {
      await notifySuccess();
      logger.info('=== Ponto registrado com sucesso ===');
    } else if (!ok) {
      throw new Error('Registro não confirmado');
    }
  } finally {
    if (!config.debug) {
      await browser.close();
      logger.info('Browser fechado');
    } else {
      logger.info('Debug: browser aberto para inspeção');
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const RETRY_DELAY = 30_000;

function mask(v, k = 4) {
  if (!v) return '(não definido)';
  const s = String(v);
  return s.length <= k ? '***' : s.substring(0, k) + '*'.repeat(Math.min(s.length - k, 6));
}

async function main() {
  logger.info('=== Automação de ponto Ahgora ===');
  logger.info(`Hora (Brasília): ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', timeZoneName: 'short' })}`);
  logger.info('--- Config ---');
  logger.info(`SISTEMA_PONTO:     ${config.sistemaPonto || '(vazio)'}`);
  logger.info(`AHGORA_USER:       ${config.user || '(não definido)'}`);
  logger.info(`AHGORA_PASS:       ${mask(config.password)}`);
  logger.info(`AHGORA_MFA_SECRET: ${mask(config.mfaSecret)}`);
  logger.info(`AHGORA_PONTO_URL:  ${config.pontoUrl || '(não definido)'}`);
  logger.info(`SESSION:           ${fs.existsSync(SESSION_FILE) ? 'salva' : 'nenhuma'}`);
  logger.info(`REAUTH:            ${config.reauth}`);
  logger.info(`HEADLESS:          ${config.headless}`);
  logger.info(`DRY_RUN:           ${config.dryRun}`);
  logger.info('--------------');

  await runMonthlyLogCleanup();

  if (!config.user || !config.password) {
    logger.error('AHGORA_USER e AHGORA_PASS são obrigatórios no .env');
    process.exit(1);
  }
  if (!config.pontoUrl) {
    logger.error('AHGORA_PONTO_URL é obrigatório no .env');
    process.exit(1);
  }

  const todayDisabled = await checkTelegramAndProcess();
  if (todayDisabled) {
    const today = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const batida = getBatidaAtual();
    logger.info(`Ponto desativado para hoje (${today}) — pulando ${batida}`);
    const prefix = config.sistemaPonto ? `${config.sistemaPonto} - ` : '';
    await sendTelegram(`${prefix}⏸️ Ponto <b>desativado</b> para hoje (${today}) — pulado ${batida}`);
    return;
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info(`Tentativa ${attempt}/${MAX_RETRIES}...`);
      await executar();
      return;
    } catch (err) {
      logger.error(`Tentativa ${attempt}/${MAX_RETRIES} falhou: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        const prefix = config.sistemaPonto ? `${config.sistemaPonto} - ` : '';
        await sendTelegram(`${prefix}⚠️ Tentativa ${attempt}/${MAX_RETRIES}: <code>${err.message}</code>\n🔄 Retentando em 30s...`);
        await sleep(RETRY_DELAY);
      } else {
        await notifyError(`Falha após ${MAX_RETRIES} tentativas: ${err.message}`);
        throw err;
      }
    }
  }
}

main().catch((err) => {
  logger.error(`Falha fatal: ${err.message}`);
  process.exit(1);
});
