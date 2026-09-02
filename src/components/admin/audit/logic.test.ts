import { describe, expect, it } from 'vitest';
import type { AuditLog } from '@/domain/reception/log';
import { AUDIT_CSV_HEADER, auditLogsToCsv } from './logic';

/**
 * 監査ログ CSV (#905 / 課題 17)。
 *
 * 受付履歴側で既に効いている対策（RFC4180 のエスケープ + Excel/Sheets の数式
 * インジェクション無害化）が**監査ログにも効いていること**を縛る。同じ対策を
 * 片側だけに書くのが、このリポジトリで繰り返し出ている失敗の型なので、
 * 「共有関数を呼んでいるか」ではなく**出力そのもの**を見る。
 */

function log(over: Partial<AuditLog> = {}): AuditLog {
  return {
    id: 'a1',
    action: 'department.created',
    actor: 'admin:u1',
    targetType: 'department',
    targetId: 'd1',
    at: '2026-09-02T01:23:45.000Z',
    ...over,
  } as AuditLog;
}

const labelFor = (a: string) => (a === 'department.created' ? '部署作成' : a);

describe('auditLogsToCsv', () => {
  it('ヘッダと 1 行を出す', () => {
    const csv = auditLogsToCsv([log()], labelFor);
    const [header, row] = csv.trimEnd().split('\n');
    expect(header).toBe(AUDIT_CSV_HEADER.join(','));
    expect(row).toBe('2026-09-02T01:23:45.000Z,部署作成,admin:u1,department,d1');
  });

  it('数式として評価されうるセルを無害化する', () => {
    // `actor` / `targetId` は運用者が触れる文字列。
    const csv = auditLogsToCsv([log({ actor: '=1+1', targetId: '@SUM(A1)' })], labelFor);
    expect(csv).toContain('\t=1+1');
    expect(csv).toContain('\t@SUM(A1)');
  });

  it('区切り・引用符・改行を含むセルをクォートする', () => {
    const csv = auditLogsToCsv([log({ actor: 'a,b', targetId: 'x"y' })], labelFor);
    expect(csv).toContain('"a,b"');
    expect(csv).toContain('"x""y"');
  });

  it('🔴 metadata を書き出さない（画面に出ていないものをファイルにだけ出さない）', () => {
    /*
     * #889 で運用者が入力する `reason` が metadata に載るようになった。自由文を
     * エクスポートすると PII 混入の窓が開く（`.claude/rules/pii-secret-minimization.md`）。
     */
    const csv = auditLogsToCsv(
      [log({ metadata: { reason: '来訪者 山田太郎 の依頼で削除' } })],
      labelFor,
    );
    expect(csv).not.toContain('山田太郎');
    expect(csv).not.toContain('reason');
  });

  it('下界: 対象が未設定でも列がずれない', () => {
    const csv = auditLogsToCsv([log({ targetType: undefined, targetId: undefined })], labelFor);
    const row = csv.trimEnd().split('\n')[1] ?? '';
    // 5 列（空セル 2 つを含む）。列数が減ると読み手の対応がずれる。
    expect(row.split(',')).toHaveLength(AUDIT_CSV_HEADER.length);
  });

  it('下界: 0 件でもヘッダだけは出る', () => {
    expect(auditLogsToCsv([], labelFor)).toBe(`${AUDIT_CSV_HEADER.join(',')}\n`);
  });
});
