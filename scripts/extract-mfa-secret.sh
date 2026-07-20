#!/usr/bin/env bash
# Extrai o AHGORA_MFA_SECRET (chave base32 do TOTP) do Microsoft Authenticator
# rodando dentro do Waydroid, para contas corporativas que forçam esse app
# e não expõem a chave/QR ao cadastrar em outro autenticador.
#
# Pré-requisitos:
#   - Waydroid instalado e com sessão iniciada (`waydroid session start`)
#   - Microsoft Authenticator (com.azure.authenticator) instalado e com a
#     conta já cadastrada dentro do Waydroid (via `waydroid show-full-ui`)
#   - sqlite3 no PATH do host (ex: vem com Android SDK platform-tools)
#
# A chave é lida diretamente da coluna `oath_secret_key` da tabela `accounts`
# do banco `PhoneFactor`, que o app grava em texto puro nos dados do Android.
#
# Uso:
#   ./scripts/extract-mfa-secret.sh
#
# Pedirá sua senha de sudo (necessária para ler os dados do container Waydroid).

set -euo pipefail

PKG="${PKG:-com.azure.authenticator}"
DB_NAME="${DB_NAME:-PhoneFactor}"
WAYDROID_DATA="${WAYDROID_DATA:-$HOME/.local/share/waydroid/data}"
DB_DIR="$WAYDROID_DATA/data/$PKG/databases"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "Erro: sqlite3 não encontrado no PATH." >&2
  echo "No Ubuntu: sudo apt install sqlite3" >&2
  exit 1
fi

if ! sudo -v; then
  echo "Erro: falha na autenticação sudo." >&2
  exit 1
fi

if ! sudo test -f "$DB_DIR/$DB_NAME"; then
  echo "Erro: banco não encontrado em $DB_DIR/$DB_NAME" >&2
  echo "Verifique se o Waydroid está com sessão ativa e se a conta já foi" >&2
  echo "cadastrada no Microsoft Authenticator (waydroid show-full-ui)." >&2
  exit 1
fi

TMPDIR="$(mktemp -d)"
trap 'shred -u "$TMPDIR"/PhoneFactor* 2>/dev/null; rm -rf "$TMPDIR"' EXIT

for suffix in "" "-wal" "-shm"; do
  if sudo test -f "$DB_DIR/$DB_NAME$suffix"; then
    sudo cp "$DB_DIR/$DB_NAME$suffix" "$TMPDIR/$DB_NAME$suffix"
  fi
done
sudo chown "$(id -u):$(id -g)" "$TMPDIR"/"$DB_NAME"*

echo
echo "Contas encontradas:"
echo "-------------------"
sqlite3 -separator ' | ' "$TMPDIR/$DB_NAME" \
  "SELECT name, username, oath_secret_key FROM accounts WHERE oath_secret_key <> '';" |
  while IFS='|' read -r name username secret; do
    echo "Empresa:  $(echo "$name" | xargs)"
    echo "Usuário:  $(echo "$username" | xargs)"
    echo "MFA_SECRET: $(echo "$secret" | xargs)"
    echo "-------------------"
  done

echo
echo "Copie o valor de MFA_SECRET acima para AHGORA_MFA_SECRET no seu .env."
echo "(As cópias temporárias do banco foram apagadas ao final deste script.)"
