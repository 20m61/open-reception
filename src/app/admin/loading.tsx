import { SkeletonBlock } from '@/components/admin/ui';

/**
 * `/admin` 配下のルートセグメント読み込み中フォールバック (issue #94, increment 1)。
 *
 * App Router はこの `loading.tsx` を Suspense 境界として使い、共通シェル
 * （サイドバー/ヘッダ = layout.tsx）を再マウントせずに本文だけをスケルトンに差し替える。
 * これにより全リロードなしで遷移の即時フィードバックが得られる（SPA ライク）。
 */
export default function AdminLoading() {
  return <SkeletonBlock rows={6} />;
}
