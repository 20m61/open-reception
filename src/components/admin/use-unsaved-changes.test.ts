import { describe, expect, it } from 'vitest';
import { isDirty } from './use-unsaved-changes';

/**
 * dirty 判定の中身 (#912 / 課題 12)。
 *
 * `useUnsavedChanges` は React のフックなので node 環境では回せない。判定そのもの
 * （「いま持っている値が、最後にサーバと同期した値と違うか」）を純関数として実装側から
 * export し、**実物を import して**縛る —— ここに述語を書き写すと、テストと実装が
 * 同じ誤りを共有する。フックの配線は e2e が見る。
 */

const LOADED = { companyName: '株式会社テスト', accentColor: '#38bdf8' };

describe('未保存判定', () => {
  it('読み込み直後は未保存でない', () => {
    expect(isDirty(JSON.stringify(LOADED), LOADED)).toBe(false);
  });

  it('値を変えたら未保存', () => {
    expect(isDirty(JSON.stringify(LOADED), { ...LOADED, companyName: '別の名前' })).toBe(true);
  });

  it('元の値へ戻したら未保存でなくなる', () => {
    /*
     * 「一度でも触ったら dirty」にすると、打ち間違えて直した人まで確認に引っかかる。
     * **値で見る**（フラグを立てっぱなしにしない）。
     */
    const baseline = JSON.stringify(LOADED);
    expect(isDirty(baseline, { ...LOADED, companyName: '別の名前' })).toBe(true);
    expect(isDirty(baseline, { ...LOADED })).toBe(false);
  });

  it('下界: 基準が無い（読み込み前）なら未保存にしない', () => {
    // ここを落とすと、開いた瞬間に「保存していない変更があります」が出る。
    expect(isDirty(null, LOADED)).toBe(false);
  });

  it('下界: 値がまだ無い（読み込み中）なら未保存にしない', () => {
    expect(isDirty(JSON.stringify(LOADED), null)).toBe(false);
  });

  it('ネストした値の変更も拾う', () => {
    const nested = { a11yModesEnabled: { largeText: true, highContrast: false } };
    const baseline = JSON.stringify(nested);
    expect(isDirty(baseline, { a11yModesEnabled: { largeText: true, highContrast: true } })).toBe(true);
  });
});

/**
 * #913: 「未設定」と空文字を同じものとして扱う。
 *
 * 決めた方針は **issue の候補 2（比較側で正規化する）**。根拠は実測 ——
 * サーバ側のストアが**すでに両者を同一視している**ので、区別しているのは
 * この述語だけだった:
 *
 *   - `src/lib/branding/branding-store.ts` の `resolve()` … 「空/null はクリア」
 *     （`raw.trim() === ''` → `undefined`）
 *   - `src/lib/voice/voice-store.ts` … `privacyNotice` / `guidanceCallingWaiting` /
 *     `guidanceCallingNotice` はいずれも `.trim() || undefined`
 *
 * したがって「`''` を意味のある値として扱う設定」は現状 1 つも無く、候補 1
 * （読み込み時に正規化して PUT の payload を変える）を採る理由が無い。**送るものは
 * 一切変えない。**
 */
describe('未保存判定: 「未設定」と空文字 (#913)', () => {
  it('{} で読み込んだ画面に打って消しても未保存にならない', () => {
    // これが #913 の症状そのもの。見た目が元どおりなのに確認が出ていた。
    expect(isDirty(JSON.stringify({}), { companyName: '' })).toBe(false);
  });

  it('キーが `undefined` でも「未設定」と同じに見る', () => {
    expect(isDirty(JSON.stringify({}), { companyName: undefined })).toBe(false);
  });

  it('ネストした中の空文字も同じに見る', () => {
    expect(isDirty(JSON.stringify({ a: { b: 1 } }), { a: { b: 1, c: '' } })).toBe(false);
  });

  /*
   * 🔴 **下界その 1。** ここが無いと「常に未保存でない」で全部緑にできる。
   */
  it('下界: 打ちっぱなしなら未保存', () => {
    expect(isDirty(JSON.stringify({}), { companyName: '入力した' })).toBe(true);
  });

  /*
   * 🔴 **下界その 2（この修正でいちばん危ないところ）。**
   * 正規化を「空文字は全部無視」まで広げると、**値が入っていたものを消した**変更まで
   * 見えなくなる —— 倒れる先が安全側から**「変更したのに黙って捨てる」側へ裏返る**。
   * 落とせるのは「元から未設定だったものが空文字になった」場合だけである。
   */
  it('下界: 値が入っていたものを空にしたら未保存（消したことは変更である）', () => {
    expect(isDirty(JSON.stringify({ companyName: '株式会社テスト' }), { companyName: '' })).toBe(true);
  });

  /*
   * 配列は正規化しない。要素の空文字を落とすと**位置がずれて別の値になる**。
   */
  it('配列の中身は正規化しない（順序と位置を保つ）', () => {
    expect(isDirty(JSON.stringify({ xs: ['a', ''] }), { xs: ['a', ''] })).toBe(false);
    expect(isDirty(JSON.stringify({ xs: ['a', ''] }), { xs: ['', 'a'] })).toBe(true);
  });

  /*
   * キー順は比較の都合であって値の違いではない。`{...prev, x}` は新しいキーを末尾へ
   * 足すので、**未設定だった項目を初めて設定すると順序が変わる**。順序で dirty を
   * 立てると、同じ値なのに確認が出る（#913 と同じ「見た目は元どおりなのに出る」型）。
   */
  it('キー順が違っても値が同じなら未保存でない', () => {
    expect(isDirty(JSON.stringify({ a: 1, b: 2 }), { b: 2, a: 1 })).toBe(false);
  });
});
