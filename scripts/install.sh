#!/usr/bin/env bash
# scripts/install.sh — Первичная установка NodeHost на чистый Ubuntu 22.04
# Запуск от имени root: sudo bash scripts/install.sh

set -euo pipefail

# ─── Конфигурация ───

REPO_URL="https://github.com/atiksorg/node-host-api.git"  # ← Заменить на реальный URL
ENGINE_DIR="/opt/nodehost"
DATA_DIR="/var/nodehost"
NODE_HOST_USER="nodehost"

echo "╔══════════════════════════════════════════╗"
echo "║   NodeHost Platform — Установка         ║"
echo "╚══════════════════════════════════════════╝"

# ─── 0. Проверка и настройка свопа (4 ГБ) ───

echo "[1/12] Проверка свопа..."

SWAP_SIZE_GB=4
SWAP_FILE="/swapfile"
MIN_SWAP_BYTES=$((SWAP_SIZE_GB * 1024 * 1024 * 1024))

current_swap=$(free -b | awk '/^Swap:/ {print $2}')

if [ "$current_swap" -ge "$MIN_SWAP_BYTES" ]; then
  echo "  Своп уже настроен: $(( current_swap / 1024 / 1024 / 1024 )) ГБ — пропускаем"
else
  echo "  Текущий своп: $(( current_swap / 1024 / 1024 / 1024 )) ГБ — создаём ${SWAP_SIZE_GB} ГБ..."

  # Отключаем существующий своп, если есть
  if [ "$current_swap" -gt 0 ]; then
    swapoff "$SWAP_FILE" 2>/dev/null || true
  fi

  # Создаём файл свопа
  fallocate -l "${SWAP_SIZE_GB}G" "$SWAP_FILE"
  chmod 600 "$SWAP_FILE"
  mkswap "$SWAP_FILE"
  swapon "$SWAP_FILE"

  # Делаем постоянным через /etc/fstab
  if ! grep -q "$SWAP_FILE" /etc/fstab 2>/dev/null; then
    echo "$SWAP_FILE none swap sw 0 0" >> /etc/fstab
  fi

  # Настраиваем swappiness (10 — умеренная склонность к использованию свопа)
  if ! grep -q "vm.swappiness" /etc/sysctl.conf 2>/dev/null; then
    echo "vm.swappiness=10" >> /etc/sysctl.conf
  fi
  sysctl vm.swappiness=10

  echo "  Своп ${SWAP_SIZE_GB} ГБ успешно создан и активирован"
fi

# ─── 1. Установка зависимостей ───

echo "[2/12] Установка Node.js, npm, git..."

apt-get update -qq
apt-get install -y -qq curl git build-essential

# Установка Node.js LTS через NodeSource
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi

echo "  Node.js $(node -v), npm $(npm -v)"

# ─── 2. Установка PM2 глобально ───

echo "[3/12] Установка PM2..."
npm install -g pm2

# ─── 3. Установка Caddy ───

echo "[4/12] Установка Caddy..."
if ! command -v caddy &>/dev/null; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
  apt-get update -qq
  apt-get install -y -qq caddy
fi

echo "  Caddy $(caddy version)"

# ─── 4. Создание системного пользователя ───

echo "[5/12] Создание пользователя ${NODE_HOST_USER}..."
if ! id "$NODE_HOST_USER" &>/dev/null; then
  useradd --system --shell /usr/sbin/nologin --create-home "$NODE_HOST_USER"
fi

# ─── 5. Клонирование движка ───

echo "[6/12] Клонирование движка в ${ENGINE_DIR}..."
mkdir -p "$ENGINE_DIR"
git clone --depth=1 "$REPO_URL" "$ENGINE_DIR"

# ─── 6. Создание директорий данных ───

echo "[7/12] Создание директорий данных..."
mkdir -p "${DATA_DIR}"/{apps,db,logs,caddy/data,caddy/config}
chown -R "${NODE_HOST_USER}:${NODE_HOST_USER}" "$DATA_DIR"

# ─── 7. Настройка .env ───

echo "[8/12] Настройка конфигурации..."
if [ ! -f "${DATA_DIR}/.env" ]; then
  # Генерируем случайный токен
  RANDOM_TOKEN=$(openssl rand -hex 32)
  cp "${ENGINE_DIR}/.env.example" "${DATA_DIR}/.env"
  sed -i "s/your-super-secret-token-here/${RANDOM_TOKEN}/" "${DATA_DIR}/.env"
  echo "  .env создан. Токен: ${RANDOM_TOKEN}"
  echo "  ⚠️  Отредактируйте ${DATA_DIR}/.env — укажите BASE_DOMAIN!"
else
  echo "  .env уже существует, пропускаем"
fi

# ─── 8. Установка зависимостей движка ───

echo "[9/12] Установка npm-зависимостей..."
cd "$ENGINE_DIR"
npm install --production

# ─── 9. Запуск управляющего API через PM2 ───

echo "[10/12] Запуск управляющего API..."
su - "$NODE_HOST_USER" -s /bin/bash -c "
  cd ${ENGINE_DIR}
  pm2 start api/index.js --name nodehost-api \
    --max-memory-restart 256M \
    --time \
    --log ${DATA_DIR}/logs/api.log \
    --update-env
  pm2 save
"

# ─── 10. Запуск Caddy ───

echo "[11/12] Запуск Caddy..."

# Копируем Caddyfile
cp "${ENGINE_DIR}/Caddyfile" /etc/caddy/Caddyfile

# Настраиваем XDG-переменные, чтобы Caddy хранил данные в /var/nodehost/caddy/
# (сертификаты, runtime-конфигурация — всё внутри зоны бэкапа)
mkdir -p /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/override.conf << 'OVERRIDE'
[Service]
Environment="XDG_DATA_HOME=/var/nodehost/caddy/data"
Environment="XDG_CONFIG_HOME=/var/nodehost/caddy/config"
OVERRIDE
systemctl daemon-reload

systemctl enable caddy
systemctl restart caddy

# ─── 11. Автозапуск PM2 ───

echo "[12/12] Настройка автозапуска PM2..."
# pm2 startup генерирует systemd-сервис и выводит команду для sudo.
# Запускаем от root напрямую (install.sh уже выполняется от root).
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "${NODE_HOST_USER}" --hp "/home/${NODE_HOST_USER}"
# pm2 save сохраняет текущий список процессов (выполняем от имени целевого пользователя)
su - "$NODE_HOST_USER" -s /bin/bash -c "pm2 save"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   Установка завершена!                   ║"
echo "╠══════════════════════════════════════════╣"
echo "║                                          ║"
echo "║  API:     http://localhost:8080/health   ║"
echo "║  .env:    ${DATA_DIR}/.env              ║"
echo "║  Движок:  ${ENGINE_DIR}                 ║"
echo "║  Данные:  ${DATA_DIR}                   ║"
echo "║                                          ║"
echo "║  ⚠️  Отредактируйте ${DATA_DIR}/.env    ║"
echo "║     → укажите BASE_DOMAIN               ║"
echo "║     → перезапустите: pm2 restart all     ║"
echo "║                                          ║"
echo "╚══════════════════════════════════════════╝"
