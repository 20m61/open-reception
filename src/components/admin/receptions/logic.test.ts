import { describe, expect, it } from 'vitest';
import type { ReceptionLog } from '@/domain/reception/log';
import {
  failureReasonLabel,
  filterReceptionLogs,
  kioskFacets,
  paginate,
  receptionLogsToCsv,
  type ReceptionLogFilter,
} from './logic';

function fixture(overrides: Partial<ReceptionLog> = {}): ReceptionLog {
  return {
    id: 'log-1',
    receptionId: 'rec-1',
    kioskId: 'kiosk-lobby',
    purpose: 'meeting',
    targetType: 'staff',
    targetId: 'staff-1',
    targetLabel: '佐藤',
    outcome: 'connected',
    fallbackUsed: false,
    startedAt: '2026-07-01T01:00:00.000Z',
    endedAt: '2026-07-01T01:01:00.000Z',
    durationMs: 60_000,
    createdAt: '2026-07-01T01:01:00.000Z',
    ...overrides,
  };
}

describe('filterReceptionLogs: 受付履歴の検索・フィルタ純関数 (issue #330 item2)', () => {
  it('未指定条件は全件を返す', () => {
    const logs = [fixture(), fixture({ id: 'log-2' })];
    expect(filterReceptionLogs(logs, {})).toHaveLength(2);
  });

  it('期間（開始/終了）で絞り込む。終了日はその日いっぱいを含む', () => {
    const logs = [
      fixture({ id: 'a', startedAt: '2026-06-30T23:59:00.000Z' }),
      fixture({ id: 'b', startedAt: '2026-07-01T12:00:00.000Z' }),
      fixture({ id: 'c', startedAt: '2026-07-02T00:00:01.000Z' }),
    ];
    const filter: ReceptionLogFilter = { start: '2026-07-01', end: '2026-07-01' };
    const result = filterReceptionLogs(logs, filter);
    expect(result.map((l) => l.id)).toEqual(['b']);
  });

  it('結果（outcome）で絞り込む（複数選択は OR）', () => {
    const logs = [
      fixture({ id: 'a', outcome: 'connected' }),
      fixture({ id: 'b', outcome: 'timeout' }),
      fixture({ id: 'c', outcome: 'failed' }),
    ];
    const result = filterReceptionLogs(logs, { outcomes: ['timeout', 'failed'] });
    expect(result.map((l) => l.id).sort()).toEqual(['b', 'c']);
  });

  it('端末（kioskId）で絞り込む', () => {
    const logs = [
      fixture({ id: 'a', kioskId: 'kiosk-lobby' }),
      fixture({ id: 'b', kioskId: 'kiosk-2f' }),
    ];
    expect(filterReceptionLogs(logs, { kioskId: 'kiosk-2f' }).map((l) => l.id)).toEqual(['b']);
  });

  it('条件は AND で組み合わさる', () => {
    const logs = [
      fixture({ id: 'a', kioskId: 'kiosk-lobby', outcome: 'timeout' }),
      fixture({ id: 'b', kioskId: 'kiosk-lobby', outcome: 'connected' }),
      fixture({ id: 'c', kioskId: 'kiosk-2f', outcome: 'timeout' }),
    ];
    const result = filterReceptionLogs(logs, { kioskId: 'kiosk-lobby', outcomes: ['timeout'] });
    expect(result.map((l) => l.id)).toEqual(['a']);
  });
});

describe('kioskFacets: 端末フィルタの選択肢生成 (issue #330 item2)', () => {
  it('件数の多い順、同数なら端末 ID 昇順で返す', () => {
    const logs = [
      fixture({ id: 'a', kioskId: 'kiosk-b' }),
      fixture({ id: 'b', kioskId: 'kiosk-a' }),
      fixture({ id: 'c', kioskId: 'kiosk-a' }),
    ];
    expect(kioskFacets(logs)).toEqual([
      { kioskId: 'kiosk-a', count: 2 },
      { kioskId: 'kiosk-b', count: 1 },
    ]);
  });
});

describe('failureReasonLabel: 内部エラーコードの日本語ラベル化 (issue #330 item3)', () => {
  it('既知コードは日本語ラベルを返す', () => {
    expect(failureReasonLabel('no_answer')).toBe('応答なし');
    expect(failureReasonLabel('call_failed')).toBe('通話に失敗');
    expect(failureReasonLabel('target_not_found')).toBe('呼び出し先が見つからない');
  });

  it('未登録コードは raw 文字列にフォールバックする（非網羅マップ, audit と同じ流儀）', () => {
    expect(failureReasonLabel('vonage_unexpected_edge_case')).toBe('vonage_unexpected_edge_case');
  });

  it('未指定は undefined を返す', () => {
    expect(failureReasonLabel(undefined)).toBeUndefined();
  });
});

describe('paginate: 一覧のページング純関数 (issue #330 item2)', () => {
  const items = Array.from({ length: 25 }, (_, i) => i);

  it('既定のページサイズで分割する', () => {
    const result = paginate(items, 1, 10);
    expect(result.items).toEqual(items.slice(0, 10));
    expect(result.page).toBe(1);
    expect(result.pageCount).toBe(3);
    expect(result.total).toBe(25);
  });

  it('範囲外のページ番号は有効範囲にクランプする', () => {
    expect(paginate(items, 0, 10).page).toBe(1);
    expect(paginate(items, 99, 10).page).toBe(3);
  });

  it('0 件のときは 1 ページ目・0 件を返す（0 除算しない）', () => {
    const result = paginate([], 1, 10);
    expect(result).toEqual({ items: [], page: 1, pageCount: 1, total: 0 });
  });
});

describe('receptionLogsToCsv: CSV エクスポート (issue #330 item2)', () => {
  const outcomeLabel = { connected: '応答', timeout: '未応答', failed: '失敗', cancelled: 'キャンセル' } as const;
  const purposeLabel = (id?: string) => (id === 'meeting' ? '面会' : '-');

  it('ヘッダ行 + データ行を生成する', () => {
    const csv = receptionLogsToCsv([fixture()], { outcomeLabel, purposeLabel });
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('開始日時,端末,目的,呼び出し先,結果,失敗理由,所要秒,代替導線');
    expect(lines[1]).toBe('2026-07-01T01:00:00.000Z,kiosk-lobby,面会,佐藤,応答,,60,いいえ');
  });

  it('来訪者 PII は一切含まない（項目自体が存在しない）', () => {
    const csv = receptionLogsToCsv([fixture()], { outcomeLabel, purposeLabel });
    expect(csv).not.toContain('来客');
    expect(csv).not.toContain('visitor');
  });

  it('カンマ・改行・ダブルクォートを含む値は RFC4180 に沿ってクォートする', () => {
    const csv = receptionLogsToCsv(
      [fixture({ targetLabel: '営業部, 第一課"A"' })],
      { outcomeLabel, purposeLabel },
    );
    expect(csv).toContain('"営業部, 第一課""A"""');
  });

  it('0 件でもヘッダ行のみを返す', () => {
    const csv = receptionLogsToCsv([], { outcomeLabel, purposeLabel });
    expect(csv.trim().split('\n')).toHaveLength(1);
  });
});
