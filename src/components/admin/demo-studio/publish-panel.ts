/**
 * 受付体験スタジオ 公開/共有パネルの純粋な表示ロジック (issue #363 Inc3 UI・#367 申し送り)。
 *
 * `DemoStudio.tsx` から状態遷移の判定・表示用ラベル導出を切り出し、DOM/fetch に依存しない形で
 * ユニットテストする（`.claude/rules/testing.md` の「純ロジック先行」）。ここでは共有トークンの
 * **値**は一切扱わない（発行直後の一度きり表示は呼び出し側 state が持つ）。
 */
import type { DemoPublicationStatus, DemoPublishTarget } from '@/domain/demo-studio/publication';
import type { Kiosk } from '@/domain/kiosk/types';

/** 共有リンクの表示状態。値そのものではなく、発行/失効/期限の観点のみを表す。 */
export type ShareStatus = 'none' | 'active' | 'expired' | 'revoked';

/** 共有トークンの判定に必要な最小形（値を含まない構造は呼び出し側で組む）。 */
export type ShareLike = {
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
};

/** 共有トークンの表示状態を判定する（失効済み → 期限切れ → 有効 の順に判定）。 */
export function shareStatus(share: ShareLike | undefined, nowMs: number): ShareStatus {
  if (!share) return 'none';
  if (share.revokedAt) return 'revoked';
  if (nowMs >= new Date(share.expiresAt).getTime()) return 'expired';
  return 'active';
}

/**
 * 共有リンクの新規発行を許可するか。
 * published のみ・かつ「現在有効な共有」が無いとき（発行済みで有効な間の重複発行は防ぐ —
 * 再発行したい場合は先に失効させる運用を強制し、意図しない複数リンク乱立を避ける）。
 */
export function canIssueShare(
  status: DemoPublicationStatus,
  existing: ShareLike | undefined,
  nowMs: number,
): boolean {
  if (status !== 'published') return false;
  return shareStatus(existing, nowMs) !== 'active';
}

/** 失効ボタンを出せるか（現在有効な共有があるときのみ）。 */
export function canRevokeShare(existing: ShareLike | undefined, nowMs: number): boolean {
  return shareStatus(existing, nowMs) === 'active';
}

/** 有効化（enabled）された Kiosk から公開先候補を組む（無効化端末は誤公開防止のため除外）。 */
export function selectableTargets(kiosks: readonly Kiosk[], siteId: string): DemoPublishTarget[] {
  return kiosks.filter((k) => k.enabled).map((k) => ({ siteId, kioskId: k.id }));
}

/** 公開先 target の表示ラベル（現存する Kiosk なら表示名、削除/無効化済みなら id をそのまま）。 */
export function targetLabel(target: DemoPublishTarget | undefined, kiosks: readonly Kiosk[]): string {
  if (!target) return '未設定';
  const kiosk = kiosks.find((k) => k.id === target.kioskId);
  return kiosk ? kiosk.displayName : target.kioskId;
}

/** rollback 操作を提示できるか（1 件以上の公開履歴があるか）。 */
export function canShowRollback(versionCount: number): boolean {
  return versionCount > 0;
}
