/**
 * 実 PSTN 通話の結果確定 (#647)。
 *
 * webhook は相関へ通話状態を書くが、**受付の状態は誰も動かさない**。ここはその写像と、
 * 「webhook が一度も来ない」場合の**遅延タイムアウト**を決める純関数。
 *
 * 体験モデル（`docs/experience/README.md`）への対応:
 *   - 応答あり            → `connected`
 *   - 未応答・話中・辞退  → `timeout`（例外状態 `person_unavailable`）
 *   - 発信自体の失敗      → `failed`（例外状態 `contact_failed`）
 */
import { describe, expect, it } from 'vitest';
import { resolveCallResolution, type CallCorrelationView } from './call-resolution';

const NOW = Date.parse('2026-08-08T12:00:00.000Z');

function correlation(over: Partial<CallCorrelationView> = {}): CallCorrelationView {
  return {
    voiceState: 'ringing',
    status: 'in_flight',
    dialExpiresAt: '2026-08-08T12:00:30.000Z',
    ...over,
  };
}

describe('resolveCallResolution — 相関から受付の結果を決める', () => {
  it.each([
    ['answered', 'connected'],
    ['staff_coming', 'connected'],
  ])('%s は connected', (voiceState, expected) => {
    const r = resolveCallResolution(correlation({ voiceState: voiceState as never }), NOW);
    expect(r.kind).toBe(expected);
  });

  it.each([
    ['no_answer'],
    ['busy'],
    ['declined'],
  ])('%s は timeout（person_unavailable）', (voiceState) => {
    // declined（対応できない）も来訪者から見れば「応答が得られなかった」。
    // 代替導線へ倒す点は未応答と同じなので timeout に写す。
    const r = resolveCallResolution(correlation({ voiceState: voiceState as never }), NOW);
    expect(r.kind).toBe('timeout');
  });

  it('failed は failed（contact_failed）', () => {
    const r = resolveCallResolution(correlation({ voiceState: 'failed' }), NOW);
    expect(r.kind).toBe('failed');
  });

  it.each(['queued', 'ringing', 'awaiting_acceptance'])(
    '%s は未確定（pending）── 予算内なら待つ',
    (voiceState) => {
      const r = resolveCallResolution(correlation({ voiceState: voiceState as never }), NOW);
      expect(r.kind).toBe('pending');
    },
  );

  describe('🔴 webhook が一度も来ない場合の遅延タイムアウト', () => {
    it('予算を過ぎていたら timeout として確定する', () => {
      // Vonage 側障害・署名失敗・相関不整合で webhook が届かないと、
      // 相関は ringing のまま止まる。ここで確定させないと来訪者が永久に待つ。
      const r = resolveCallResolution(
        correlation({ voiceState: 'ringing', dialExpiresAt: '2026-08-08T11:59:59.000Z' }),
        NOW,
      );
      expect(r.kind).toBe('timeout');
      if (r.kind !== 'timeout') throw new Error('unreachable');
      expect(r.reason).toBe('dial_budget_elapsed');
    });

    it('境界ちょうどではまだ確定しない（過ぎてから）', () => {
      const r = resolveCallResolution(
        correlation({ voiceState: 'ringing', dialExpiresAt: '2026-08-08T12:00:00.000Z' }),
        NOW,
      );
      expect(r.kind).toBe('pending');
    });

    it('🔴 予算切れでも、確定済みの通話状態が在ればそちらを優先する', () => {
      // 応答済みなのに「時間切れ」で timeout にすると、担当者が向かっているのに
      // 来訪者へ代替導線を出すことになる。
      const r = resolveCallResolution(
        correlation({ voiceState: 'staff_coming', dialExpiresAt: '2026-08-08T11:00:00.000Z' }),
        NOW,
      );
      expect(r.kind).toBe('connected');
    });

    it('🔴 予算が不明（dialExpiresAt 無し）なら勝手に確定しない', () => {
      // 旧レコードには無い。無いことを「期限切れ」と読むと、鳴っている最中に打ち切る。
      const r = resolveCallResolution(
        correlation({ voiceState: 'ringing', dialExpiresAt: undefined }),
        NOW,
      );
      expect(r.kind).toBe('pending');
    });

    it('🔴 dialExpiresAt が壊れていても確定しない（NaN を「過ぎた」と読まない）', () => {
      const r = resolveCallResolution(
        correlation({ voiceState: 'ringing', dialExpiresAt: 'not-a-date' }),
        NOW,
      );
      expect(r.kind).toBe('pending');
    });
  });

  it('voiceState が無い旧レコードは queued 扱い（pending）', () => {
    const r = resolveCallResolution(correlation({ voiceState: undefined }), NOW);
    expect(r.kind).toBe('pending');
  });
});
