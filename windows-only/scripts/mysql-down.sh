#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="flipchess-mysql"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    echo "[mysql-down] 停止并删除容器 $CONTAINER_NAME..."
    docker rm -f "$CONTAINER_NAME" >/dev/null
    echo "[mysql-down] 已删除 Docker 容器。"
  else
    echo "[mysql-down] 未找到 Docker 容器 $CONTAINER_NAME。"
  fi
fi

if command -v brew >/dev/null 2>&1; then
  if brew services list | grep -q '^mysql\s'; then
    echo "[mysql-down] 停止 Homebrew MySQL 服务..."
    brew services stop mysql >/dev/null || true
    echo "[mysql-down] Homebrew MySQL 已停止。"
  fi
fi
