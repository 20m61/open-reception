/**
 * 管理エリア間の切替導線 (issue #423「developer ロール時のみ platform への切替導線を表示」)。
 *
 * ## これは導線であって認可ではない
 *
 * 認可は `canEnterArea`（各 layout が適用）と各 API / middleware が行う。**導線を出さないことは
 * 保護ではない** — URL は誰でも打てる（#419）。ここでの判定を保護の根拠にしてはいけないし、
 * ここが甘くても厳しくてもサーバ側の可否は 1 ミリも動かない。ここが決めるのは
 * 「行き止まりを見せないか」だけ。
 *
 * ## なぜ必要か
 *
 * 現状 admin ⇄ platform を行き来する UI がどこにも無く、developer は URL を直打ちするしかない。
 * `AdminShell` のヘッダは `テナント管理` / `プラットフォーム運用` と**現在地を書くだけ**だった。
 * #423 の受入条件「主要画面で現在の対象が常に確認できる」の裏側として、**現在地が分かるなら
 * そこから出られる**必要がある（受付端末側で「逃げ道バー」に繰り返し学んだのと同じ形）。
 *
 * ## 方向で条件が違う
 *
 * | 方向 | 条件 | 理由 |
 * | --- | --- | --- |
 * | admin → platform | developer のみ | platform は developer 専用（`canEnterArea` が scope:'all' のみ許可） |
 * | platform → admin | 無条件 | platform に居る時点で developer が保証され、developer は admin へも入れる |
 *
 * 戻り導線に条件を付けると、条件判定を間違えたときに**戻れない画面**が生まれる。行き止まりを
 * 作らない方へ倒す（出しすぎても最悪サーバ側で弾かれるだけ）。
 */
import type { TenantRole } from '@/domain/tenant/types';
import type { AdminArea } from './route-guard';

export type AreaSwitchTarget = {
  /** 遷移先エリア。 */
  area: AdminArea;
  href: string;
  /** ヘッダに出す文言。「どこへ行くか」を書く（現在地は別に表示済み）。 */
  label: string;
};

const TO_PLATFORM: AreaSwitchTarget = {
  area: 'platform',
  href: '/platform',
  label: 'プラットフォーム運用へ',
};

const TO_ADMIN: AreaSwitchTarget = {
  area: 'admin',
  href: '/admin',
  label: 'テナント管理へ',
};

/**
 * 現在のエリアと表示ロールから、出すべき切替導線を返す（無ければ `null`）。
 *
 * 副作用なし・I/O なし。`roles` は `rolesFromActor`（assignment のロール集合）を想定する。
 */
export function resolveAreaSwitch(
  current: AdminArea,
  roles: readonly TenantRole[],
): AreaSwitchTarget | null {
  if (current === 'platform') return TO_ADMIN;
  return roles.includes('developer') ? TO_PLATFORM : null;
}
