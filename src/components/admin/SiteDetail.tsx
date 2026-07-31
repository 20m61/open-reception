'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, Section, StatusBadge } from '@/components/admin/ui';
import { color, font, space } from '@/components/admin/ui/tokens';
import type { SiteWithDevices } from '@/lib/tenant/site-service';
import { SITE_DESTINATIONS, siteDestinationHref } from './site-destinations';

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
  const [site, setSite] = useState<SiteWithDevices | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/admin/sites?tenantId=${encodeURIComponent(tenantId)}`);
      if (!res.ok) return;
      const list = (await res.json()) as SiteWithDevices[];
      if (cancelled) return;
      const found = list.find((s) => s.id === siteId) ?? null;
      setSite(found);
      setNotFound(found === null);
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, siteId]);

  if (notFound) {
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
              status={site.status === 'active' ? 'ok' : 'stopped'}
              label={site.status === 'active' ? '稼働中' : '停止中'}
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
