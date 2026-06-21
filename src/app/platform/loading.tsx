import { SkeletonBlock } from '@/components/admin/ui';

/**
 * `/platform` 配下のルートセグメント読み込み中フォールバック (issue #94, increment 1)。
 *
 * admin と同様、運用コンソールの共通シェルを保ったまま本文だけスケルトン化する。
 */
export default function PlatformLoading() {
  return <SkeletonBlock rows={6} />;
}
