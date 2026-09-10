#!/bin/zsh
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="${PARALLEL_PYTHON:-}"
VENV="$ROOT_DIR/.runtime/pdf2zh"

if [ -z "$PYTHON" ]; then
  for candidate in python3.12 python3.11 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      PYTHON="$(command -v "$candidate")"
      break
    fi
  done
fi

if [ -z "$PYTHON" ] || [ ! -x "$PYTHON" ]; then
  echo "需要 Python 3.11 或 3.12"
  exit 1
fi

"$PYTHON" -c 'import sys; assert (3, 11) <= sys.version_info < (3, 13)' 2>/dev/null || {
  echo "PDFMathTranslate 需要 Python 3.11 或 3.12"
  exit 1
}

VENV_PY="$VENV/bin/python"
if [ ! -x "$VENV_PY" ]; then
  "$PYTHON" -m venv "$VENV"
fi
"$VENV_PY" -c 'import sys; assert (3, 11) <= sys.version_info < (3, 13)' 2>/dev/null || {
  echo "现有 PDF 虚拟环境不可用，请备份后移走 .runtime/pdf2zh 再重试。"
  exit 1
}
"$VENV_PY" -m pip install --no-cache-dir "pdf2zh==1.9.11" "tencentcloud-sdk-python-common==3.0.1300" "tencentcloud-sdk-python-tmt==3.0.1300"
"$VENV_PY" -c 'import pdf2zh' 2>/dev/null || {
  echo "PDF 翻译依赖验证失败。"
  exit 1
}
echo "PDFMathTranslate 已就绪"
