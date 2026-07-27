import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExperienceVersionsView, type ExperienceVersionsViewProps } from './ExperienceVersionsView';
import type { ReceptionExperienceVersion } from '@/domain/experience-version/types';

function version(over: Partial<ReceptionExperienceVersion> = {}): ReceptionExperienceVersion {
  return {
    revision: 1,
    status: 'published',
    configHash: 'sha256:aaa',
    createdBy: 'admin-1',
    createdAt: '2026-07-27T00:00:00.000Z',
    publishedAt: '2026-07-27T01:00:00.000Z',
    ...over,
  };
}

function render(over: Partial<ExperienceVersionsViewProps> = {}): string {
  return renderToStaticMarkup(
    <ExperienceVersionsView
      versions={[version()]}
      desired={{ revision: 1 }}
      deployments={[{ kioskId: 'kiosk-1', status: 'applied', loadedRevision: 1 }]}
      summary={{ total: 1, applied: 1, pending: 0, stale: 0, failed: 0, complete: true }}
      {...over}
    />,
  );
}

describe('版履歴の表示', () => {
  it('新しい版を上に並べる', () => {
    const html = render({
      versions: [version({ revision: 1, status: 'archived' }), version({ revision: 2 })],
    });

    expect(html.indexOf('rev.2') >= 0 || html.includes('>2<')).toBe(true);
    // revision 2 の行が 1 より前に出る。
    expect(html.indexOf('>2<')).toBeLessThan(html.indexOf('>1<'));
  });

  it('版が無ければ、下書き保存で版が作られることを案内する', () => {
    const html = render({ versions: [] });

    expect(html).toContain('まだ版がありません');
  });

  it('検証結果をエラー/警告/問題なしで出し分ける', () => {
    const withError = render({
      versions: [
        version({
          validationSummary: {
            checkedAt: '2026-07-27T00:00:00.000Z',
            findings: [{ check: 'permission', severity: 'error', message: 'e' }],
          },
        }),
      ],
    });
    expect(withError).toContain('エラー 1');

    const withWarning = render({
      versions: [
        version({
          validationSummary: {
            checkedAt: '2026-07-27T00:00:00.000Z',
            findings: [{ check: 'asset', severity: 'warning', message: 'w' }],
          },
        }),
      ],
    });
    expect(withWarning).toContain('警告 1');

    expect(render({ versions: [version()] })).toContain('未検証');
  });
});

describe('反映状況の表示', () => {
  it('公開中の版と集計サマリを出す', () => {
    const html = render({
      desired: { revision: 3 },
      summary: { total: 4, applied: 1, pending: 1, stale: 1, failed: 1, complete: false },
      deployments: [
        { kioskId: 'k1', status: 'applied', loadedRevision: 3 },
        { kioskId: 'k2', status: 'pending' },
        { kioskId: 'k3', status: 'stale', loadedRevision: 2 },
        { kioskId: 'k4', status: 'failed', loadedRevision: 2, errorCode: 'asset_load_failed' },
      ],
    });

    expect(html).toContain('公開中: rev.3');
    expect(html).toContain('1/4 台が反映済み');
  });

  it('対処が要る端末を先に並べる', () => {
    const html = render({
      desired: { revision: 3 },
      deployments: [
        { kioskId: 'kiosk-ok', status: 'applied', loadedRevision: 3 },
        { kioskId: 'kiosk-ng', status: 'failed', loadedRevision: 2, errorCode: 'schema_invalid' },
      ],
    });

    expect(html.indexOf('kiosk-ng')).toBeLessThan(html.indexOf('kiosk-ok'));
  });

  it('未報告の端末は「未報告」と出す（0 と混同させない）', () => {
    const html = render({
      desired: { revision: 3 },
      deployments: [{ kioskId: 'k1', status: 'pending' }],
    });

    expect(html).toContain('未報告');
  });

  it('エラーコードを表示する', () => {
    const html = render({
      desired: { revision: 3 },
      deployments: [{ kioskId: 'k1', status: 'failed', errorCode: 'asset_load_failed' }],
    });

    expect(html).toContain('asset_load_failed');
  });

  it('公開中の版が無ければ反映状況を出さない', () => {
    const html = render({ desired: null, summary: null });

    expect(html).toContain('公開中の版がありません');
    expect(html).not.toContain('rollout-summary');
  });

  it('端末が 0 台のときに完了と読ませない', () => {
    const html = render({
      desired: { revision: 3 },
      deployments: [],
      summary: { total: 0, applied: 0, pending: 0, stale: 0, failed: 0, complete: false },
    });

    expect(html).toContain('対象端末がありません');
    expect(html).not.toContain('反映済み<');
  });
});
