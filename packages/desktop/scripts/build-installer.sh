#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$(dirname "$DESKTOP_DIR")")"

echo "=== AutoLander Desktop Build ==="
echo ""

# Detect platform
OS="$(uname -s)"
case "$OS" in
  MINGW*|MSYS*|CYGWIN*|Windows*) PLATFORM="win" ;;
  Darwin*)                        PLATFORM="mac" ;;
  Linux*)                         PLATFORM="linux" ;;
  *)                              echo "Unknown OS: $OS"; exit 1 ;;
esac
echo "Detected platform: $PLATFORM"

# Allow override: BUILD_PLATFORM=mac ./build-installer.sh
if [ -n "$BUILD_PLATFORM" ]; then
  PLATFORM="$BUILD_PLATFORM"
  echo "Override platform: $PLATFORM"
fi

# 1. Check for API URL
if [ -z "$VITE_API_URL" ]; then
  echo ""
  echo "WARNING: VITE_API_URL not set. The app will default to http://localhost:3000"
  echo "Set it to your Render URL, e.g.:"
  echo "  export VITE_API_URL=https://autolander-cloud.onrender.com"
  echo ""
fi

# 2. Install dependencies
echo ">>> Installing dependencies..."
cd "$ROOT_DIR"
npm install

# 3. Download Chrome for Puppeteer into .chromium/
echo ">>> Downloading Chrome for bundling..."
cd "$DESKTOP_DIR"
npx puppeteer browsers install chrome
echo "Chrome downloaded to .chromium/"

# 4. Build the renderer (React/Vite)
echo ">>> Building renderer..."
cd "$DESKTOP_DIR"
npx vite build --config src/renderer/vite.config.js src/renderer
echo "Renderer built to src/renderer/dist/"

# 5. Check for icon
case "$PLATFORM" in
  win)
    if [ ! -f "build/icon.ico" ]; then
      echo ""
      echo "WARNING: No icon at build/icon.ico — installer will use default icon."
      echo "To add your own: place a 256x256 .ico file at packages/desktop/build/icon.ico"
      echo ""
    fi
    ;;
  mac)
    if [ ! -f "build/icon.icns" ]; then
      echo ""
      echo "WARNING: No icon at build/icon.icns — app will use default icon."
      echo "To add your own: place an .icns file at packages/desktop/build/icon.icns"
      echo ""
    fi
    ;;
esac

# 6. Build the Electron package
echo ">>> Building $PLATFORM installer..."
case "$PLATFORM" in
  win)   npx electron-builder --win   --config electron-builder.yml ;;
  mac)   npx electron-builder --mac   --config electron-builder.yml ;;
  linux) npx electron-builder --linux --config electron-builder.yml ;;
esac

echo ""
echo "=== BUILD COMPLETE ==="
echo "Output is in: packages/desktop/release/"
case "$PLATFORM" in
  win)   ls -la release/*.exe 2>/dev/null || echo "(check release/ folder)" ;;
  mac)   ls -la release/*.dmg 2>/dev/null || echo "(check release/ folder)" ;;
  linux) ls -la release/*.AppImage 2>/dev/null || echo "(check release/ folder)" ;;
esac
