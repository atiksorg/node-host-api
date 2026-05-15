#!/usr/bin/env bash
# scripts/update.sh — Обновление движка NodeHost (git pull + pm2 restart)
# Запуск от имени root или пользователя nodehost

set -euo pipefail

ENGINE_DIR="/opt/nodehost"

echo "╔══════════════════════════════════════════╗"
echo "║   NodeHost Platform — Обновление         ║"
echo "╚══════════════════════════════════════════╝"

# ─── 1. Pull кода ───

echo "[1/3] git pull..."
cd "$ENGINE_DIR"
git pull

# ─── 2. Установка зависимостей ───

echo "[2/3] npm install..."
npm install --production

# ─── 3. Перезапуск ───

echo "[3/3] pm2 restart..."
pm2 restart nodehost-api

echo ""
echo "✅ Движок обновлён и перезапущен."
echo "   Версия: $(git log --oneline -1)"
echo "   PM2 статус:"
pm2 status
