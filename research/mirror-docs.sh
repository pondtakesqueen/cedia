#!/usr/bin/env bash
# Mirrors official vendor docs as Markdown into research/docs/<vendor>/.
# Rerun to refresh; each page is overwritten in place.
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)/docs"
jobs=8

# vendor | llms.txt index | URL prefix to keep | regex of paths to drop
sources=(
  "claude-code|https://code.claude.com/docs/llms.txt|https://code.claude.com/docs/en/|^$"
  "claude-platform|https://platform.claude.com/llms.txt|https://platform.claude.com/docs/en/|^(api/(beta|organization|compliance|admin)|manage-claude/wif)"
  "codex|https://developers.openai.com/codex/llms.txt|https://learn.chatgpt.com/docs/|^$"
  "openai-api|https://developers.openai.com/api/docs/llms.txt|https://developers.openai.com/api/docs/|^(guides/(image|audio|realtime|voice|speech|fine-tun|vision-fine|embeddings|moderation|batch|ads)|.*realtime)"
  "xai|https://docs.x.ai/llms.txt|https://docs.x.ai/|^(grok/|grok-bot/|x-subscription/|.*imagine|.*voice|.*image|.*video)"
)

fetch() {
  local url="$1" out="$2"
  mkdir -p "$(dirname "$out")"
  curl -sfL --retry 2 "$url" -o "$out" || { rm -f "$out"; echo "FAIL $url" >&2; }
}
export -f fetch

for entry in "${sources[@]}"; do
  IFS='|' read -r vendor index prefix drop <<<"$entry"
  dir="$root/$vendor"
  mkdir -p "$dir"
  curl -sfL "$index" -o "$dir/_index.txt"
  { grep -oE "${prefix}[^ )\"'>]+\.md" "$dir/_index.txt" || true; } | sort -u | while read -r url; do
    rel="${url#"$prefix"}"
    [[ "$rel" =~ $drop ]] && continue
    printf '%s\0%s\0' "$url" "$dir/$rel"
  done | xargs -0 -n2 -P"$jobs" bash -c 'fetch "$0" "$1"'
  echo "$vendor: $(find "$dir" -name '*.md' | wc -l | tr -d ' ') pages"
done
