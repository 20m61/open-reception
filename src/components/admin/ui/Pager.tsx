import { Button } from './Button';
import { font, space } from './tokens';

/**
 * 管理画面 一覧のページ送り (#910 / 課題 18)。
 *
 * それまで同じ形が **6 ファイルに写されていた**（`SitesManager` / `DevicesManager` /
 * `ReservationsManager` / `StayManager` / `AuditLogViewer` / `ReceptionsViewer`）。
 * #910 でページングを 5 つ足すと 11 個になるので、**足す前に共有へ寄せる** ——
 * `MetricCard` / `StatusBadge` が二重定義のまま食い違った #895 / #897 と同じ形を作らない。
 *
 * `testIdPrefix` を取るのは、既存 6 ファイルの e2e が `site-page-prev` のように
 * **一覧ごとの testid** で引いているため。移行しても引き先が変わらないようにしておく。
 *
 * 1 ページに収まるときは**何も描かない**。押せないページ送りを常時出すと、
 * 「一覧が途中で切れているのでは」と読ませる。
 */
export function Pager({
  page,
  pageCount,
  onChange,
  testIdPrefix,
}: {
  /** クランプ済みの現在ページ（1 始まり）。 */
  readonly page: number;
  readonly pageCount: number;
  /** 次のページ番号を受け取る。URL へ書くのは呼び出し側の責務。 */
  readonly onChange: (nextPage: number) => void;
  /** `${prefix}-pagination` / `-page-prev` / `-page-label` / `-page-next` を出す。 */
  readonly testIdPrefix: string;
}) {
  if (pageCount <= 1) return null;

  return (
    <div
      data-testid={`${testIdPrefix}-pagination`}
      style={{ display: 'flex', gap: space.sm, alignItems: 'center', marginTop: space.sm }}
    >
      <Button
        variant="secondary"
        data-testid={`${testIdPrefix}-page-prev`}
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        前へ
      </Button>
      <span style={{ fontSize: font.small, opacity: 0.8 }} data-testid={`${testIdPrefix}-page-label`}>
        {page} / {pageCount} ページ
      </span>
      <Button
        variant="secondary"
        data-testid={`${testIdPrefix}-page-next`}
        disabled={page >= pageCount}
        onClick={() => onChange(page + 1)}
      >
        次へ
      </Button>
    </div>
  );
}
