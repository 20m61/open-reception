/**
 * 切断結果の写像 (#743 AC2 後半)。
 *
 * ここが縛るのは「失敗と成功をどこで分けるか」だけ。実 HTTP は
 * `src/lib/call/vonage-voice-terminator.test.ts` が注入した fetch で見る。
 */
import { describe, expect, it } from 'vitest';
import { terminationOutcomeFromStatus } from './voice-terminator';

describe('terminationOutcomeFromStatus (#743)', () => {
  it.each([200, 204, 299])('%d は切断できたとみなす', (status) => {
    expect(terminationOutcomeFromStatus(status)).toEqual({ kind: 'terminated' });
  });

  /**
   * 🔴 **404 を失敗にしない。** 「もう無い」は切断の目的が達成された状態。
   * webhook の再配信・端末の再試行で二度呼ばれるのは普通で、そのたびに失敗を
   * 記録すると本物の失敗が埋もれる。
   */
  it('🔴 404（もう無い）は冪等な成功', () => {
    expect(terminationOutcomeFromStatus(404)).toEqual({ kind: 'already_ended' });
  });

  /**
   * 🔴 **2xx 以外を成功にしない。** とくに 401/403（資格情報の失効）を握り潰すと、
   * 「切ったつもりで鳴り続けている」状態が記録上は成功として残る。
   */
  it.each([400, 401, 403, 409, 429, 500, 502, 503])('%d は失敗', (status) => {
    expect(terminationOutcomeFromStatus(status)).toEqual({ kind: 'failed' });
  });

  it('🔴 401 と 404 を同じ扱いにしない（資格情報失効を「もう無い」に潰さない）', () => {
    expect(terminationOutcomeFromStatus(401)).not.toEqual(terminationOutcomeFromStatus(404));
  });
});
