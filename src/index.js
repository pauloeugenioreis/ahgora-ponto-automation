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
    // Pega todos os cookies de todos os domínios visitados
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

async function isSessionValid(page) {
  logger.info('Verificando validade da sessão...');
  try {
    await page.goto(config.pontoUrl, { waitUntil: 'networkidle2', timeout: config.timeout });
    await sleep(3000);
    const url = page.url();
    logger.info(`URL após carregar sessão: ${url}`);

    const expired = (
      url.includes('microsoftonline.com') ||
      url.includes('login.microsoft.com') ||
      url.includes('/login') ||
      url.includes('/signin')
    );

    if (expired) {
      logger.info('Sessão expirada — redirecionou para login');
      return false;
    }

    logger.info('Sessão válida!');
    return true;
  } catch (err) {
    logger.warn(`Erro ao verificar sessão: ${err.message}`);
    return false;
  }
}

function deleteSession() {
  if (fs.existsSync(SESSION_FILE)) {
    fs.unlinkSync(SESSION_FILE);
    logger.info('Arquivo de sessão removido');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitAndGet(page, selector, label = selector) {
  logger.info(`Aguardando "${label}" (${selector})...`);
  await page.waitForSelector(selector, { visible: true, timeout: config.timeout });
  return page.$(selector);
}

async function debugScreenshot(page, name) {
  if (!config.debug) return;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = `logs/debug-${name}-${ts}.png`;
    await page.screenshot({ path: filePath, fullPage: true });
    logger.info(`Screenshot salva: ${filePath}`);
  } catch (err) {
    logger.warn(`Screenshot falhou (${name}): ${err.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getBatidaAtual() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const minute = parseInt(parts.find(p => p.type === 'minute').value, 10);
  const totalMinutes = hour * 60 + minute;
  if (totalMinutes < 12 * 60) return '10:00';
  if (totalMinutes < 14 * 60) return '13:00';
  if (totalMinutes < 15 * 60) return '14:00';
  return '19:00';
}

// ---------------------------------------------------------------------------
// Login Ahgora → SSO Microsoft
// ---------------------------------------------------------------------------

async function login(page) {
  logger.info('Navegando para a página de login Ahgora...');
  await page.goto(config.loginUrl, { waitUntil: 'networkidle2', timeout: config.timeout });
  await debugScreenshot(page, '01-login-page');

  const currentUrl = page.url();
  logger.info(`URL após navegação: ${currentUrl}`);

  if (currentUrl.includes('microsoftonline.com') || currentUrl.includes('login.microsoft.com')) {
    logger.info('Redirecionado diretamente para Microsoft SSO');
    await handleMicrosoftSSO(page);
    return;
  }

  await handleAhgoraLogin(page);
  await debugScreenshot(page, '06-login-complete');
}

async function handleAhgoraLogin(page) {
  logger.info('Tentando login no Ahgora...');
  await debugScreenshot(page, '02-ahgora-login');

  const emailSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input[id*="email"]',
    'input[placeholder*="e-mail"]',
    'input[placeholder*="Email"]',
    'input[placeholder*="email"]',
  ];

  let emailField = null;
  for (const sel of emailSelectors) {
    emailField = await page.$(sel);
    if (emailField) {
      const visible = await page.evaluate((el) => el.offsetParent !== null, emailField);
      if (visible) {
        logger.info(`Campo de e-mail encontrado: ${sel}`);
        break;
      }
      emailField = null;
    }
  }

  if (emailField) {
    await emailField.click({ clickCount: 3 });
    await emailField.type(config.user, { delay: 30 });
    logger.info(`E-mail preenchido: ${config.user}`);
    await debugScreenshot(page, '03-email-filled');

    const nextSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:not([type="button"])',
      '[class*="next"]',
      '[class*="submit"]',
      '[class*="entrar"]',
      '[class*="login"]',
    ];

    for (const sel of nextSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          const visible = await page.evaluate((el) => el.offsetParent !== null, btn);
          if (visible) {
            await btn.click();
            logger.info(`Botão de submit clicado: ${sel}`);
            await sleep(2000);
            break;
          }
        }
      } catch { /* ignora */ }
    }
  }

  // Botão "Entrar com Microsoft"
  await sleep(1500);
  const msButtonResult = await page.evaluate(() => {
    const candidates = document.querySelectorAll('button, a, [role="button"]');
    for (const el of candidates) {
      const text = el.textContent.trim().toLowerCase();
      if (text.includes('microsoft') || text.includes('azure') || text.includes('sso')) {
        if (el.offsetParent !== null) {
          el.click();
          return el.textContent.trim();
        }
      }
    }
    return null;
  });

  if (msButtonResult) {
    logger.info(`Botão Microsoft clicado: "${msButtonResult}"`);
  }

  await sleep(3000);

  const urlAfter = page.url();
  logger.info(`URL após tentativa de login: ${urlAfter}`);

  if (urlAfter.includes('microsoftonline.com') || urlAfter.includes('login.microsoft.com')) {
    await handleMicrosoftSSO(page);
  } else {
    try {
      await page.waitForFunction(
        () => window.location.href.includes('microsoftonline.com') ||
              window.location.href.includes('login.microsoft.com'),
        { timeout: 15_000 }
      );
      await handleMicrosoftSSO(page);
    } catch {
      logger.warn('Não redirecionou para Microsoft SSO');
      await debugScreenshot(page, '05-sso-timeout');
    }
  }
}

// ---------------------------------------------------------------------------
// SSO Microsoft — Senha + Push MFA
// ---------------------------------------------------------------------------

async function handleMicrosoftSSO(page) {
  logger.info('Entrando no fluxo SSO Microsoft...');

  const msEmailField = await page.$('input[type="email"], input[name="loginfmt"]');
  if (msEmailField) {
    const needsEmail = await page.evaluate((el) => el.offsetParent !== null, msEmailField);
    if (needsEmail) {
      logger.info('Microsoft pediu e-mail, preenchendo...');
      await msEmailField.click({ clickCount: 3 });
      await msEmailField.type(config.user, { delay: 30 });
      const nextBtn = await page.$('input[type="submit"], #idSIButton9');
      if (nextBtn) {
        await nextBtn.click();
        await sleep(2000);
      }
    }
  }

  await debugScreenshot(page, '04-ms-email');

  logger.info('Aguardando campo de senha Microsoft...');
  const passSelector = 'input[type="password"], input[name="passwd"], #i0118';
  await page.waitForSelector(passSelector, { visible: true, timeout: config.timeout });
  const passField = await page.$(passSelector);
  await passField.type(config.password, { delay: 30 });
  logger.info('Senha preenchida');

  const signInBtn = await page.$('input[type="submit"], #idSIButton9');
  if (signInBtn) {
    await signInBtn.click();
    logger.info('Botão "Sign in" clicado');
  }
  await sleep(3000);
  await debugScreenshot(page, '05-ms-after-signin');

  await handleMFA(page);
  await handleStaySignedIn(page);

  logger.info('Aguardando redirecionamento de volta ao Ahgora...');
  try {
    await page.waitForFunction(
      () => window.location.href.includes('ahgora.com.br'),
      { timeout: config.timeout }
    );
    logger.info('Redirecionado para o Ahgora com sucesso!');
  } catch {
    logger.warn('Timeout aguardando redirecionamento ao Ahgora');
  }
  await sleep(3000);
}

// ---------------------------------------------------------------------------
// MFA — tenta TOTP se configurado, senão aguarda push do usuário
// ---------------------------------------------------------------------------

async function handleMFA(page) {
  await sleep(3000);

  const currentUrl = page.url();
  if (!currentUrl.includes('microsoftonline.com') && !currentUrl.includes('login.microsoft.com')) {
    logger.info('Já saiu da Microsoft — MFA não necessário');
    return;
  }

  await debugScreenshot(page, '05-ms-mfa-page');

  // Se tiver TOTP configurado, tenta usá-lo
  if (config.mfaSecret) {
    logger.info('TOTP configurado — tentando MFA por código');
    await handleMicrosoftMFA(page);
    return;
  }

  // Sem TOTP: aguarda aprovação do push pelo usuário
  await handlePushMFA(page);
}

async function handlePushMFA(page) {
  logger.info('Aguardando aprovação do push MFA pelo usuário...');
  const prefix = config.sistemaPonto ? `${config.sistemaPonto} - ` : '';
  await sendTelegram(
    `${prefix}🔐 <b>Aprovação de login necessária!</b>\n\n` +
    `Abra o <b>Microsoft Authenticator</b> no celular e aprove a notificação de login.\n\n` +
    `⏱ Aguardando até 2 minutos...`
  );

  // Aguarda até 2 minutos para o usuário aprovar o push
  const PUSH_TIMEOUT = 120_000;
  const start = Date.now();

  while (Date.now() - start < PUSH_TIMEOUT) {
    const url = page.url();
    if (!url.includes('microsoftonline.com') && !url.includes('login.microsoft.com')) {
      logger.info('Push aprovado! Redirecionou para fora da Microsoft.');
      return;
    }

    // Detecta se a tela atual é a de push (número de aprovação) e aguarda
    const isOnPushScreen = await page.evaluate(() => {
      const text = document.body?.innerText?.toLowerCase() || '';
      return (
        text.includes('approve') ||
        text.includes('aprovar') ||
        text.includes('authenticator') ||
        text.includes('notification')
      );
    }).catch(() => false);

    if (isOnPushScreen) {
      logger.info(`Aguardando aprovação do push... (${Math.round((Date.now() - start) / 1000)}s)`);
    }

    await sleep(3000);
  }

  // Timeout: verifica se já foi redirecionado mesmo assim
  const finalUrl = page.url();
  if (!finalUrl.includes('microsoftonline.com') && !finalUrl.includes('login.microsoft.com')) {
    logger.info('Push aprovado após timeout de verificação');
    return;
  }

  throw new Error('Timeout aguardando aprovação do push MFA (2 minutos)');
}

async function handleMicrosoftMFA(page) {
  let foundCodeField = false;

  for (let attempt = 1; attempt <= 3 && !foundCodeField; attempt++) {
    logger.info(`Tentativa ${attempt} de chegar ao campo TOTP...`);

    const codeField = await page.$('#idTxtBx_SAOTCC_OTC');
    if (codeField) {
      const visible = await page.evaluate((el) => el.offsetParent !== null, codeField);
      if (visible) { foundCodeField = true; break; }
    }

    const signInAnotherWay = await page.$('#signInAnotherWay');
    if (signInAnotherWay) {
      const visible = await page.evaluate((el) => el.offsetParent !== null, signInAnotherWay);
      if (visible) {
        await page.evaluate((el) => el.click(), signInAnotherWay);
        logger.info('Clicou em "Não consigo usar meu Authenticator"');
        await sleep(3000);
        continue;
      }
    }

    const phoneAppOTP = await page.$('div[data-value="PhoneAppOTP"]');
    if (phoneAppOTP) {
      const visible = await page.evaluate((el) => el.offsetParent !== null, phoneAppOTP);
      if (visible) {
        await page.evaluate((el) => el.click(), phoneAppOTP);
        logger.info('Clicou em PhoneAppOTP');
        await sleep(3000);
        continue;
      }
    }

    await sleep(2000);
  }

  const mfaSelectors = [
    '#idTxtBx_SAOTCC_OTC',
    'input[name="otc"]',
    'input[aria-label*="code"]',
    'input[aria-label*="código"]',
    'input[placeholder*="Code"]',
    'input[type="tel"]',
  ];

  let mfaField = null;
  let mfaSel = '';
  for (const sel of mfaSelectors) {
    try {
      mfaField = await page.$(sel);
      if (mfaField) {
        const visible = await page.evaluate((el) => el.offsetParent !== null, mfaField);
        if (visible) { mfaSel = sel; break; }
        mfaField = null;
      }
    } catch { /* ignora */ }
  }

  if (!mfaField) {
    logger.error('Campo de código MFA não encontrado — caindo para push');
    await handlePushMFA(page);
    return;
  }

  logger.info(`Campo MFA encontrado: ${mfaSel}`);
  const token = authenticator.generate(config.mfaSecret);
  logger.info(`Código TOTP gerado: ${token}`);

  await mfaField.click();
  await mfaField.type(token, { delay: 50 });

  const verifySelectors = [
    '#idSubmit_SAOTCC_Continue',
    'input[type="submit"]',
    '#idSIButton9',
    'button[type="submit"]',
  ];

  for (const sel of verifySelectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        const visible = await page.evaluate((el) => el.offsetParent !== null, btn);
        if (visible) {
          await page.evaluate((el) => el.click(), btn);
          logger.info(`Botão "Verify" clicado (${sel})`);
          break;
        }
      }
    } catch { /* ignora */ }
  }

  await sleep(3000);
}

// ---------------------------------------------------------------------------
// "Stay signed in?" / "Permanecer conectado?"
// ---------------------------------------------------------------------------

async function handleStaySignedIn(page) {
  await sleep(2000);

  const selectors = ['#idSIButton9', '#idBtn_Back'];
  for (const sel of selectors) {
    const btn = await page.$(sel);
    if (btn) {
      const visible = await page.evaluate((el) => el.offsetParent !== null, btn);
      if (visible) {
        const text = await page.evaluate((el) => el.value || el.textContent || '', btn);
        logger.info(`Tela "Permanecer conectado?" — clicando "${text.trim()}" (${sel})`);
        await page.evaluate((el) => el.click(), btn);
        await sleep(5000);
        return;
      }
    }
  }
  logger.info('Tela "Permanecer conectado?" não detectada');
}

// ---------------------------------------------------------------------------
// Registrar ponto no Ahgora
// ---------------------------------------------------------------------------

async function registrarPonto(page) {
  logger.info('Navegando para a página de ponto Ahgora...');
  await page.goto(config.pontoUrl, { waitUntil: 'networkidle2', timeout: config.timeout });
  await sleep(5000);
  await debugScreenshot(page, '08-ponto-page');

  const currentUrl = page.url();
  logger.info(`URL atual: ${currentUrl}`);

  // Se redirecionou para login, sessão expirou durante navegação
  if (currentUrl.includes('microsoftonline.com') || currentUrl.includes('/login')) {
    throw new Error('Sessão expirou ao navegar para página de ponto');
  }

  const apiResponsePromise = page
    .waitForResponse(
      (res) => {
        const url = res.url();
        return (
          url.includes('ahgora.com.br') &&
          (url.includes('/batida') || url.includes('/punch') || url.includes('/clocking') ||
           url.includes('/registro') || url.includes('/api/'))
        );
      },
      { timeout: 25_000 }
    )
    .catch(() => null);

  const estrategias = [
    // 1. Texto do botão
    async (ctx) => {
      const buttons = await ctx.$$('button, [role="button"]');
      logger.info(`  Botões encontrados: ${buttons.length}`);
      for (const btn of buttons) {
        const text = await ctx.evaluate((el) => el.textContent.trim(), btn);
        if (text && (
          text.toLowerCase().includes('bater') ||
          text.toLowerCase().includes('registrar') ||
          text.toLowerCase().includes('marcar') ||
          text.toLowerCase().includes('confirmar') ||
          text.toLowerCase().includes('ponto')
        )) {
          const visible = await ctx.evaluate((el) => el.offsetParent !== null, btn);
          if (visible) {
            await ctx.evaluate((el) => el.click(), btn);
            logger.info(`Ponto registrado via botão: "${text}"`);
            return true;
          }
        }
      }
      return false;
    },

    // 2. Seletores específicos do Ahgora
    async (ctx) => {
      const selectors = [
        '.batida-btn', '.btn-batida', '.punch-button', '.register-button',
        '[class*="batida"]', '[class*="punch"]', '[class*="bater"]',
        '[data-testid*="batida"]', '[data-testid*="punch"]',
        'button.primary', 'button.mat-raised-button', 'button.mat-flat-button',
        '.fab-button', 'ion-button',
      ];
      for (const sel of selectors) {
        try {
          const btn = await ctx.$(sel);
          if (btn) {
            const visible = await ctx.evaluate((el) => el.offsetParent !== null, btn);
            if (visible) {
              await ctx.evaluate((el) => el.click(), btn);
              logger.info(`Ponto registrado via seletor: ${sel}`);
              return true;
            }
          }
        } catch { /* ignora */ }
      }
      return false;
    },

    // 3. Evaluate geral
    async (ctx) => {
      const result = await ctx.evaluate(() => {
        const all = document.querySelectorAll('button, a, span, div, [role="button"], ion-button');
        for (const el of all) {
          const text = el.textContent.trim().toLowerCase();
          if (
            (text.includes('bater') || text.includes('registrar ponto') ||
             text.includes('marcar ponto') || text === 'ponto') &&
            el.offsetParent !== null
          ) {
            el.click();
            return el.textContent.trim();
          }
        }
        return null;
      });
      if (result) {
        logger.info(`Ponto registrado via evaluate: "${result}"`);
        return true;
      }
      return false;
    },
  ];

  const frames = [page, ...page.frames().filter(f => f !== page.mainFrame())];
  logger.info(`Frames encontrados: ${frames.length}`);

  for (const target of frames) {
    const targetName = target === page ? 'página principal' : target.url();
    logger.info(`Tentando em: ${targetName}`);

    for (const estrategia of estrategias) {
      try {
        const ok = await estrategia(target);
        if (ok) {
          logger.info('Clique realizado — aguardando resposta da API...');
          const apiResponse = await apiResponsePromise;

          if (apiResponse) {
            const status = apiResponse.status();
            let body = null;
            try { body = await apiResponse.json(); } catch { /* não-JSON */ }
            logger.info(`Resposta da API: HTTP ${status} — ${JSON.stringify(body)}`);

            if (status >= 200 && status < 300) {
              logger.info('Ponto confirmado pela API');
              await debugScreenshot(page, '09-ponto-registrado');
              return true;
            }
            logger.warn(`API retornou status ${status}`);
            await debugScreenshot(page, '09-ponto-api-falhou');
            return false;
          }

          // Fallback: confirmação visual
          logger.warn('Timeout na API — verificando confirmação visual...');
          const confirmFn = () => {
            const text = (document.body?.innerText || '').toLowerCase();
            return (
              text.includes('batida registrada') || text.includes('ponto registrado') ||
              text.includes('registrado com sucesso') || text.includes('batida realizada') ||
              text.includes('marcação realizada') || text.includes('batida confirmada')
            );
          };

          const checks = page.frames().map((f) =>
            f.waitForFunction(confirmFn, { timeout: 10_000 })
              .then(() => { logger.info(`Confirmação visual em: ${f === page.mainFrame() ? 'principal' : f.url()}`); return true; })
              .catch(() => false)
          );

          if ((await Promise.all(checks)).some(Boolean)) {
            await debugScreenshot(page, '09-ponto-registrado');
            return true;
          }

          logger.warn('Confirmação não detectada');
          await debugScreenshot(page, '09-ponto-nao-confirmado');
          return false;
        }
      } catch (err) {
        logger.warn(`Estratégia falhou em ${targetName}: ${err.message}`);
      }
    }
  }

  // Diagnóstico
  try {
    const html = await page.evaluate(() => document.body.innerHTML.substring(0, 5000));
    logger.info(`HTML da página:\n${html}`);
  } catch { /* ignora */ }

  await debugScreenshot(page, '09-ponto-NAO-encontrado');
  logger.error('Botão de registrar ponto não encontrado. Use DRY_RUN=true DEBUG=true para inspecionar.');
  return false;
}

// ---------------------------------------------------------------------------
// Fluxo principal com gestão de sessão
// ---------------------------------------------------------------------------

async function executar() {
  const browser = await puppeteer.launch({
    headless: config.headless,
    slowMo: config.slowMo,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1366,768',
      ...(process.env.CI ? [] : ['--remote-debugging-port=9222']),
    ],
    defaultViewport: { width: 1366, height: 768 },
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  const context = browser.defaultBrowserContext();
  await context.overridePermissions('https://app.ahgora.com.br', ['geolocation']);
  await page.setGeolocation({ latitude: config.geoLat, longitude: config.geoLng });
  logger.info(`Geolocalização: ${config.geoLat}, ${config.geoLng}`);

  try {
    let sessionUsed = false;

    if (!config.reauth) {
      const loaded = await loadCookies(page);
      if (loaded) {
        sessionUsed = await isSessionValid(page);
        if (!sessionUsed) {
          logger.info('Sessão inválida — iniciando login completo');
          deleteSession();
          const prefix = config.sistemaPonto ? `${config.sistemaPonto} - ` : '';
          await sendTelegram(
            `${prefix}🔄 Sessão expirada — fazendo novo login.\n` +
            `Aguarde a notificação push no <b>Microsoft Authenticator</b>.`
          );
        }
      }
    } else {
      logger.info('REAUTH=true — forçando novo login');
      deleteSession();
    }

    if (!sessionUsed) {
      // Browser precisa estar visível para o usuário aprovar o push
      if (!config.mfaSecret) {
        logger.info('Sem TOTP configurado — login requer aprovação manual do push');
        logger.info('ATENÇÃO: se em modo headless, o usuário precisa aprovar no celular');
      }
      await login(page);
      await saveCookies(page);
    }

    if (config.dryRun) {
      logger.info('🧪 DRY RUN — navegando para ponto sem clicar...');
      await page.goto(config.pontoUrl, { waitUntil: 'networkidle2', timeout: config.timeout });
      await sleep(5000);
      await debugScreenshot(page, '08-ponto-page-dryrun');
      logger.info(`URL do ponto: ${page.url()}`);

      if (config.debug) {
        const buttons = await page.evaluate(() => {
          const btns = document.querySelectorAll('button, [role="button"], a, input[type="button"]');
          return [...btns].map((el) => ({
            tag: el.tagName,
            id: el.id || '',
            class: (el.className || '').toString().substring(0, 100),
            text: el.textContent.trim().substring(0, 80),
            visible: el.offsetParent !== null,
            ariaLabel: el.getAttribute('aria-label') || '',
          }));
        });
        logger.info('Botões na página:');
        buttons.forEach((b) => logger.info(`  [${b.visible ? 'VISÍVEL' : 'oculto'}] <${b.tag}> id="${b.id}" text="${b.text}"`));

        const html = await page.evaluate(() => document.body.innerHTML.substring(0, 8000));
        logger.info(`HTML:\n${html}`);
      }

      const prefix = config.sistemaPonto ? `${config.sistemaPonto} - ` : '';
      await sendTelegram(`${prefix}🧪 <b>DRY RUN</b> — Login OK. Botão de ponto <b>não clicado</b>.`);
      logger.info('=== DRY RUN concluído ===');
    } else {
      const pontoOk = await registrarPonto(page);
      if (pontoOk) {
        await notifySuccess();
        logger.info('=== Automação concluída com sucesso ===');
      } else {
        throw new Error('Registro de ponto falhou — sem confirmação');
      }
    }
  } finally {
    if (!config.debug) {
      await browser.close();
      logger.info('Browser fechado');
    } else {
      logger.info('Modo debug: browser permanece aberto');
    }
  }
}

// ---------------------------------------------------------------------------
// Main — retry automático
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const RETRY_DELAY = 30_000;

function mask(value, keep = 4) {
  if (!value) return '(não definido)';
  const s = String(value);
  if (s.length <= keep) return '***';
  return s.substring(0, keep) + '*'.repeat(Math.min(s.length - keep, 6));
}

async function main() {
  logger.info('=== Iniciando automação de ponto Ahgora ===');

  const horaBrasilia = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', timeZoneName: 'short' });
  logger.info(`Hora atual (Brasília): ${horaBrasilia}`);

  logger.info('--- Configuração ---');
  logger.info(`SISTEMA_PONTO:    ${config.sistemaPonto || '(vazio)'}`);
  logger.info(`AHGORA_USER:      ${config.user || '(não definido)'}`);
  logger.info(`AHGORA_PASS:      ${mask(config.password)}`);
  logger.info(`AHGORA_MFA_SECRET:${mask(config.mfaSecret)}`);
  logger.info(`AHGORA_LOGIN_URL: ${config.loginUrl || '(não definido)'}`);
  logger.info(`AHGORA_PONTO_URL: ${config.pontoUrl || '(não definido)'}`);
  logger.info(`SESSION_FILE:     ${fs.existsSync(SESSION_FILE) ? 'existe' : 'não existe'}`);
  logger.info(`REAUTH:           ${config.reauth}`);
  logger.info(`HEADLESS:         ${config.headless}`);
  logger.info(`DEBUG:            ${config.debug}`);
  logger.info(`DRY_RUN:          ${config.dryRun}`);
  logger.info('--------------------');

  await runMonthlyLogCleanup();

  if (!config.user || !config.password) {
    logger.error('AHGORA_USER e AHGORA_PASS devem estar definidos no .env');
    process.exit(1);
  }

  if (!config.loginUrl || !config.pontoUrl) {
    logger.error('AHGORA_LOGIN_URL e AHGORA_PONTO_URL devem estar definidos no .env');
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
        await sendTelegram(
          `${prefix}⚠️ Tentativa ${attempt}/${MAX_RETRIES} falhou: <code>${err.message}</code>\n🔄 Retentando em 30s...`
        );
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
