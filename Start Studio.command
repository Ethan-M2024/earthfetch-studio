#!/bin/bash
# earthfetch Studio launcher for macOS.
# Double-click to start. The first run downloads a private copy of Python and
# the map libraries into this folder (no admin rights, nothing installed
# system-wide). Close this window to stop Studio.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
PORT=7860
URL="http://localhost:$PORT"
UV="$HERE/.tools/uv"
PY="$HERE/.venv/bin/python"
export UV_PYTHON_INSTALL_DIR="$HERE/.tools/python"
export UV_CACHE_DIR="$HERE/.tools/cache"

echo
echo "  earthfetch Studio"
echo "  -----------------"
echo

fail() {
  echo
  echo "  Setup didn't finish. Check your internet connection (a work VPN or"
  echo "  firewall can block astral.sh or pypi.org), then double-click"
  echo "  Start Studio.command again."
  echo
  read -r -p "  Press Return to close. " _
  exit 1
}

if curl -sf "$URL/api/health" >/dev/null 2>&1; then
  echo "  Studio is already running. Opening $URL"
  open "$URL"
  exit 0
fi

if [ ! -x "$UV" ]; then
  echo "  First-time setup: downloading tools. This takes a few minutes..."
  curl -LsSf https://astral.sh/uv/install.sh \
    | env UV_INSTALL_DIR="$HERE/.tools" UV_NO_MODIFY_PATH=1 sh >/dev/null || fail
  [ -x "$UV" ] || fail
fi

if [ ! -f "$HERE/.venv/setup-done.txt" ]; then
  echo "  Installing Python and the map libraries..."
  "$UV" venv "$HERE/.venv" --python 3.11 --quiet --clear || fail
  "$UV" pip install --python "$PY" -r "$HERE/requirements.txt" --quiet || fail
  echo "  Getting the map engine ready..."
  "$PY" -c "import matplotlib.pyplot, rasterio, earthfetch, app.main" >/dev/null 2>&1
  rm -rf "$UV_CACHE_DIR"
  echo done > "$HERE/.venv/setup-done.txt"
  echo "  Setup complete."
  echo
fi

echo "  Starting Studio at $URL"
echo "  Your browser will open in a moment. Keep this window open while you work;"
echo "  close it to stop Studio."
echo

( for _ in $(seq 1 90); do
    if curl -sf "$URL/api/health" >/dev/null 2>&1; then open "$URL"; break; fi
    sleep 1
  done ) &

exec "$PY" -m uvicorn app.main:app --host 127.0.0.1 --port "$PORT" --log-level warning
