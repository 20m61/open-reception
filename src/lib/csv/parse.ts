/**
 * 最小限の CSV パーサ (issue #25, #26)。
 * ダブルクオート（"..."）と引用内のカンマ・改行・"" エスケープに対応する。
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  const normalized = text.replace(/\r\n?/g, '\n');

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (inQuotes) {
      if (ch === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  // 末尾フィールド/行
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // 空行を除去
  return rows.filter((r) => !(r.length === 1 && r[0]!.trim() === ''));
}

/**
 * ヘッダ付き CSV を {header: value} のレコード配列へ変換する。
 * 先頭行をヘッダとして扱い、前後空白を除去する。
 */
export function parseCsvRecords(text: string): { headers: string[]; records: Record<string, string>[] } {
  const rows = parseCsv(text);
  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0]!.map((h) => h.trim());
  const records = rows.slice(1).map((r) => {
    const record: Record<string, string> = {};
    headers.forEach((h, idx) => {
      record[h] = (r[idx] ?? '').trim();
    });
    return record;
  });
  return { headers, records };
}
