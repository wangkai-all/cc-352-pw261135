#!/usr/bin/env bash
# 无 root 环境下为 Playwright Chromium 安装系统依赖：
# 用 apt 仅下载 .deb，解包到 data/browser-libs，运行时通过 LD_LIBRARY_PATH 加载。
set -euo pipefail
cd "$(dirname "$0")/.."

LIBS_DIR="$PWD/data/browser-libs"
APT_STATE=/tmp/apt-state
APT_CACHE=/tmp/apt-cache
DEB_DIR=/tmp/browser-debs
mkdir -p "$LIBS_DIR" "$APT_STATE/lists/partial" "$APT_CACHE/archives/partial" "$DEB_DIR"

APT_OPTS=(
  -o "Dir::State::Lists=$APT_STATE/lists"
  -o "Dir::Cache=$APT_CACHE"
  -o "Dir::State::status=/var/lib/dpkg/status"
  -o "APT::Sandbox::User=root"
)

echo "更新软件包索引…"
apt-get "${APT_OPTS[@]}" update -qq

# Chromium headless shell 在 Debian 12 上缺失的库及其常见传递依赖
PKGS=(
  libglib2.0-0 libnss3 libnspr4 libdbus-1-3
  libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0
  libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2
  libasound2 libgbm1 libxcb1 libxkbcommon0
  libxau6 libxdmcp6 libbsd0 libmd0 libffi8 libpcre2-8-0
  libmount1 libselinux1 libblkid1 libuuid1 zlib1g libexpat1
  libsystemd0 liblzma5 libzstd1 liblz4-1 libgcrypt20 libgpg-error0 libcap2
  libwayland-server0 libxshmfence1 libdrm2 libxrender1 libxi6
  fontconfig fontconfig-config libfontconfig1 fonts-dejavu-core
)

echo "下载 ${#PKGS[@]} 个软件包…"
cd "$DEB_DIR"
apt-get "${APT_OPTS[@]}" download "${PKGS[@]}" 2>&1 | grep -v "^Get:" || true

echo "解包到 $LIBS_DIR …"
for deb in *.deb; do
  dpkg-deb -x "$deb" "$LIBS_DIR"
done

SHELL_BIN=$(ls /home/node/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell 2>/dev/null | head -1)
if [ -n "$SHELL_BIN" ]; then
  LIB_PATH="$LIBS_DIR/lib/x86_64-linux-gnu:$LIBS_DIR/usr/lib/x86_64-linux-gnu"
  MISSING=$(LD_LIBRARY_PATH="$LIB_PATH" ldd "$SHELL_BIN" 2>/dev/null | grep "not found" || true)
  if [ -n "$MISSING" ]; then
    echo "仍缺失的库："
    echo "$MISSING"
    exit 1
  fi
  echo "全部依赖已就绪。"
fi
