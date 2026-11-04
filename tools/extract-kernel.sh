#!/usr/bin/env bash
# 从官方安装包里提取 Linux 内核，放到 bin/super-agent-code
#
# 用法：
#   ./tools/extract-kernel.sh                 # 自动找当前目录的 TeleAgent-*.deb
#   ./tools/extract-kernel.sh path/to/x.deb   # 指定 deb
#
# 提取后启动：systemctl --user restart teleagent-kernel
set -euo pipefail

cd "$(dirname "$0")/.."

DEB="${1:-}"
if [ -z "$DEB" ]; then
  DEB="$(ls -1 TeleAgent-*.deb 2>/dev/null | head -1 || true)"
fi

if [ -z "$DEB" ] || [ ! -f "$DEB" ]; then
  echo "找不到 deb 包。用法: $0 <TeleAgent-*.deb>" >&2
  exit 1
fi

command -v dpkg-deb >/dev/null || { echo "需要 dpkg-deb（Debian/Ubuntu）" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[1/3] 从 $DEB 取出内核归档"
dpkg-deb --fsys-tarfile "$DEB" \
  | tar -xO ./opt/TeleAgent/resources/super-agent-code-linux-x64.tar.gz > "$TMP/kernel.tar.gz"

echo "[2/3] 解包"
mkdir -p "$TMP/x"
tar -xzf "$TMP/kernel.tar.gz" -C "$TMP/x"

BIN="$(find "$TMP/x" -type f -name 'TeleAgent' | head -1)"
if [ -z "$BIN" ]; then
  echo "归档结构不符合预期，未找到内核可执行文件" >&2
  exit 1
fi

echo "[3/3] 安装到 bin/super-agent-code"
mkdir -p bin
install -m 0755 "$BIN" bin/super-agent-code
echo "完成: $(du -h bin/super-agent-code | cut -f1)  $(file -b bin/super-agent-code | cut -c1-40)"

echo
echo "下一步：把 Windows 上导出的 credential.json 放到项目根目录，然后"
echo "  systemctl --user restart teleagent-kernel"
