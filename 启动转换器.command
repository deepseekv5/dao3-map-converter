#!/usr/bin/env bash
# 双击启动 DAO3 转换器（macOS）
# 找不到 node 时按常见安装位置探测，仍找不到就给出提示。
cd "$(dirname "$0")"

find_node() {
  for candidate in \
    "$(command -v node 2>/dev/null || true)" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /opt/homebrew/opt/node@22/bin/node \
    /usr/local/opt/node@22/bin/node \
    "$HOME/.nvm/versions/node"/*/bin/node \
    "$HOME/.volta/bin/node" \
    /opt/homebrew/opt/node/bin/node; do
    [ -x "$candidate" ] || continue
    echo "$candidate"; return 0
  done
  return 1
}

NODE="$(find_node || true)"
if [ -z "$NODE" ]; then
  echo "未找到 Node.js。"
  echo ""
  echo "请先安装其一："
  echo "  · Homebrew：  brew install node"
  echo "  · 官网下载：  https://nodejs.org/ （选 LTS）"
  echo ""
  echo "装好后重新双击本文件。"
  echo ""
  read -r -p "按回车关闭窗口…" _
  exit 1
fi

echo "使用 $("$NODE" -v) @ $NODE"
export PATH="$(dirname "$NODE"):$PATH"

# 产出目录：桌面/DAO3转换产出
export DAO3_CONV_OUT="${DAO3_CONV_OUT:-$HOME/Desktop/DAO3转换产出}"

./run.sh

echo ""
echo "转换器已启动：http://127.0.0.1:${DAO3_CONV_PORT:-8801}/"
echo "产出目录：$DAO3_CONV_OUT"
echo ""
echo "本窗口可以关掉（转换器在后台运行）。"
echo "要停止：./run.sh stop   或重新双击本文件后再执行 stop"
echo ""
read -r -p "按回车关闭本窗口…" _
