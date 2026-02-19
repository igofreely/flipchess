#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="flipchess-mysql"
MYSQL_PORT="${MYSQL_PORT:-3306}"
MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-123456}"
MYSQL_DATABASE="${MYSQL_DATABASE:-flipchess}"
IMAGE="mysql:8"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
      echo "[mysql-up] 容器 $CONTAINER_NAME 已在运行。"
    else
      echo "[mysql-up] 启动已有容器 $CONTAINER_NAME..."
      docker start "$CONTAINER_NAME" >/dev/null
    fi
  else
    echo "[mysql-up] 创建并启动 MySQL 8 容器..."
    docker run -d \
      --name "$CONTAINER_NAME" \
      -e MYSQL_ROOT_PASSWORD="$MYSQL_ROOT_PASSWORD" \
      -e MYSQL_DATABASE="$MYSQL_DATABASE" \
      -p "$MYSQL_PORT:3306" \
      "$IMAGE" >/dev/null
  fi

  echo "[mysql-up] 等待 MySQL 就绪..."
  for i in {1..60}; do
    if docker exec "$CONTAINER_NAME" mysqladmin ping -uroot -p"$MYSQL_ROOT_PASSWORD" --silent >/dev/null 2>&1; then
      echo "[mysql-up] MySQL 已就绪：127.0.0.1:$MYSQL_PORT/$MYSQL_DATABASE"
      echo "[mysql-up] 可用启动命令：npm run server:start:mysql"
      exit 0
    fi
    sleep 1
  done

  echo "[mysql-up] MySQL 启动超时，请执行：docker logs $CONTAINER_NAME"
  exit 1
fi

if command -v brew >/dev/null 2>&1 && command -v mysql >/dev/null 2>&1; then
  echo "[mysql-up] Docker 不可用，改用本机 Homebrew MySQL 服务..."
  brew services start mysql >/dev/null

  for i in {1..60}; do
    if mysqladmin -h 127.0.0.1 -P "$MYSQL_PORT" -u root ping >/dev/null 2>&1; then
      mysql -h 127.0.0.1 -P "$MYSQL_PORT" -u root -e "CREATE DATABASE IF NOT EXISTS \`$MYSQL_DATABASE\`;" >/dev/null
      echo "[mysql-up] MySQL 已就绪：127.0.0.1:$MYSQL_PORT/$MYSQL_DATABASE (brew)"
      echo "[mysql-up] 可用启动命令：npm run server:start:mysql"
      exit 0
    fi
    sleep 1
  done

  echo "[mysql-up] 本机 MySQL 启动超时，请检查：brew services list"
  exit 1
fi

echo "[mysql-up] 未检测到可用的 Docker 或 Homebrew MySQL，请先安装其一。"
exit 1
