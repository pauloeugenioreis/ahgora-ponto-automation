require('dotenv').config();
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const secret = process.env.AHGORA_MFA_SECRET;
const user = process.env.AHGORA_USER || 'usuario';

if (!secret) {
  console.error('AHGORA_MFA_SECRET não encontrado no .env');
  process.exit(1);
}

const otpauthUrl = `otpauth://totp/Ahgora:${user}?secret=${secret}&issuer=Ahgora`;

QRCode.toDataURL(otpauthUrl, { width: 300, margin: 2 }, (err, dataUrl) => {
  if (err) { console.error(err); process.exit(1); }

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Ahgora MFA QR Code</title>
  <style>
    body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; padding: 40px; background: #f5f5f5; }
    .card { background: white; padding: 32px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.1); text-align: center; }
    h2 { margin: 0 0 8px; }
    p { color: #666; margin: 0 0 24px; font-size: 14px; }
    img { display: block; margin: 0 auto; }
    .warn { margin-top: 24px; font-size: 12px; color: #e53935; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Ahgora — MFA QR Code</h2>
    <p>${user}</p>
    <img src="${dataUrl}" width="300" height="300" alt="QR Code MFA">
    <p class="warn">⚠️ Delete este arquivo após escanear. Não compartilhe.</p>
  </div>
</body>
</html>`;

  const outPath = path.join(__dirname, '..', 'logs', 'mfa-qr.html');
  fs.writeFileSync(outPath, html);
  console.log(`QR Code gerado em: ${outPath}`);
  console.log('Abra o arquivo no browser e escaneie com o Authenticator.');
  console.log('Delete o arquivo depois!');
});
