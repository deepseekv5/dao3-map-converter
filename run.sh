#!/usr/bin/env bash
# DAO3 地图转换器 —— 神岛 zip → 官方可导入的 .boxproject
#   ./run.sh            启动并打开界面
#   ./run.sh stop       停止
#   ./run.sh <zip>...   命令行直接转换（不起界面）
set -euo pipefail
cd "$(dirname "$0")"

ROOT="$(pwd)"
CONVERTER="$ROOT"
PORT="${DAO3_CONV_PORT:-8801}"
OUT="${DAO3_CONV_OUT:-$HOME/Desktop/DAO3转换产出}"
RUN_DIR="$ROOT/.run"
PID_FILE="$RUN_DIR/converter.pid"

log() { printf '\033[36m▸\033[0m %s\n' "$*"; }
fail() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# 命令行模式：./run.sh a.zip b.zip
#   --entities <entitiesTree.json>  外挂实体树（精简导出包缺 entitiesTree 时用）
if [ "$#" -gt 0 ] && [ "${1:-}" != "stop" ] && [ "${1:-}" != "start" ]; then
  command -v node >/dev/null || fail "需要 Node.js 18+"
  ENTITIES=""
  ZIPS=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --entities) ENTITIES="${2:-}"; shift 2 ;;
      *) ZIPS+=("$1"); shift ;;
    esac
  done
  [ "${#ZIPS[@]}" -gt 0 ] || fail "没有指定 zip 文件"
  [ -z "$ENTITIES" ] || [ -f "$ENTITIES" ] || fail "entitiesTree 文件不存在：$ENTITIES"
  mkdir -p "$OUT"
  for zip in "${ZIPS[@]}"; do
    [ -f "$zip" ] || { echo "跳过（不存在）：$zip"; continue; }
    log "转换 $(basename "$zip") …"
    node --input-type=module -e "
      import { convertZipToBoxProjects } from '$CONVERTER/convert.mjs';
      const zipPath = process.argv[1];
      const outDir = process.argv[2];
      const entitiesTreePath = process.argv[3] || undefined;
      // 单包与地图组共用一条路径：一次产出 .boxproject（可编辑）+ .boxplay（可直接运行）
      const { isGroup, projects } = convertZipToBoxProjects(zipPath, { outDir, sourceName: zipPath, entitiesTreePath });
      if (isGroup) console.log('  检测到地图组：' + projects.length + ' 个地图');
      for (const { result, built, play } of projects) {
        console.log('  ✓ 工程 ' + built.filename + '  (' + (built.size/1024/1024).toFixed(1) + ' MB)');
        if (play) console.log('  ✓ 游玩 ' + play.filename + '  (' + (play.size/1024/1024).toFixed(1) + ' MB)');
        console.log('    尺寸 ' + built.mapSize.x + '×' + built.mapSize.y + '×' + built.mapSize.z +
                    ' · 体素 ' + result.voxelCount.toLocaleString() +
                    ' · 模型 ' + result.meshCount +
                    ' · blob ' + result.blobs.size +
                    ' · 脚本 ' + (result.scriptNames.length || '无'));
        for (const w of result.warnings) console.log('    · ' + w);
      }
    " "$zip" "$OUT" "$ENTITIES"
  done
  log "产出目录：$OUT"
  exit 0
fi

case "${1:-start}" in
  stop)
    stopped=0
    if [ -f "$PID_FILE" ]; then
      kill "$(cat "$PID_FILE")" 2>/dev/null && stopped=1
      rm -f "$PID_FILE"
    fi
    # 兜底：按端口收拢，避免旧实例（不同 OUT 目录）继续占用
    if command -v lsof >/dev/null 2>&1; then
      for pid in $(lsof -ti "tcp:$PORT" 2>/dev/null || true); do
        kill "$pid" 2>/dev/null && stopped=1
      done
    fi
    [ "$stopped" = 1 ] && log "已停止" || log "没有在运行的实例"
    exit 0 ;;
esac

mkdir -p "$RUN_DIR" "$OUT"
# 端口被别的服务占用时向后避让，而不是复用别人的服务
port_busy() {
  ( exec 3<>"/dev/tcp/127.0.0.1/$1" ) >/dev/null 2>&1
}
if port_busy "$PORT"; then
  for candidate in 8802 8803 8804 8805 8806 8807 8808; do
    if ! port_busy "$candidate"; then
      log "端口 ${PORT} 被其他服务占用，改用 ${candidate}"
      PORT="$candidate"
      break
    fi
  done
fi
( cd "$ROOT" && DAO3_CONV_PORT="$PORT" DAO3_CONV_OUT="$OUT" nohup node server.mjs \
    >"$RUN_DIR/converter.log" 2>&1 & echo $! >"$PID_FILE" )
sleep 1
log "转换器： http://127.0.0.1:${PORT}/"
log "产出目录：${OUT}"
open "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || true
