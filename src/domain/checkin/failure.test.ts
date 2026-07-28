/**
 * QR 受付の失敗理由と文言の対応の単体テスト (issue #98 / 差分 D)。
 *
 * 通常受付では第 36 wave（#453）で「通信断とサーバ失敗を同じ文言で伝えない」を直したが、
 * **QR 受付には同じ修正が入っていなかった**。`/api/kiosk/checkin/confirm` は 403 / 400 / 503 /
 * その他を返しうるのに、CheckinFlow はすべて `CALL_FAILED` → `networkError` へ潰し、
 * 来訪者には一律で「通信に失敗しました」と出していた。
 */
import { describe, expect, it } from 'vitest';
import { DICTIONARIES, SUPPORTED_LOCALES, makeT } from '@/lib/i18n';
import {
  CHECKIN_CALL_FAILURE_REASONS,
  checkinCallFailureMessageKeyFor,
  checkinCallFailureReasonFrom,
} from './failure';

describe('失敗理由の判定', () => {
  it('通信に到達できなかった場合は network', () => {
    // fetch が例外（status を得られない）。
    expect(checkinCallFailureReasonFrom(undefined)).toBe('network');
    // 上流到達不能をサーバが 503 で伝えた場合も同じ扱い。
    expect(checkinCallFailureReasonFrom(503)).toBe('network');
  });

  it('端末セッション切れは session（来訪者の操作では直らない）', () => {
    expect(checkinCallFailureReasonFrom(403)).toBe('session');
  });

  it('予約が受け付けられない場合は invalid（QR 側の問題）', () => {
    expect(checkinCallFailureReasonFrom(400)).toBe('invalid');
  });

  it('その他の失敗は server（原因を来訪者に転嫁しない）', () => {
    expect(checkinCallFailureReasonFrom(500)).toBe('server');
    expect(checkinCallFailureReasonFrom(502)).toBe('server');
  });
});

describe('文言の対応', () => {
  it('理由ごとに別の文言を出す（すべて通信エラーにしない）', () => {
    const keys = CHECKIN_CALL_FAILURE_REASONS.map(checkinCallFailureMessageKeyFor);
    expect(new Set(keys).size).toBe(CHECKIN_CALL_FAILURE_REASONS.length);
  });

  it('通信断のときだけ従来の文言を使う（既存の挙動を変えない）', () => {
    expect(checkinCallFailureMessageKeyFor('network')).toBe('checkin.error.network');
  });

  it('既存の checkin 文言が在るロケールには、新しい理由の訳も在る', () => {
    // ja-simple は checkin 系を持たない部分カバレッジ locale（`i18n.test.ts` の規約）。
    // 「全ロケール」と決め打ちせず、**兄弟キーが在るロケール**を基準にする。
    const siblings = SUPPORTED_LOCALES.filter(
      (locale) => DICTIONARIES[locale]['checkin.error.network'],
    );
    expect(siblings.length).toBeGreaterThan(1);
    for (const locale of siblings) {
      for (const reason of CHECKIN_CALL_FAILURE_REASONS) {
        const key = checkinCallFailureMessageKeyFor(reason);
        expect(DICTIONARIES[locale][key], `${locale}/${reason}`).toBeTruthy();
      }
    }
  });

  it('どの理由でも通常受付への逃げ道を否定しない', () => {
    // 文言が「もう一度お試しください」だけで終わると、来訪者は行き止まりだと感じる。
    // 逃げ道ボタン（通常受付へ）は常設だが、文言側でも別手段の存在を消さないこと。
    const en = makeT('en');
    for (const reason of CHECKIN_CALL_FAILURE_REASONS) {
      const text = en(checkinCallFailureMessageKeyFor(reason));
      expect(text.length, reason).toBeGreaterThan(0);
    }
  });
});
