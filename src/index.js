const puppeteer = require('puppeteer');
const { authenticator } = require('otplib');
const config = require('./config');
const logger = require('./logger');
const { notifySuccess, notifyError, sendTelegram } = require('./notify');
const { checkTelegramAndProcess } = require('./bot');
const { runMonthlyLogCleanup } = require('./log-cleanup');

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
    const path = `logs/debug-${name}-${ts}.png`;
    await page.screenshot({ path, fullPage: true });
    logger.info(`Screenshot salva: ${path}`);
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
// Etapa 1 — Login Ahgora → SSO Microsoft (Azure AD)
//   Ahgora (e-mail → botão Microsoft) → login.microsoftonline.com
//   → senha Microsoft → MFA → redireciona de volta ao Ahgora
// ---------------------------------------------------------------------------

async function login(page) {
  logger.info('Navegando para a página de login Ahgora...');
  await page.goto(config.loginUrl, { waitUntil: 'networkidle2', timeout: config.timeout });
  await debugScreenshot(page, '01-login-page');

  const currentUrl = page.url();
  logger.info(`URL após navegação: ${currentUrl}`);

  // Se já redirecionou direto para Microsoft SSO
  if (currentUrl.includes('microsoftonline.com') || currentUrl.includes('login.microsoft.com')) {
    logger.info('Redirecionado diretamente para Microsoft SSO');
    await handleMicrosoftSSO(page);
    return;
  }

  // Tenta login via e-mail no Ahgora (campo de e-mail → submeter → botão Microsoft)
  await handleAhgoraLogin(page);

  await debugScreenshot(page, '06-login-complete');
}

// ---------------------------------------------------------------------------
// Login Ahgora — preenche e-mail e aciona SSO Microsoft
// ---------------------------------------------------------------------------

async function handleAhgoraLogin(page) {
  logger.info('Tentando login no Ahgora...');
  await debugScreenshot(page, '02-ahgora-login');

  // Estratégia 1: Campo de e-mail + botão de submit/next
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

    // Tenta clicar em botão de próximo/submit
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
            await debugScreenshot(page, '04-after-submit');
            break;
          }
        }
      } catch { /* ignora */ }
    }
  }

  // Estratégia 2: Botão "Entrar com Microsoft" / "Login com Microsoft"
  await sleep(1500);
  const msButtonResult = await page.evaluate(() => {
    const candidates = document.querySelectorAll('button, a, [role="button"]');
    for (const el of candidates) {
      const text = el.textContent.trim().toLowerCase();
      if (
        text.includes('microsoft') ||
        text.includes('azure') ||
        text.includes('office 365') ||
        text.includes('sso')
      ) {
        const visible = el.offsetParent !== null;
        if (visible) {
          el.click();
          return el.textContent.trim();
        }
      }
    }
    return null;
  });

  if (msButtonResult) {
    logger.info(`Botão Microsoft clicado: "${msButtonResult}"`);
  } else {
    logger.info('Botão Microsoft não encontrado — aguardando redirecionamento automático');
  }

  await sleep(3000);
  await debugScreenshot(page, '05-before-sso');

  const urlAfter = page.url();
  logger.info(`URL após tentativa de login: ${urlAfter}`);

  if (urlAfter.includes('microsoftonline.com') || urlAfter.includes('login.microsoft.com')) {
    await handleMicrosoftSSO(page);
  } else {
    // Aguarda navegação para Microsoft (pode ser redirect via JS)
    try {
      await page.waitForFunction(
        () => window.location.href.includes('microsoftonline.com') ||
              window.location.href.includes('login.microsoft.com'),
        { timeout: 15_000 }
      );
      await handleMicrosoftSSO(page);
    } catch {
      logger.warn('Não redirecionou para Microsoft SSO — verificando estado atual');
      await debugScreenshot(page, '05-sso-timeout');
    }
  }
}

// ---------------------------------------------------------------------------
// SSO Microsoft — Senha + MFA
// ---------------------------------------------------------------------------

async function handleMicrosoftSSO(page) {
  logger.info('Entrando no fluxo SSO Microsoft...');

  // Microsoft pode pedir o e-mail novamente
  const msEmailField = await page.$('input[type="email"], input[name="loginfmt"]');
  if (msEmailField) {
    const needsEmail = await page.evaluate((el) => el.offsetParent !== null, msEmailField);
    if (needsEmail) {
      logger.info('Microsoft pediu e-mail novamente, preenchendo...');
      await msEmailField.click({ clickCount: 3 });
      await msEmailField.type(config.user, { delay: 30 });

      const nextBtn = await page.$('input[type="submit"], #idSIButton9');
      if (nextBtn) {
        await nextBtn.click();
        logger.info('Botão "Next" Microsoft clicado');
        await sleep(2000);
      }
    }
  }

  await debugScreenshot(page, '04-ms-email');

  // Campo de senha Microsoft
  logger.info('Aguardando campo de senha Microsoft...');
  const passSelector = 'input[type="password"], input[name="passwd"], #i0118';
  await page.waitForSelector(passSelector, { visible: true, timeout: config.timeout });
  const passField = await page.$(passSelector);
  await passField.type(config.password, { delay: 30 });
  logger.info('Senha Microsoft preenchida');
  await debugScreenshot(page, '04-ms-password-filled');

  const signInBtn = await page.$('input[type="submit"], #idSIButton9');
  if (signInBtn) {
    await signInBtn.click();
    logger.info('Botão "Sign in" Microsoft clicado');
  }
  await sleep(3000);
  await debugScreenshot(page, '05-ms-after-signin');

  await handleMicrosoftMFA(page);
  await handleStaySignedIn(page);

  logger.info('Aguardando redirecionamento de volta ao Ahgora...');
  try {
    await page.waitForFunction(
      () => window.location.href.includes('ahgora.com.br'),
      { timeout: config.timeout }
    );
    logger.info('Redirecionado para o Ahgora com sucesso!');
  } catch {
    logger.warn('Timeout aguardando redirecionamento ao Ahgora — pode já estar na página');
  }
  await sleep(3000);
}

// ---------------------------------------------------------------------------
// MFA Microsoft (TOTP)
// ---------------------------------------------------------------------------

async function handleMicrosoftMFA(page) {
  if (!config.mfaSecret) {
    logger.info('MFA_SECRET não configurado — pulando MFA');
    return;
  }

  logger.info('Verificando se há tela de MFA Microsoft...');
  await sleep(3000);

  const currentUrl = page.url();
  if (!currentUrl.includes('microsoftonline.com') && !currentUrl.includes('login.microsoft.com')) {
    logger.info('Já saiu da Microsoft — MFA não necessário');
    return;
  }

  await debugScreenshot(page, '05-ms-mfa-page');

  let foundCodeField = false;

  for (let attempt = 1; attempt <= 3 && !foundCodeField; attempt++) {
    logger.info(`Tentativa ${attempt} de chegar ao campo de código TOTP...`);
    await debugScreenshot(page, `05-ms-mfa-attempt-${attempt}`);

    const codeField = await page.$('#idTxtBx_SAOTCC_OTC');
    if (codeField) {
      const visible = await page.evaluate((el) => el.offsetParent !== null, codeField);
      if (visible) {
        logger.info('Campo de código TOTP já visível!');
        foundCodeField = true;
        break;
      }
    }

    const signInAnotherWay = await page.$('#signInAnotherWay');
    if (signInAnotherWay) {
      const visible = await page.evaluate((el) => el.offsetParent !== null, signInAnotherWay);
      if (visible) {
        await page.evaluate((el) => el.click(), signInAnotherWay);
        logger.info('Clicou em "I can\'t use my Microsoft Authenticator app right now"');
        await sleep(3000);
        continue;
      }
    }

    const phoneAppOTP = await page.$('div[data-value="PhoneAppOTP"]');
    if (phoneAppOTP) {
      const visible = await page.evaluate((el) => el.offsetParent !== null, phoneAppOTP);
      if (visible) {
        await page.evaluate((el) => el.click(), phoneAppOTP);
        logger.info('Clicou em PhoneAppOTP via data-value');
        await sleep(3000);
        continue;
      }
    }

    await sleep(2000);
  }

  await debugScreenshot(page, '05-ms-after-use-code');

  const mfaSelectors = [
    '#idTxtBx_SAOTCC_OTC',
    'input[name="otc"]',
    'input[aria-label*="code"]',
    'input[aria-label*="código"]',
    'input[placeholder*="Code"]',
    'input[placeholder*="code"]',
    'input[type="tel"]',
  ];

  let mfaField = null;
  let mfaSel = '';
  for (const sel of mfaSelectors) {
    try {
      mfaField = await page.$(sel);
      if (mfaField) {
        const visible = await page.evaluate((el) => el.offsetParent !== null, mfaField);
        if (visible) {
          mfaSel = sel;
          break;
        }
        mfaField = null;
      }
    } catch { /* ignora */ }
  }

  if (!mfaField) {
    logger.error('Campo de código MFA não encontrado');
    await debugScreenshot(page, '05-ms-mfa-field-not-found');
    return;
  }

  logger.info(`Campo MFA encontrado: ${mfaSel}`);
  const token = authenticator.generate(config.mfaSecret);
  logger.info(`Código TOTP gerado: ${token}`);

  await mfaField.click();
  await mfaField.type(token, { delay: 50 });
  await debugScreenshot(page, '05-ms-mfa-filled');

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
  await debugScreenshot(page, '05-ms-after-mfa');
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
        await debugScreenshot(page, '05-ms-stay-signed');
        return;
      }
    }
  }
  logger.info('Tela "Permanecer conectado?" não detectada, seguindo...');
}

// ---------------------------------------------------------------------------
// Etapa 2 — Registrar ponto no Ahgora
// ---------------------------------------------------------------------------

async function registrarPonto(page) {
  logger.info('Navegando para a página de ponto Ahgora...');
  await page.goto(config.pontoUrl, { waitUntil: 'networkidle2', timeout: config.timeout });
  await sleep(5000);
  await debugScreenshot(page, '08-ponto-page');

  logger.info(`URL atual: ${page.url()}`);
  const pageTitle = await page.title();
  logger.info(`Título da página: ${pageTitle}`);

  // Registra listener de API antes do clique
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
        '.batida-btn',
        '.btn-batida',
        '.punch-button',
        '.register-button',
        '[class*="batida"]',
        '[class*="punch"]',
        '[class*="bater"]',
        '[data-testid*="batida"]',
        '[data-testid*="punch"]',
        'button.primary',
        'button.mat-raised-button',
        'button.mat-flat-button',
        '.fab-button',
        'ion-button',
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

    // 3. Qualquer elemento visível com texto de ponto
    async (ctx) => {
      const result = await ctx.evaluate(() => {
        const allElements = document.querySelectorAll(
          'button, a, span, div, [role="button"], ion-button, mat-button'
        );
        for (const el of allElements) {
          const text = el.textContent.trim().toLowerCase();
          if (
            (text.includes('bater') || text.includes('registrar ponto') || text.includes('marcar ponto') || text === 'ponto') &&
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

  // Tenta em todos os frames (página + iframes)
  const frames = [page, ...page.frames().filter(f => f !== page.mainFrame())];
  logger.info(`Frames encontrados: ${frames.length}`);
  for (const frame of frames) {
    if (frame !== page) logger.info(`  Frame: ${frame.url()}`);
  }

  for (const target of frames) {
    const targetName = target === page ? 'página principal' : target.url();
    logger.info(`Tentando em: ${targetName}`);

    for (const estrategia of estrategias) {
      try {
        const ok = await estrategia(target);
        if (ok) {
          logger.info('Clique realizado — aguardando resposta da API do Ahgora...');
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
            logger.warn(`API retornou status ${status} — ponto não confirmado`);
            await debugScreenshot(page, '09-ponto-api-falhou');
            return false;
          }

          // Fallback: verifica confirmação visual
          logger.warn('Timeout aguardando resposta da API — verificando confirmação visual...');
          const confirmFn = () => {
            const text = (document.body?.innerText || document.body?.textContent || '').toLowerCase();
            return (
              text.includes('batida registrada') ||
              text.includes('ponto registrado') ||
              text.includes('registrado com sucesso') ||
              text.includes('batida realizada') ||
              text.includes('marcação realizada') ||
              text.includes('batida confirmada')
            );
          };

          const frameChecks = page.frames().map((frame) => {
            const label = frame === page.mainFrame() ? 'página principal' : frame.url();
            return frame.waitForFunction(confirmFn, { timeout: 10_000 })
              .then(() => { logger.info(`Confirmação visual em: ${label}`); return true; })
              .catch(() => false);
          });

          const visualConfirmed = (await Promise.all(frameChecks)).some(Boolean);
          if (!visualConfirmed) {
            logger.warn('Confirmação não detectada — ponto não confirmado');
            await debugScreenshot(page, '09-ponto-nao-confirmado');
            return false;
          }
          await debugScreenshot(page, '09-ponto-registrado');
          return true;
        }
      } catch (err) {
        logger.warn(`Estratégia falhou em ${targetName}: ${err.message}`);
      }
    }
  }

  // Diagnóstico: loga HTML para ajudar a mapear seletores
  try {
    const html = await page.evaluate(() => document.body.innerHTML.substring(0, 5000));
    logger.info(`HTML da página (primeiros 5000 chars):\n${html}`);
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame()) {
        try {
          const fHtml = await frame.evaluate(() => document.body.innerHTML.substring(0, 3000));
          logger.info(`HTML do iframe (${frame.url()}):\n${fHtml}`);
        } catch { /* ignore */ }
      }
    }
  } catch (e) {
    logger.warn(`Não foi possível capturar HTML: ${e.message}`);
  }

  await debugScreenshot(page, '09-ponto-NAO-encontrado');
  logger.error('Não foi possível encontrar o botão de registrar ponto. Use DRY_RUN=true + DEBUG=true para inspecionar a página.');
  return false;
}

// ---------------------------------------------------------------------------
// Executa o fluxo completo (login → ponto)
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

  // Geolocalização para o Ahgora aceitar a batida
  const context = browser.defaultBrowserContext();
  await context.overridePermissions('https://app.ahgora.com.br', ['geolocation']);
  await page.setGeolocation({ latitude: config.geoLat, longitude: config.geoLng });
  logger.info(`Geolocalização definida: ${config.geoLat}, ${config.geoLng}`);

  try {
    await login(page);

    if (config.dryRun) {
      logger.info('🧪 DRY RUN — login OK, navegando para página de ponto sem clicar...');
      await page.goto(config.pontoUrl, { waitUntil: 'networkidle2', timeout: config.timeout });
      await sleep(5000);
      await debugScreenshot(page, '08-ponto-page-dryrun');
      logger.info(`URL do ponto: ${page.url()}`);

      const frames = page.frames();
      logger.info(`Frames encontrados: ${frames.length}`);
      for (const frame of frames) {
        if (frame !== page.mainFrame()) {
          logger.info(`  Frame: ${frame.url()}`);
        }
      }

      if (config.debug) {
        // Inspeciona botões na página principal
        const buttons = await page.evaluate(() => {
          const btns = document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]');
          return [...btns].map((el) => ({
            tag: el.tagName,
            id: el.id || '',
            class: (el.className || '').toString().substring(0, 100),
            text: el.textContent.trim().substring(0, 80),
            visible: el.offsetParent !== null,
            ariaLabel: el.getAttribute('aria-label') || '',
            type: el.getAttribute('type') || '',
          }));
        });
        logger.info('Botões/links na página:');
        buttons.forEach((b) => logger.info(`  [${b.visible ? 'VISÍVEL' : 'oculto'}] <${b.tag}> id="${b.id}" class="${b.class}" text="${b.text}" aria="${b.ariaLabel}"`));

        const html = await page.evaluate(() => document.body.innerHTML.substring(0, 8000));
        logger.info(`\nHTML da página (8000 chars):\n${html}`);
      }

      const prefixDryRun = config.sistemaPonto ? `${config.sistemaPonto} - ` : '';
      await sendTelegram(`${prefixDryRun}🧪 <b>DRY RUN</b> — Login + navegação OK. Botão de ponto <b>não clicado</b>.`);
      logger.info('=== DRY RUN concluído com sucesso ===');
    } else {
      const pontoOk = await registrarPonto(page);
      if (pontoOk) {
        await notifySuccess();
        logger.info('=== Automação concluída com sucesso ===');
      } else {
        throw new Error('Registro de ponto falhou — sem confirmação da API');
      }
    }
  } finally {
    if (!config.debug) {
      await browser.close();
      logger.info('Browser fechado');
    } else {
      logger.info('Modo debug: browser permanece aberto para inspeção');
    }
  }
}

// ---------------------------------------------------------------------------
// Main — retry automático (até 3 tentativas, intervalo de 30s)
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

  logger.info('--- Configuração carregada ---');
  logger.info(`SISTEMA_PONTO:       ${config.sistemaPonto || '(vazio)'}`);
  logger.info(`AHGORA_USER:         ${config.user || '(não definido)'}`);
  logger.info(`AHGORA_PASS:         ${mask(config.password)}`);
  logger.info(`AHGORA_MFA_SECRET:   ${mask(config.mfaSecret)}`);
  logger.info(`AHGORA_LOGIN_URL:    ${config.loginUrl || '(não definido)'}`);
  logger.info(`AHGORA_PONTO_URL:    ${config.pontoUrl || '(não definido)'}`);
  logger.info(`TELEGRAM_BOT_TOKEN:  ${mask(config.telegramToken)}`);
  logger.info(`TELEGRAM_CHAT_ID:    ${config.telegramChatId || '(não definido)'}`);
  logger.info(`GH_GIST_TOKEN:       ${mask(config.gistToken)}`);
  logger.info(`GIST_ID:             ${config.gistId || '(não definido)'}`);
  logger.info(`GEO_LAT:             ${config.geoLat}`);
  logger.info(`GEO_LNG:             ${config.geoLng}`);
  logger.info(`HEADLESS:            ${config.headless}`);
  logger.info(`DEBUG:               ${config.debug}`);
  logger.info(`DRY_RUN:             ${config.dryRun}`);
  logger.info(`PUPPETEER_PATH:      ${process.env.PUPPETEER_EXECUTABLE_PATH || '(bundled)'}`);
  logger.info('-----------------------------');

  await runMonthlyLogCleanup();

  if (!config.user || !config.password) {
    logger.error('AHGORA_USER e AHGORA_PASS devem estar definidos no arquivo .env');
    process.exit(1);
  }

  if (!config.loginUrl || !config.pontoUrl) {
    logger.error('AHGORA_LOGIN_URL e AHGORA_PONTO_URL devem estar definidos no arquivo .env');
    process.exit(1);
  }

  const todayDisabled = await checkTelegramAndProcess();

  if (todayDisabled) {
    const today = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const batida = getBatidaAtual();
    logger.info(`Ponto desativado para hoje (${today}) — pulando batida ${batida}`);
    const prefixDisabled = config.sistemaPonto ? `${config.sistemaPonto} - ` : '';
    await sendTelegram(`${prefixDisabled}⏸️ Ponto <b>desativado</b> para hoje (${today}) — execução pulada ${batida}`);
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
