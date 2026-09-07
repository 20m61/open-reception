import { describe, expect, it } from 'vitest';
import { fetchSites, reportsFailure, stripComments, tryCatchBlocks } from './fetch-failure-scan';

/**
 * 走査そのものの検査 (#968 / #973)。
 *
 * 🔴 **近似の緊さは fixture でしか縛れない。** 走査を「実際のコードへ当てて数える」形でしか
 * 使っていないと、**現ツリーにその形が無い**判定は変異を当てても生存する（実測: 到達判定を
 * 丸ごと外す変異が、`admin` / `platform` の両方の行列を素通りした）。
 * `.claude/rules/opus5-autonomous-loop.md`「境界のすぐ内側を踏む入力が無いと、境界を狭める
 * 変異が全部素通りする」と同型なので、ここで直接踏む。
 */
describe('fetch 失敗の走査', () => {
  describe('reportsFailure', () => {
    it('失敗を報告する呼び出しがあれば真', () => {
      expect(reportsFailure("{ setError('読み込めませんでした'); }")).toBe(true);
      expect(reportsFailure('{ setLoadFailed(true); }')).toBe(true);
    });

    it('🔴 画面に何も出ない引数は報告ではない', () => {
      // `{error ? … }` は null も '' も falsy。報告していないのと**完全に同一**。
      expect(reportsFailure('{ setError(null); }')).toBe(false);
      expect(reportsFailure("{ setError(''); }")).toBe(false);
      // 空白 1 文字は truthy だが、描かれるのは空の段落（読み上げにも何も出ない）。
      expect(reportsFailure("{ setError(' '); }")).toBe(false);
    });

    it('何も呼ばなければ偽', () => {
      expect(reportsFailure('{ void 0; }')).toBe(false);
      expect(reportsFailure('{ }')).toBe(false);
    });

    /**
     * 🔴 **無条件の `throw` / `return` より後ろは到達しない。**
     * 呼び出しの有無だけを見ていたときは、`catch (e) { throw e; setError('…'); }` が
     * 「報告している」と判定された（変異が生存した実測）。
     */
    it('🔴 throw の後ろに書いた報告は数えない', () => {
      expect(reportsFailure("{ throw e; setError('読み込めませんでした'); }")).toBe(false);
      expect(reportsFailure("{ return; setError('読み込めませんでした'); }")).toBe(false);
    });

    /**
     * 🔴 **下界。** 条件付きの早期 return まで切ると、正しく書かれた `catch`
     * （世代ガードの定型）を「報告していない」と誤判定する。片側だけ主張すると、
     * 「全部を報告なしと断定する」変異が空虚に通る。
     */
    it('🔴 条件付きの早期 return は切らない（世代ガードの定型）', () => {
      expect(reportsFailure("{ if (cancelled) return; setError('読み込めませんでした'); }")).toBe(
        true,
      );
      expect(reportsFailure("{ if (superseded()) return; setError('失敗しました'); }")).toBe(true);
    });

    it('文字列の中の throw は文ではない', () => {
      expect(reportsFailure("{ log('throw'); setError('失敗しました'); }")).toBe(true);
    });
  });

  describe('fetchSites', () => {
    it('グローバル経由の綴りも拾う', () => {
      // `.` を一律に除外すると、`window.fetch` へ書き換えるだけで検査から外れる。
      expect(fetchSites('await fetch(url)')).toHaveLength(1);
      expect(fetchSites('await window.fetch(url)')).toHaveLength(1);
      expect(fetchSites('await globalThis.fetch(url)')).toHaveLength(1);
    });

    it('別メソッドの `.catch(` などは拾わない', () => {
      expect(fetchSites('res.json().catch(() => null)')).toHaveLength(0);
      expect(fetchSites('prefetch(url)')).toHaveLength(0);
    });
  });

  describe('tryCatchBlocks', () => {
    it('入れ子の try/catch も返す', () => {
      const source = '{ try { try { a(); } catch { b(); } } catch { c(); } }';
      expect(tryCatchBlocks(source)).toHaveLength(2);
    });

    it('catch の無い try は返さない（finally だけの形）', () => {
      expect(tryCatchBlocks('try { a(); } finally { b(); }')).toHaveLength(0);
    });
  });

  describe('stripComments', () => {
    it('URL の // は残す', () => {
      expect(stripComments("const u = 'https://example.com';")).toContain('https://example.com');
    });

    it('行コメントとブロックコメントを落とす', () => {
      expect(stripComments('a(); // b()')).not.toContain('b()');
      expect(stripComments('a(); /* b() */')).not.toContain('b()');
    });
  });
});
