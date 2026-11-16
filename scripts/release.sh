#!/bin/sh
# 出交付件：构建 → 打 zip → 打印清单哈希。
# 用法：sh scripts/release.sh [目标目录，默认 release/]
# 目的：让「离线包」从「某个本地文件」变成一条可复现命令（见 ARCHITECTURE §10.3、README「可复现构建」）。
set -eu

cd "$(dirname "$0")/.."
OUT=${1:-release}
VERSION=$(node -p "require('./package.json').version")
STAMP=$(date +%Y%m%d)
ZIP="$OUT/chat-demo-static-$VERSION-$STAMP.zip"

echo "== 构建 =="
pnpm build

echo "== 打包 =="
mkdir -p "$OUT"
rm -f "$OUT"/chat-demo-static-*.zip
( cd dist && zip -qr "../$ZIP" . )

echo "== 清单哈希（用于核对产物是否同源）=="
HASH=$(cd dist && find . -type f | sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1)
FILES=$(find dist -type f | wc -l | tr -d ' ')
# 精确字节数（du 按块取整，会和 README 里的数字对不上）
BYTES=$(find dist -type f -print0 | xargs -0 stat -f%z 2>/dev/null | awk '{s+=$1} END {print s+0}')
if [ -z "${BYTES:-}" ] || [ "$BYTES" = "0" ]; then
  BYTES=$(find dist -type f -print0 | xargs -0 stat -c%s | awk '{s+=$1} END {print s+0}')
fi

echo "  文件数   : $FILES"
echo "  体积     : ${BYTES} 字节"
echo "  清单哈希 : $HASH"
echo "  产物     : $ZIP"
echo
echo "  换台机器核对：pnpm build && sh scripts/release.sh 应得到同一个清单哈希；"
echo "  不一致说明源码或依赖版本变了，别把旧包当新包发。"
