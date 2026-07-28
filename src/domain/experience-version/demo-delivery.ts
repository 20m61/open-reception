/**
 * デモ用途の版を「指定端末にだけ配る」ための解決ロジック
 * (issue #363 / `docs/adr/0005-demo-publication-and-experience-version.md` 手順 1 = additive)。
 *
 * ## 何を解いているか
 *
 * デモには「本番の端末には出さないが、実機で見たい」という要求がある（旧 `DemoPublication`
 * の `test` 状態）。これを版モデルへ寄せるにあたり、**版の `status` は増やさない**
 * （ADR 0005 決定 2）。status を増やすと `publishedVersion` の意味が揺れ、#420 の
 * 「公開版は 1 つ」という不変条件が崩れるため。
 *
 * 代わりに「配信対象の指定」（`demoUse.targetDeviceIds`）で表現する。
 *
 * ## なぜデモ版を published にしないか
 *
 * `lifecycle.ts` の `publish` は**前の公開版を `archived` にする**。デモ版を publish すると
 * 本番端末の配信先が消えるため、デモ版は `draft` のまま指定端末へ配る。
 *
 * ## 本モジュールの範囲
 *
 * ADR の移行手順のうち **1（additive）のみ**。デモ側（`domain/demo-studio/`）は無変更で、
 * 公開 API も変えない。ADR が挙げるユーザー判断 3 点（既存記録の移行・語彙統一の
 * タイミング・`/api/admin/demo/publications` の応答形）は手順 2 以降で扱う。
 */
import type { ReceptionExperience, ReceptionExperienceVersion } from './types';

/** 配信されうる状態か（履歴に残るだけの版は配らない）。 */
function isLiveStatus(version: ReceptionExperienceVersion): boolean {
  return version.status === 'published' || version.status === 'draft';
}

/**
 * その版が指定端末へ配られるか。
 *
 * デモ用途の指定が無い版は通常の版なので、どの端末にも配れる（実際に配るかは
 * `resolveVersionForDevice` が status を見て決める）。デモ用途の版は対象端末のみ。
 */
export function isDeliverableTo(version: ReceptionExperienceVersion, deviceId: string): boolean {
  if (!version.demoUse) return true;
  return version.demoUse.targetDeviceIds.includes(deviceId);
}

/**
 * その端末が受け取る版を決める。
 *
 * 解決順:
 *   1. その端末を対象に含むデモ版（複数あれば revision が新しい方）
 *   2. 公開中の版
 *
 * **対象外の端末には公開版を返す**（デモが本番へ漏れない）。どちらも無ければ undefined。
 */
export function resolveVersionForDevice(
  exp: ReceptionExperience,
  deviceId: string,
): ReceptionExperienceVersion | undefined {
  const demo = exp.versions
    .filter((v) => v.demoUse && isLiveStatus(v) && isDeliverableTo(v, deviceId))
    .sort((a, b) => b.revision - a.revision)[0];
  if (demo) return demo;

  return exp.versions.find((v) => v.status === 'published');
}

/** デモ用途が指定された版の一覧（新しい順）。運用画面での確認用。 */
export function demoTargetedVersions(exp: ReceptionExperience): ReceptionExperienceVersion[] {
  return exp.versions.filter((v) => v.demoUse).sort((a, b) => b.revision - a.revision);
}
