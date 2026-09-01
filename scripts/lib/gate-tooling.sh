# shared helpers for #838 gate-tooling probes（install / quality-gate から source する）
#
# 観測だけを行う。文言整形は scripts/report-gate-tools.ts → gate-tooling.ts。

gate_tool_command_present() {
  command -v "$1" >/dev/null 2>&1
}

# Playwright chromium の実体。パッケージだけ入ってバイナリが無い状態は false。
gate_tool_playwright_chromium_present() {
  if [[ -n "${PW_EXECUTABLE_PATH:-}" && -e "${PW_EXECUTABLE_PATH}" ]]; then
    return 0
  fi
  if [[ -x /opt/pw-browsers/chromium ]]; then
    return 0
  fi
  local cache="${HOME}/.cache/ms-playwright"
  [[ -d "${cache}" ]] || return 1
  # ディレクトリ名のプレフィックスで判定（版番号に依存しない）
  local matches=()
  # nullglob: 無ければ空配列（未展開の glob 文字を残さない）
  shopt -s nullglob
  matches=("${cache}"/chromium-*/ "${cache}"/chromium_headless_shell-*/)
  shopt -u nullglob
  ((${#matches[@]} > 0))
}

# stdout に `gitleaks=true semgrep=false ...` を 1 行で出す。
gate_tool_observe_argv() {
  local gitleaks=false semgrep=false aws=false playwrightChromium=false
  gate_tool_command_present gitleaks && gitleaks=true
  gate_tool_command_present semgrep && semgrep=true
  gate_tool_command_present aws && aws=true
  gate_tool_playwright_chromium_present && playwrightChromium=true
  printf 'gitleaks=%s semgrep=%s aws=%s playwrightChromium=%s' \
    "${gitleaks}" "${semgrep}" "${aws}" "${playwrightChromium}"
}

# SessionStart / install 末尾用。常に exit 0。
gate_tool_report() {
  local root="$1"
  # shellcheck disable=SC1091
  local argv
  argv="$(gate_tool_observe_argv)"
  # npx が無い環境でも SessionStart を落とさない
  if command -v npx >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    npx --yes tsx "${root}/scripts/report-gate-tools.ts" ${argv} || true
  else
    echo "⚠️ gate-tooling: npx missing — skipped detailed report (${argv})"
  fi
}
