import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * クライアントバンドルへの secret 混入を防ぐ静的ガード (#4 / #6)。
 *
 * 'use client' ファイルから server-only な secret 環境変数を参照すると、
 * その値・名称がクライアントバンドルに含まれうる。これを禁止して回帰を防ぐ。
 * （Vonage 認証情報・管理パスワード・セッション署名鍵・kiosk PIN は server-only）
 */
const SRC_DIR = join(process.cwd(), 'src');

/** server-only secret を参照する禁止パターン（client では不可）。 */
const FORBIDDEN = [
  /process\.env\.VONAGE_[A-Z_]+/,
  /process\.env\.ADMIN_[A-Z_]+/,
  /process\.env\.KIOSK_SESSION_SECRET/,
  /process\.env\.KIOSK_PIN/,
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function isClientFile(content: string): boolean {
  // ファイル先頭の "use client" ディレクティブを検出する。
  return /^\s*(['"])use client\1/m.test(content.slice(0, 200));
}

describe('client secret guard (#4/#6)', () => {
  const files = listSourceFiles(SRC_DIR);

  it('テスト対象の src ファイルを収集できている', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("'use client' ファイルは server-only secret 環境変数を参照しない", () => {
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      if (!isClientFile(content)) continue;
      for (const pattern of FORBIDDEN) {
        const m = content.match(pattern);
        if (m) violations.push(`${file}: ${m[0]}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
