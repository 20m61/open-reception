/**
 * 音声セッションが受付状態機械へ触れる面を固定する (ADR 0007)。
 *
 * **発信前の確認ゲートを音声が迂回できない**ことの実際の保証は、`VoiceSessionHooks` が
 * `onResolved` しか公開していないこと（＝音声から起こせる受付イベントが `SELECT_TARGET` に
 * 限られること）である。`REQUIRES_CONFIRMATION_ACTIONS` はチャット経路と宣言値にしか
 * 使われておらず、音声を止めていない（ADR 0007 のレビューで判明）。
 *
 * この保証はこれまで**どのテストも固定していなかった**。将来 `VoiceSessionHooks` へ
 * `onConfirmRequested` のような口を足すと、発信の安全弁が静かに外れる。ここで落とす。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('音声セッションの露出面 (ADR 0007)', () => {
  it('VoiceSessionHooks が公開するのは onResolved だけ', () => {
    // 型の形をソースで固定する（実行時に型は消えるため、静的検査で押さえる）。
    const source = readFileSync('src/lib/voice-session/kiosk-binding.ts', 'utf8');
    const match = source.match(/export type VoiceSessionHooks = \{([^}]*)\}/);
    expect(match, 'VoiceSessionHooks の宣言が見つからない').not.toBeNull();
    const members = (match?.[1] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('//') && !line.startsWith('*'))
      .map((line) => line.replace(/\?*:.*$/, ''));
    expect(members).toEqual(['onResolved']);
  });

  it('KioskFlow が音声から起こす受付イベントは SELECT_TARGET だけ', () => {
    // handleVoiceResolved（onResolved の実装）が他のイベントを dispatch していないこと。
    const source = readFileSync('src/components/kiosk/KioskFlow.tsx', 'utf8');
    const body = source.slice(
      source.indexOf('const handleVoiceResolved'),
      source.indexOf('}, []);', source.indexOf('const handleVoiceResolved')),
    );
    expect(body).not.toBe('');
    const dispatched = [...body.matchAll(/type: '([A-Z_]+)'/g)].map((m) => m[1]);
    expect(dispatched).toEqual(['SELECT_TARGET']);
  });
});
