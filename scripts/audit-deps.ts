#!/usr/bin/env tsx
/**
 * 依存監査（root ＋ infra）(#634)。
 *
 * 元は root の `npm audit --omit=dev` だけを走らせていたため、**`infra/` が 1 度も監査されて
 * いなかった**。Dependabot が報告していた 6 high はすべて `infra/package-lock.json` 由来で、
 * ゲートの `PASS audit` と食い違っていた（どちらも正しく、見ている manifest が違った）。
 * #628（`infra/test/**` がゲートで走っていなかった）と同じ構造の穴。
 *
 * 受容の判定は `src/domain/governance/audit-allowlist.ts`（純関数・unit test 済み）。
 * ここは npm audit の起動と JSON の読み取りだけを持つ。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  evaluateAudit,
  type Advisory,
  type AllowEntry,
} from '../src/domain/governance/audit-allowlist';

const ROOT = resolve(import.meta.dirname, '..');
const WORKSPACES = [
  { name: 'root', dir: ROOT },
  { name: 'infra', dir: resolve(ROOT, 'infra') },
];

/** `https://github.com/advisories/GHSA-xxxx-xxxx-xxxx` → `GHSA-xxxx-xxxx-xxxx`。 */
function advisoryId(url: unknown, fallback: string): string {
  if (typeof url !== 'string') return fallback;
  const m = url.match(/GHSA-[0-9a-z-]+/i);
  return m ? m[0] : fallback;
}

/**
 * `npm audit --json` を読む。**非ゼロ終了でも JSON は出る**（脆弱性が有ると 1 で終わる）ので、
 * 終了コードではなく出力を見る。出力が読めなかったときだけ異常として扱う。
 */
function auditWorkspace(name: string, dir: string): Advisory[] {
  let raw: string;
  try {
    raw = execFileSync('npm', ['audit', '--omit=dev', '--json'], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    const out = (err as { stdout?: string }).stdout;
    if (!out) throw new Error(`npm audit を実行できませんでした (${name}): ${String(err)}`);
    raw = out;
  }

  const parsed = JSON.parse(raw) as {
    vulnerabilities?: Record<string, { severity?: string; via?: unknown[] }>;
  };
  const found: Advisory[] = [];
  const seen = new Set<string>();
  for (const [module, v] of Object.entries(parsed.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      // via は文字列（別モジュール経由）かオブジェクト（advisory 本体）。本体だけ拾う。
      if (typeof via !== 'object' || via === null) continue;
      const entry = via as { url?: string; title?: string; severity?: string; source?: number };
      const id = advisoryId(entry.url, `unknown-${entry.source ?? module}`);
      const key = `${name}:${module}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        id,
        severity: entry.severity ?? v.severity ?? 'unknown',
        module,
        workspace: name,
        title: entry.title ?? '(no title)',
      });
    }
  }
  return found;
}

function loadAllowlist(): AllowEntry[] {
  const file = resolve(ROOT, 'audit-allowlist.json');
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { entries?: AllowEntry[] };
  return parsed.entries ?? [];
}

const found: Advisory[] = [];
for (const ws of WORKSPACES) {
  if (!existsSync(resolve(ws.dir, 'package.json'))) continue;
  const advisories = auditWorkspace(ws.name, ws.dir);
  console.log(`  ${ws.name}: ${advisories.length} 件`);
  found.push(...advisories);
}

const verdict = evaluateAudit(found, loadAllowlist(), new Date());

for (const a of verdict.allowed) {
  console.log(`  受容: ${a.id} (${a.workspace}/${a.module}, ${a.severity}) — allowlist の期限内`);
}
for (const e of verdict.unused) {
  // 上流が直した合図。放置すると allowlist が事実と乖離するので目立たせる。
  console.log(`  ⚠ 未使用の allowlist entry: ${e.id} — 解消済みなら削除する`);
}
for (const e of verdict.expired) {
  console.error(`  ❌ allowlist の期限切れ: ${e.id}（expires=${e.expires}）— 再評価が要る`);
}
for (const a of verdict.blocking) {
  console.error(`  ❌ ${a.severity}: ${a.id} ${a.workspace}/${a.module} — ${a.title}`);
}

if (verdict.blocking.length > 0 || verdict.expired.length > 0) {
  console.error(
    `依存監査 FAIL: blocking ${verdict.blocking.length} 件 / 期限切れ ${verdict.expired.length} 件`,
  );
  process.exit(1);
}
console.log(`  OK（受容 ${verdict.allowed.length} 件・blocking 0 件）`);
