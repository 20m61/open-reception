import { describe, expect, it } from 'vitest';
import { diffApiSurface, formatApiSurface, parseApiSurface } from './api-surface';

/**
 * 公開 API 表面の差分判定 (#424「config / API schema の diff チェック」)。
 *
 * **削除・改名は破壊的**（現場の受付端末は配布済みで、`/api/kiosk/*` が消えれば壊れる）。
 * 追加は非破壊。両者を区別して報告しないと、スナップショット更新が「全部同じ重み」になり
 * 破壊的変更がレビューで埋もれる。
 */
describe('diffApiSurface', () => {
  it('同一なら差分なし', () => {
    const surface = ['GET /api/kiosk/flow', 'POST /api/kiosk/enroll'];
    expect(diffApiSurface(surface, surface)).toEqual({ added: [], removed: [] });
  });

  it('追加を added に出す（非破壊）', () => {
    const diff = diffApiSurface(['GET /api/a'], ['GET /api/a', 'POST /api/b']);
    expect(diff).toEqual({ added: ['POST /api/b'], removed: [] });
  });

  it('削除を removed に出す（破壊的）', () => {
    const diff = diffApiSurface(['GET /api/a', 'POST /api/b'], ['GET /api/a']);
    expect(diff).toEqual({ added: [], removed: ['POST /api/b'] });
  });

  it('改名は「削除 + 追加」として出る（同じ経路が消えたことが見える）', () => {
    const diff = diffApiSurface(['GET /api/old'], ['GET /api/new']);
    expect(diff.removed).toEqual(['GET /api/old']);
    expect(diff.added).toEqual(['GET /api/new']);
  });

  it('同じパスでもメソッドが違えば別のエントリ', () => {
    const diff = diffApiSurface(['GET /api/a'], ['POST /api/a']);
    expect(diff.removed).toEqual(['GET /api/a']);
    expect(diff.added).toEqual(['POST /api/a']);
  });

  it('順序に依存しない（走査順が変わっても差分にしない）', () => {
    const diff = diffApiSurface(['GET /api/b', 'GET /api/a'], ['GET /api/a', 'GET /api/b']);
    expect(diff).toEqual({ added: [], removed: [] });
  });

  it('結果はソート済み（差分の出方が実行ごとに揺れない）', () => {
    const diff = diffApiSurface([], ['GET /api/z', 'GET /api/a']);
    expect(diff.added).toEqual(['GET /api/a', 'GET /api/z']);
  });
});

describe('formatApiSurface / parseApiSurface: スナップショットの往復', () => {
  const surface = ['POST /api/kiosk/enroll', 'GET /api/kiosk/flow'];

  it('整形するとソートされ、1 行 1 エントリになる', () => {
    expect(formatApiSurface(surface)).toBe('GET /api/kiosk/flow\nPOST /api/kiosk/enroll\n');
  });

  it('往復しても内容が変わらない', () => {
    expect(parseApiSurface(formatApiSurface(surface))).toEqual([
      'GET /api/kiosk/flow',
      'POST /api/kiosk/enroll',
    ]);
  });

  it('空行とコメント行は無視する（見出しや注記を書けるようにする）', () => {
    const text = ['# 公開 API 表面', '', 'GET /api/a', '  ', '# 注記', 'POST /api/b'].join('\n');
    expect(parseApiSurface(text)).toEqual(['GET /api/a', 'POST /api/b']);
  });

  it('前後の空白を落とす（エディタの整形で差分にしない）', () => {
    expect(parseApiSurface('  GET /api/a  \n')).toEqual(['GET /api/a']);
  });
});
