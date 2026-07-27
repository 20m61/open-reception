/**
 * 受付体験バージョンの解決 (issue #419 / #420 の橋渡し)。
 *
 * #420 increment 1 で版のライフサイクル純ロジック（`domain/experience-version/`）は入ったが、
 * **永続化はまだ無い**。それまでの間、resolver に版を渡すための暫定実装を置く:
 *
 *   - published … 現行の設定ストアの内容を「常に公開中の唯一の版」とみなす（revision 1・id `current`）。
 *     いまの運用（管理画面で保存した瞬間に端末へ反映される）をそのまま版 1 本として表現したもの。
 *   - draft     … **解決しない（null → 404）**。下書きストアが存在しないのに draft を名乗る版を
 *     返すと、「プレビューは下書きを見ている」という誤った前提でクライアントが作られる。
 *
 * #420 increment 2（永続化 + repository）でこの module を差し替える。台帳の Wave 2 行を参照。
 */
import type { ExperienceVersionLookup } from '@/domain/product-context/resolver';
import type { ExperienceVersionRef } from '@/domain/product-context/types';

/** 暫定の唯一の版 ID。 */
export const CURRENT_EXPERIENCE_VERSION_ID = 'current';

const CURRENT_VERSION: ExperienceVersionRef = {
  id: CURRENT_EXPERIENCE_VERSION_ID,
  status: 'published',
  revision: 1,
};

export function createCurrentVersionLookup(): ExperienceVersionLookup {
  return {
    resolve({ selector }) {
      if (selector.kind === 'draft') return null;
      if (selector.kind === 'pinned' && selector.experienceVersionId !== CURRENT_EXPERIENCE_VERSION_ID) {
        return null;
      }
      return CURRENT_VERSION;
    },
  };
}
