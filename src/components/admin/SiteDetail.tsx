'use client';

import Link from 'next/link';
import { Button, Card, Section, StatusBadge } from '@/components/admin/ui';
import { color, font, space } from '@/components/admin/ui/tokens';
import { SITE_DESTINATIONS, siteDestinationHref } from './site-destinations';
import { useSiteList } from './use-site-list';
import { siteStatusState } from './state-vocabulary';

/**
 * 拠点詳細 (issue #421)。
 *
 * #421 の情報構造では拠点詳細が「テナント→拠点→端末→受付体験」の結節点で、
 * **ここから全関連設定へ到達できる**ことが受入条件のひとつ。
 *
 * 先に増分 1〜3 で拠点別 4 画面が `?siteId=` を読むようにしてある。順序を逆にして
 * ハブを先に作ると、リンクは拠点を運んでいるように見えて実際は捨てられる
 * （＝開いた先は既定拠点のまま）状態になっていた。
 *
 * まだ拠点を運べない導線は**そう明示する**。リンクを張らないより、
 * 「ここは拠点別ではない」と分かる方が誤解が少ない。
 */
export function SiteDetail({ tenantId, siteId }: { tenantId: string; siteId: string }) {
  // 一覧の取得はヘッダの対象拠点表示と共通のフックへ寄せた (#423)。
  const { sites, status: listStatus, reload } = useSiteList(tenantId);
  const site = sites.find((s) => s.id === siteId) ?? null;

  /**
   * 'loading' | 'ok' | 'missing' | 'error' を明示的に持つ。
   *
   * 以前は「取得できなかった」を状態として持たず早期 return していたため、401 / 403 / 5xx の
   * ときに **site=null のまま「それらしい詳細画面」が描かれ、設定リンクが全部出たまま**に
   * なっていた。セッション切れや権限外テナントの直後にとくに紛らわしい（#536 レビュー P2）。
   * 拠点が確認できるまでリンクは出さない。
   */
  const status: 'loading' | 'ok' | 'missing' | 'error' =
    listStatus === 'loading'
      ? 'loading'
      : listStatus === 'error'
        ? 'error'
        : site === null
          ? 'missing'
          : 'ok';

  if (status === 'loading') {
    return (
      <section>
        <p style={{ color: color.muted }} data-testid="site-detail-loading">
          読み込み中…
        </p>
      </section>
    );
  }

  if (status === 'error') {
    return (
      <section>
        <h1 style={{ marginTop: 0 }}>拠点を確認できませんでした</h1>
        <p style={{ color: color.muted }}>
          拠点情報の取得に失敗しました。再試行しても直らない場合はログインし直してください。
        </p>
        {/*
          再試行を置く (#554 M3)。文章で「再読み込みするか」と言うだけでは、運用者にできる
          ことが**画面全体のリロードしか無い**。取り直しはヘッダの対象拠点チップにも配られる
          （`invalidateSiteList`）ので、本文だけ直ってヘッダが古いまま、にはならない。
        */}
        <div style={{ display: 'flex', alignItems: 'center', gap: space.sm }}>
          <Button variant="secondary" onClick={() => void reload()} data-testid="site-detail-retry">
            再試行
          </Button>
          <Link href="/admin/sites" data-testid="site-detail-back">
            拠点一覧へ戻る
          </Link>
        </div>
      </section>
    );
  }

  if (status === 'missing') {
    return (
      <section>
        <h1 style={{ marginTop: 0 }}>拠点が見つかりません</h1>
        <p style={{ color: color.muted }}>
          指定された拠点 <code>{siteId}</code> は存在しないか、参照する権限がありません。
        </p>
        <Link href="/admin/sites" data-testid="site-detail-back">
          拠点一覧へ戻る
        </Link>
      </section>
    );
  }

  return (
    <section data-testid="site-detail">
      <p style={{ marginBottom: space.xs }}>
        <Link href="/admin/sites" data-testid="site-detail-back">
          ← 拠点一覧
        </Link>
      </p>
      <h1 style={{ marginTop: 0, marginBottom: space.xs }} data-testid="site-detail-name">
        {site?.name ?? siteId}
      </h1>
      <p style={{ color: color.muted, marginTop: 0 }}>
        拠点 <code data-testid="site-detail-id">{siteId}</code>
        {site ? (
          <>
            {' '}
            <StatusBadge
              status={siteStatusState(site.status).status}
              label={siteStatusState(site.status).label}
            />{' '}
            / 受付端末 {site.deviceCount} 台
          </>
        ) : null}
      </p>

      <Section title="この拠点の設定">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: space.md,
          }}
        >
          {SITE_DESTINATIONS.map((d) => (
            <Card key={d.href}>
              <Link
                href={siteDestinationHref(d, siteId)}
                data-testid={`site-dest-${d.href.replace('/admin/', '')}`}
                style={{ fontSize: font.label, fontWeight: 600 }}
              >
                {d.label}
              </Link>
              <p style={{ color: color.muted, margin: `${space.xs} 0 0` }}>{d.description}</p>
              {!d.siteScoped ? (
                // 拠点を運べない導線であることを明示する。黙ってリンクだけ張ると
                // 「この拠点の設定を開いた」と誤解される。
                <p style={{ color: color.muted, margin: `${space.xs} 0 0`, fontSize: font.small }}>
                  ※ この設定は拠点別ではありません
                </p>
              ) : null}
            </Card>
          ))}
        </div>
      </Section>
    </section>
  );
}
