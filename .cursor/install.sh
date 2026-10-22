#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${script_dir}/.." && pwd)"
cd "$root"

bun_version="1.4.2"
if ! command -v bun >/dev/null 2>&1 || [ "$(bun --version)" != "$bun_version" ]; then
  curl -fsSL https://bun.sh/install | bash -s "bun-v${bun_version}"
fi
sudo ln -sf "${HOME}/.bun/bin/bun" /usr/local/bin/bun
hash -r
if [ "$(bun --version)" != "$bun_version" ]; then
  echo "bun $(bun --version) is on PATH; wanted ${bun_version}" >&2
  exit 1
fi

bun install --frozen-lockfile

parent="$(dirname "$root")"
if [ "$parent" = "/" ]; then
  dest="/cedian"
else
  dest="${parent}/cedian"
fi
if [ "$(basename "$dest")" != "cedian" ] || [ "$dest" = "$root" ] || [ "$dest" = "/" ]; then
  echo "refusing to use ${dest} as the cedian checkout" >&2
  exit 1
fi

is_cedian_url() {
  case "$1" in
    *github.com/pongsathonkheereekaew/cedian | *github.com/pongsathonkheereekaew/cedian.git | *github.com:pongsathonkheereekaew/cedian | *github.com:pongsathonkheereekaew/cedian.git)
      return 0
      ;;
  esac
  return 1
}

classify_cedian() {
  if [ ! -e "$dest" ]; then
    echo absent
    return 0
  fi
  if git -C "$dest" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    url="$(git -C "$dest" remote get-url origin 2>/dev/null || true)"
    if is_cedian_url "$url"; then
      echo cedian
      return 0
    fi
    if [ -n "$url" ]; then
      echo other
      return 0
    fi
  fi
  echo debris
}

remove_dest() {
  if [ ! -e "$dest" ]; then
    return 0
  fi
  if [ -w "$(dirname "$dest")" ]; then
    rm -rf "$dest"
    return 0
  fi
  sudo rm -rf "$dest"
}

prepare_dest() {
  if [ -e "$dest" ] || [ -w "$(dirname "$dest")" ]; then
    return 0
  fi
  sudo mkdir -p "$dest"
  sudo chown "$(id -u):$(id -g)" "$dest"
}

clone_cedian() {
  remove_dest || true
  prepare_dest || true
  if GIT_TERMINAL_PROMPT=0 git clone https://github.com/pongsathonkheereekaew/cedian.git "$dest"; then
    return 0
  fi
  remove_dest || true
  echo "cedian clone failed; install continues" >&2
}

case "$(classify_cedian)" in
  cedian)
    ;;
  other)
    echo "cedian path ${dest} is a different git repo; install continues" >&2
    ;;
  absent | debris)
    clone_cedian
    ;;
esac
