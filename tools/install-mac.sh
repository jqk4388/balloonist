#!/bin/sh
# Balloonist 安装脚本（macOS）
#
#   sh tools/install-mac.sh              # 构建 JSX + 安装到本机所有 InDesign 版本
#   sh tools/install-mac.sh --no-build   # 只安装，不重新构建
#
# 装进去的东西：
#   ~/Library/Application Support/Adobe/InDesign/<ver>/<lang>/Scripts/Scripts Panel/Balloonist.jsx
#   ~/Library/Application Support/Balloonist/tools/raster/BalloonistRaster          （启动壳）
#   ~/Library/Application Support/Balloonist/tools/raster/BalloonistRaster-osx-*    （分析器）
#
# 分析器是 Go 静态二进制，不需要 .NET / Mono。首次运行前会去掉下载隔离属性，
# 并对两份分析器做 ad-hoc 签名（Apple silicon 上未签名的可执行文件会被直接杀掉）。

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
HOME_DIR="$HOME/Library/Application Support/Balloonist"
RASTER_DIR="$HOME_DIR/tools/raster"
SRC_RASTER="$ROOT/tools/raster"
JSX="$ROOT/dist/Balloonist.jsx"

build=1
for arg in "$@"; do
    case "$arg" in
        --no-build) build=0 ;;
        -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
        *) echo "未知参数: $arg" >&2; exit 2 ;;
    esac
done

if [ "$(uname -s)" != "Darwin" ]; then
    echo "这个脚本是给 macOS 用的；Windows 请跑 pwsh -File tools/install-into-indesign.ps1" >&2
    exit 2
fi

if [ "$build" = 1 ]; then
    command -v node >/dev/null 2>&1 || { echo "需要 Node.js 来构建 dist/Balloonist.jsx" >&2; exit 3; }
    ( cd "$ROOT" && node build.js )
fi

[ -f "$JSX" ] || { echo "缺少 $JSX，先跑 node build.js" >&2; exit 3; }

# --- 分析器 ---------------------------------------------------------------
missing=
for f in BalloonistRaster BalloonistRaster-osx-arm64 BalloonistRaster-osx-x64; do
    [ -f "$SRC_RASTER/$f" ] || missing="$missing $f"
done
if [ -n "$missing" ]; then
    echo "分析器缺失:$missing —— 先跑 npm run raster:build（需要 Go 1.21+）" >&2
    exit 3
fi

mkdir -p "$RASTER_DIR"
for f in BalloonistRaster BalloonistRaster-osx-arm64 BalloonistRaster-osx-x64; do
    cp -f "$SRC_RASTER/$f" "$RASTER_DIR/$f"
    chmod +x "$RASTER_DIR/$f"
    xattr -dr com.apple.quarantine "$RASTER_DIR/$f" 2>/dev/null || true
done

# Intel 版在 Apple silicon / 较新 macOS 上没签名会被 SIGKILL；arm64 版链接器已自带 ad-hoc 签名，
# 但重新拷一遍后保险起见统一再签一次（--force 覆盖旧的，标识符用文件名即可）。
if command -v codesign >/dev/null 2>&1; then
    for f in BalloonistRaster-osx-arm64 BalloonistRaster-osx-x64; do
        codesign --force --sign - --identifier "com.balloonist.raster.$f" "$RASTER_DIR/$f" >/dev/null 2>&1 || \
            echo "提示: $f 签名失败（不影响 Intel/Windows，Apple silicon 上可能仍可运行）" >&2
    done
fi

"$RASTER_DIR/BalloonistRaster" >/dev/null 2>&1 || true   # 只做一次存在性冒烟（无参数会打印用法）

# --- 插件 ----------------------------------------------------------------
copied=0
for app in /Applications/Adobe\ InDesign*/Adobe\ InDesign*.app; do
    [ -d "$app" ] || continue
    ver=$(basename "$app" .app)                 # Adobe InDesign 2025
    ver=${ver##* }                              # 2025
    for panel in \
        "$HOME/Library/Application Support/Adobe/InDesign/$ver"/*/Scripts/Scripts\ Panel \
        "$HOME/Library/Application Support/Adobe/InDesign/$ver/Scripts/Scripts Panel" \
        "$HOME/Library/Application Support/Adobe/InDesign/$ver/Scripts Panel"
    do
        [ -d "$panel" ] || continue
        cp -f "$JSX" "$panel/Balloonist.jsx"
        echo "插件 -> $panel/Balloonist.jsx"
        copied=$((copied + 1))
    done
done

if [ "$copied" = 0 ]; then
    echo "没找到 InDesign 的 Scripts Panel 目录。已安装的 InDesign 会在这里建目录：" >&2
    echo "  ~/Library/Application Support/Adobe/InDesign/<版本>/<语言>/Scripts/Scripts Panel" >&2
    echo "先把 InDesign 打开一次（菜单 窗口 > 工具 > 脚本 会创建它），再重跑本脚本。" >&2
    echo "分析器已就位：$RASTER_DIR" >&2
    exit 4
fi

echo
echo "完成：分析器在 $RASTER_DIR"
echo "在 InDesign 的 窗口 > 工具 > 脚本 里双击 Balloonist.jsx 启动面板。"
