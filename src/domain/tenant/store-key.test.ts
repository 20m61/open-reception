import { describe, expect, it } from 'vitest';
import { tenantScopedStoreKey } from './store-key';

/**
 * テナント別ストアキーの決め方 (#419 残増分)。
 *
 * branding / directory / voice / motions / assets は単一テナント運用の名残で
 * テナント次元を持たない。`section-loaders.ts` は越境を避けるため**既定テナント以外を
 * fail-closed で落として**いるので、**2 つ目のテナントはこれらの機能を一切使えない**。
 *
 * ストアをテナント対応にするのが本来の解。ただし**既存データを孤児にしない**ことが
 * 絶対条件で、それを満たすために「既定テナントは従来キーのまま」にする。
 * これにより永続スキーマの非互換変更を避けられる（＝停止境界に触れない）。
 */

describe('tenantScopedStoreKey', () => {
  it('既定テナントは従来キーのまま（既存データを孤児にしない）', () => {
    // ここが変わると、稼働中の環境で保存済みの branding 等が読めなくなる。
    expect(tenantScopedStoreKey('branding', 'internal', 'internal')).toBe('branding');
  });

  it('既定以外のテナントは分離したキーを使う', () => {
    expect(tenantScopedStoreKey('branding', 'acme', 'internal')).toBe('branding#acme');
  });

  it('テナントが違えばキーも違う（混ざらない）', () => {
    const a = tenantScopedStoreKey('branding', 'acme', 'internal');
    const b = tenantScopedStoreKey('branding', 'globex', 'internal');
    expect(a).not.toBe(b);
  });

  it('ストアが違えばキーも違う（同じテナントでも混ざらない）', () => {
    expect(tenantScopedStoreKey('branding', 'acme', 'internal')).not.toBe(
      tenantScopedStoreKey('voice', 'acme', 'internal'),
    );
  });

  it('区切り文字を含むテナント id でも他のキーへ化けない', () => {
    // `#` を含む id を素通しにすると `branding#a#b` のような衝突を作れる。
    // id は encode してから連結する。
    const weird = tenantScopedStoreKey('branding', 'a#b', 'internal');
    const nested = tenantScopedStoreKey('branding#a', 'b', 'internal');
    expect(weird).not.toBe(nested);
  });

  it('空のテナント id は既定として扱わない（黙って既定へ倒さない）', () => {
    // 呼び出し側の解決漏れを既定テナントのデータで隠すと、越境を静かに作る。
    expect(() => tenantScopedStoreKey('branding', '', 'internal')).toThrow();
  });
});
