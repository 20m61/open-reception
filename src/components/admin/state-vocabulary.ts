import { STATUS_META, type StatusKind } from './ui/tokens';
import type { SiteStatus, TenantStatus } from '@/domain/tenant/types';

/**
 * 管理画面の**状態語彙の正本** (#898 / 課題 11)。
 *
 * `ui/tokens.ts` の `STATUS_META` が 5 状態（正常 / 注意 / 異常 / 停止 / メンテナンス中）を
 * 定めていたのに、表のセルは共有バッジを通らず**生テキストで独自の対を描いていた**。
 * 結果、同じ `enabled: boolean` が画面によって `無効` とも **`失効`** とも描かれていた。
 *
 * 🔴 **`失効` は語彙の揺れではなく誤りだった。** 値は `enabled` であって期限切れではない。
 * 同じ真偽値が隣の画面では `無効` と描かれているのだから、言葉が割れているだけでなく
 * **意味も嘘**になっていた。
 *
 * ここが直すのは**言葉の出所**であって見せ方ではない。各画面は今までどおり
 * インラインの色つきテキストで描いてよい（バッジ化は密度が変わる設計判断なので別に扱う）。
 * 色も `STATUS_META` から引くので、`ok → success` / `stopped → muted` を使っていた画面は
 * 描画が 1 ピクセルも変わらない。
 */
export type StateDisplay = {
  readonly status: StatusKind;
  readonly label: string;
  /** インラインテキストで描くときの文字色。共有バッジと同じ出所から引く。 */
  readonly color: string;
};

function display(status: StatusKind, label: string): StateDisplay {
  return { status, label, color: STATUS_META[status].color };
}

/** `enabled: boolean` 軸（レコードが有効か）。 */
export function enablementState(enabled: boolean): StateDisplay {
  return enabled ? display('ok', '有効') : display('stopped', '無効');
}

/**
 * 拠点の `status` 軸。
 *
 * 一覧は `有効` / `停止中`、詳細は `稼働中` / `停止中` と、**同じエンティティで 2 通り**
 * 描いていた。詳細（共有 `StatusBadge` を既に使っている側）へ寄せる。
 */
export function siteStatusState(status: SiteStatus): StateDisplay {
  return status === 'active' ? display('ok', '稼働中') : display('stopped', '停止中');
}

/**
 * テナントの `status` 軸（platform コンソール）。
 *
 * 拠点と同じ `'active' | 'suspended'` で、言葉も同じ「稼働中 / 停止中」。**別の軸として
 * 関数を分ける**のは、片方の言葉を将来変えたくなったときに他方を巻き込まないため
 * —— 同じ形をしていることと同じ概念であることは別で、`SiteStatus` と `TenantStatus` は
 * ドメイン型としても分かれている。
 */
export function tenantStatusState(status: TenantStatus): StateDisplay {
  return status === 'active' ? display('ok', '稼働中') : display('stopped', '停止中');
}
