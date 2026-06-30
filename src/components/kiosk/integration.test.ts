import { describe, expect, it } from 'vitest';
import {
  flowValuesToVisitorInfo,
  resolveKioskGate,
  shouldShowSignage,
  shouldUseCustomFlow,
} from './integration';
import type { KioskFlow } from './custom-flow/types';

function flow(fields: KioskFlow['fields']): KioskFlow {
  return {
    id: 'flow-1',
    purposeKey: 'interview',
    displayName: '面接',
    order: 0,
    steps: ['purpose', 'visitorInfo', 'confirm', 'call'],
    fields,
  };
}

describe('shouldUseCustomFlow', () => {
  it('フローがあれば true', () => {
    expect(shouldUseCustomFlow([flow([])])).toBe(true);
  });

  it('空配列・null・undefined は false（既定フローへフォールバック）', () => {
    expect(shouldUseCustomFlow([])).toBe(false);
    expect(shouldUseCustomFlow(null)).toBe(false);
    expect(shouldUseCustomFlow(undefined)).toBe(false);
  });
});

describe('flowValuesToVisitorInfo', () => {
  it('name/company/note を慣習キーから拾う', () => {
    const f = flow([
      { key: 'name', label: 'お名前', type: 'text', required: true },
      { key: 'company', label: '会社名', type: 'text', required: false },
      { key: 'note', label: 'メモ', type: 'textarea', required: false },
    ]);
    const v = flowValuesToVisitorInfo(f, { name: ' 田中 ', company: 'A社', note: '13時来訪' });
    expect(v).toEqual({ name: '田中', company: 'A社', note: '13時来訪' });
  });

  it('慣習外フィールドはラベル付きで note へ畳み込む', () => {
    const f = flow([
      { key: 'name', label: 'お名前', type: 'text', required: true },
      { key: 'candidate-id', label: '応募番号', type: 'text', required: true },
      { key: 'agree', label: '個人情報の取扱いに同意', type: 'checkbox', required: true },
    ]);
    const v = flowValuesToVisitorInfo(f, { name: '佐藤', 'candidate-id': 'C-42', agree: true });
    expect(v.name).toBe('佐藤');
    expect(v.note).toBe('応募番号: C-42 / 個人情報の取扱いに同意');
  });

  it('false の checkbox はラベルを残さない', () => {
    const f = flow([{ key: 'agree', label: '同意', type: 'checkbox', required: false }]);
    const v = flowValuesToVisitorInfo(f, { agree: false });
    expect(v.note).toBeUndefined();
  });

  it('空入力は company/note を undefined にし、name は空文字を許す', () => {
    const f = flow([
      { key: 'name', label: 'お名前', type: 'text', required: false },
      { key: 'company', label: '会社名', type: 'text', required: false },
    ]);
    const v = flowValuesToVisitorInfo(f, { name: '', company: '' });
    expect(v).toEqual({ name: '', company: undefined, note: undefined });
  });

  it('明示 note と畳み込みを両方連結する', () => {
    const f = flow([
      { key: 'note', label: 'メモ', type: 'text', required: false },
      { key: 'floor', label: '訪問フロア', type: 'text', required: false },
    ]);
    const v = flowValuesToVisitorInfo(f, { note: '直帰予定', floor: '5F' });
    expect(v.note).toBe('直帰予定 / 訪問フロア: 5F');
  });
});

describe('shouldShowSignage', () => {
  const base = { receptionState: 'idle', online: true, active: true as boolean | null, signageItemCount: 2 };

  it('idle + online + 有効 + 項目あり で true', () => {
    expect(shouldShowSignage(base)).toBe(true);
  });

  it('idle 以外は false', () => {
    expect(shouldShowSignage({ ...base, receptionState: 'calling' })).toBe(false);
  });

  it('オフラインは false（オフライン表示優先）', () => {
    expect(shouldShowSignage({ ...base, online: false })).toBe(false);
  });

  it('失効端末は false（利用不可表示優先）', () => {
    expect(shouldShowSignage({ ...base, active: false })).toBe(false);
  });

  it('active=null（取得前/失敗）は表示継続できる', () => {
    expect(shouldShowSignage({ ...base, active: null })).toBe(true);
  });

  it('サイネージ項目なしは false（既定 IdleView へ）', () => {
    expect(shouldShowSignage({ ...base, signageItemCount: 0 })).toBe(false);
  });
});

describe('resolveKioskGate (#239)', () => {
  it('セッション保持で ready（受付フロー表示）', () => {
    expect(resolveKioskGate({ active: true, authorized: true, pinRequired: false })).toBe('ready');
    expect(resolveKioskGate({ active: null, authorized: true, pinRequired: true })).toBe('ready');
  });

  it('未保持かつ PIN 不要は unenrolled（自己許可手段なし→エンロール誘導）', () => {
    expect(resolveKioskGate({ active: true, authorized: false, pinRequired: false })).toBe(
      'unenrolled',
    );
  });

  it('未保持かつ PIN 必須は authorize（PIN で自己許可可能, #23）', () => {
    expect(resolveKioskGate({ active: true, authorized: false, pinRequired: true })).toBe(
      'authorize',
    );
  });

  it('失効は最優先で revoked（未保持でも利用不可表示）', () => {
    expect(resolveKioskGate({ active: false, authorized: false, pinRequired: false })).toBe(
      'revoked',
    );
    expect(resolveKioskGate({ active: false, authorized: true, pinRequired: false })).toBe(
      'revoked',
    );
  });

  it('authorized=null（heartbeat 未確定/取得失敗）は checking（fail-closed・受付フロー出さない）', () => {
    expect(resolveKioskGate({ active: null, authorized: null, pinRequired: false })).toBe('checking');
    expect(resolveKioskGate({ active: true, authorized: null, pinRequired: true })).toBe('checking');
  });

  it('失効は authorized 未確定でも最優先 revoked', () => {
    expect(resolveKioskGate({ active: false, authorized: null, pinRequired: false })).toBe('revoked');
  });
});
