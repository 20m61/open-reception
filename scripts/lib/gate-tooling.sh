# shared helpers for #838 gate-tooling probes（install / quality-gate から source する）
#
# 観測だけを行う。文言整形は scripts/report-gate-tools.ts → gate-tooling.ts。

gate_tool_command_present() {
  command -v "$1" >/dev/null 2>&1
}

# プリインストール済み Chromium のパス（`playwright install` を走らせずに使う逃げ道）。
#
# 🔴 **この規則の写しを増やさない（2026-09-05）。** 同じ判断が bash 2 箇所（この probe と
# `quality-gate.sh` の lighthouse）と `playwright.config.ts` に散っており、
# **`scripts/vrm-visual-check.mjs` だけが持っていなかった**。そのため `--full` の VRM
# ステップだけが `browserType.launch: Executable doesn't exist at
# .../chromium_headless_shell-1228/...` で落ちた ―― e2e は逃げ道を通るので 483 件 PASS
# しており、「この環境では VRM は動かない」と誤結論しかけた。実際には
# `PW_EXECUTABLE_PATH` を与えれば **30/30 PASS** する。
# `playwright.config.ts` のコメントが警告していた失敗（「env を明示し忘れると動かないと
# 誤って結論づけられる」）を、別のスクリプトで繰り返していた。
#
# env で上書きできるようにしてあるのは、イメージのレイアウトが違う実行環境と、
# テストのため（`tests/hooks/preinstalled-chromium.test.ts`）。
gate_tool_preinstalled_chromium() {
  local path="${GATE_PREINSTALLED_CHROMIUM:-/opt/pw-browsers/chromium}"
  [[ -x "${path}" ]] || return 1
  printf '%s' "${path}"
}

# `PW_EXECUTABLE_PATH` を未設定のときだけ解決して export する。
#
# `scripts/vrm-visual-check.mjs` は `PW_EXECUTABLE_PATH` しか読まないので、起動する側が
# 解決して渡す。**既に設定されていれば触らない** —— 呼び出し側の明示指定を奪わない。
# プリインストール版が無ければ**未設定のまま**にして Playwright の既定解決へ委ねる
# （存在しないパスを掴ませると、素の「入っていない」より分かりにくい失敗になる）。
gate_tool_export_chromium_executable() {
  [[ -z "${PW_EXECUTABLE_PATH:-}" ]] || return 0
  local resolved
  resolved="$(gate_tool_preinstalled_chromium)" || return 0
  export PW_EXECUTABLE_PATH="${resolved}"
}

# Playwright chromium の実体。パッケージだけ入ってバイナリが無い状態は false。
gate_tool_playwright_chromium_present() {
  if [[ -n "${PW_EXECUTABLE_PATH:-}" && -e "${PW_EXECUTABLE_PATH}" ]]; then
    return 0
  fi
  if gate_tool_preinstalled_chromium >/dev/null; then
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
