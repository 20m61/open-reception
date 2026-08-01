/**
 * 拠点詳細から辿れる設定の登録簿 (issue #421)。
 *
 * #421 の「拠点詳細から全関連設定へ到達できるようにする」を、**リンクが実際に拠点を
 * 運べるかどうかと一緒に**表現する。
 *
 * `siteScoped` を分けているのが要点。付けても無視される導線に `?siteId=` を付けると、
 * リンクが拠点を運んでいるように見えて実際は捨てられる（本リポジトリが繰り返し警告して
 * いる「消費者ゼロの契約」）。**登録簿だけ先に増やさない** — 画面側が URL を読むように
 * なってから `siteScoped` を真にする。
 */

export type SiteDestination = {
  /** 遷移先のベースパス。 */
  href: string;
  label: string;
  /** 何ができる場所かの 1 行説明。 */
  description: string;
  /**
   * `?siteId=` を付けて意味があるか（＝画面が URL から拠点を読むか）。
   * 偽の導線は拠点を運べないので、拠点詳細から開いても既定拠点のままになる。
   */
  siteScoped: boolean;
};

export const SITE_DESTINATIONS: readonly SiteDestination[] = [
  {
    href: '/admin/devices',
    label: '受付端末',
    description: 'この拠点に置く端末の登録・受付URL発行・稼働状態',
    siteScoped: true,
  },
  {
    href: '/admin/operating-hours',
    label: '営業時間',
    description: '曜日別の受付時間・休業日・時間外の案内',
    siteScoped: true,
  },
  {
    href: '/admin/call-routing',
    label: '取次ルート',
    description: '誰に・どの順で・何秒待って繋ぐか',
    siteScoped: true,
  },
  // 旧 `/admin/call-routes` はここに載せない (#421)。ナビから外したのに拠点詳細から
  // 対等なカードとして出すと、入口が変わっただけで重複は残る。旧画面へは正となる
  // `/admin/call-routing` の中の導線から辿る。
  {
    href: '/admin/reception-flows',
    label: '受付フロー',
    description: '来訪目的ごとの受付ステップ',
    siteScoped: true,
  },
  // --- ここから下は **まだ拠点を運べない**。画面が URL の siteId を読んでいない。 ---
  {
    href: '/admin/departments',
    label: '部署',
    description: '取次先の部署（テナント全体で共通）',
    siteScoped: false,
  },
  {
    href: '/admin/staff',
    label: '担当者',
    description: '呼び出し対象の担当者（テナント全体で共通）',
    siteScoped: false,
  },
];

/** 拠点詳細のルート。動的セグメントを持つ唯一の拠点別画面。 */
export const SITE_DETAIL_PATH_PATTERN = '/admin/sites/[siteId]';

/**
 * 「その画面が拠点 1 つにスコープされているか」の単一情報源 (#423)。
 *
 * ヘッダの対象拠点表示（`SiteContextChip`）と、拠点別画面の構造テスト
 * （`tests/config/admin-tenant-scope.test.ts`）が**同じ集合**を見る。別々に列挙すると、
 * 画面を足したときに片方だけ更新されて「本文は拠点別なのにヘッダは何も出さない」
 * （またはその逆）になる — 本リポジトリが繰り返してきた
 * 「ある次元で解いた対策を別の次元へ写していない」形そのもの。
 */
export const SITE_SCOPED_PATHS: readonly string[] = [
  ...SITE_DESTINATIONS.filter((d) => d.siteScoped).map((d) => d.href),
  SITE_DETAIL_PATH_PATTERN,
  /**
   * 旧・呼び出しルート。**拠点詳細のカードには載せない**（入口を増やすと重複が残る）が、
   * 画面自体は `?siteId=` を読んで拠点別に編集する。「ハブから辿れるか」と「拠点別か」は
   * 別の問いなので、登録簿の派生だけにすると**この画面だけヘッダが黙る**。
   * `tests/config/admin-site-context.test.ts` が実ファイルを走査して漏れを落とす。
   */
  '/admin/call-routes',
  /**
   * 受付体験の版管理。拠点詳細のカードには載せていない（#420 のライフサイクル画面で、
   * 拠点別設定というより公開操作）が、`?siteId=` で拠点別に版を持つ (#554)。
   */
  '/admin/experience-versions',
  /**
   * 在館状況。拠点詳細のカードには載せていない（設定ではなく日々の運用画面）が、
   * 滞在は拠点内スコープなので `?siteId=` で拠点別に見る (#554)。
   */
  '/admin/stay',
  /**
   * 待機中サイネージ。受付端末の待機画面は拠点ごとに変える（#554）。
   */
  '/admin/signage',
  /**
   * 来訪予約。予約と QR 招待は拠点内スコープ（#375 の招待モデル）なので拠点別に扱う (#554)。
   */
  '/admin/reservations',
  /**
   * 担当者応答アクション。有効/無効と来訪者向け文言は拠点ごとに設定する (#554)。
   */
  '/admin/staff-response',
];

/**
 * 導線の遷移先 URL を組み立てる。
 * **拠点を運べる導線にだけ** `?siteId=` を付ける（付けても無視される先には付けない）。
 */
export function siteDestinationHref(destination: SiteDestination, siteId: string): string {
  if (!destination.siteScoped || siteId === '') return destination.href;
  return `${destination.href}?siteId=${encodeURIComponent(siteId)}`;
}
