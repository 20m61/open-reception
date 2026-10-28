import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CsvImportSummary } from './CsvImport';

/** CSV 取り込みの結果表示 (#1287): エラーと警告を行ごとに示す。 */
describe('CsvImportSummary', () => {
  it('件数に加え、エラーと警告を行番号と理由つきで出す', () => {
    const html = renderToStaticMarkup(
      <CsvImportSummary
        testId="staff"
        summary={{
          mode: 'preview',
          created: 2,
          updated: 0,
          invalid: [{ row: 3, reason: '姓と名のあいだを空白で区切ってください（例: さとう たろう）。' }],
          warnings: [{ row: 2, reason: 'よみがなが未登録です。' }],
        }}
      />,
    );
    expect(html).toContain('新規 2 件');
    expect(html).toContain('エラー 1 件');
    expect(html).toContain('警告 1 件');
    expect(html).toContain('data-testid="staff-csv-invalid"');
    expect(html).toContain('3 行目: 姓と名のあいだ');
    expect(html).toContain('data-testid="staff-csv-warnings"');
    expect(html).toContain('2 行目: よみがなが未登録です。');
  });

  // 下界: 問題の無い取り込みでは、エラーも警告も出さない。部署の取り込みは warnings を返さないこともある。
  it('エラーも警告も無ければ件数だけを出す', () => {
    const html = renderToStaticMarkup(
      <CsvImportSummary testId="dept" summary={{ mode: 'apply', created: 1, updated: 1, invalid: [] }} />,
    );
    expect(html).toContain('取り込み完了: ');
    expect(html).not.toContain('エラー');
    expect(html).not.toContain('警告');
    expect(html).not.toContain('dept-csv-invalid');
    expect(html).not.toContain('dept-csv-warnings');
  });
});
