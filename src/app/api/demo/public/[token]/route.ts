import { NextResponse } from 'next/server';
import { isValidShareTokenValue } from '@/domain/demo-studio/share-token';
import { resolvePublishedByShareToken } from '@/domain/demo-studio/publication-store';
import {
  createShareAccessLimiter,
  tryShareAccess,
  type ShareAccessLimiter,
} from '@/domain/demo-studio/share-access';

/**
 * GET /api/demo/public/:token — 公開（**認証なし**）デモシナリオ解決 (issue #363 Increment 3・公開モデル)。
 *
 * これは admin ガードを**通さない唯一のデモ経路**。安全性は次で担保する:
 *   1. **fail-closed 解決**: `resolvePublishedByShareToken` は published かつ有効な共有トークンの
 *      publication のみ、現在の公開 version の**シナリオだけ**を返す（target/publication id/内部構造は
 *      露出しない）。draft/test・失効・期限切れ・未知トークンはすべて 404（列挙オラクルを与えない）。
 *   2. **レート制限**: トークン単位の固定窓（`share-access.ts`）。超過は 429（公開リンク拡散の乱用抑止）。
 *   3. 返すシナリオは Inc2 の保存時検証（URL/スクリプト/PII 排除）を通過済みの合成値のみ。実データ・
 *      実 token・admin 領域へはこの経路から一切辿れない（テストで固定）。
 *
 * この経路は**シナリオ定義**を返すだけで、実受付 API（/api/kiosk/*）は呼ばない。実際のプレビュー描画は
 * 公開ページ（/demo/:token）が Mock Adapter 注入＋sandbox 境界の下で行う。
 */
type Ctx = { params: Promise<{ token: string }> };

// プロセス内 best-effort レート制限状態（多重インスタンス/再起動は跨がない, share-access.ts 参照）。
let limiter: ShareAccessLimiter = createShareAccessLimiter();

export async function GET(_request: Request, { params }: Ctx): Promise<NextResponse> {
  const { token } = await params;

  // 形式不正は即 404（解決処理・レート状態を汚さない）。
  if (!isValidShareTokenValue(token)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const now = Date.now();
  const gate = tryShareAccess(limiter, token, now);
  limiter = gate.limiter;
  if (!gate.allowed) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const resolved = await resolvePublishedByShareToken(token, now);
  if (!resolved) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  // シナリオのみ返す（target・publication id・共有トークン内部は載せない）。
  return NextResponse.json({ scenario: resolved.scenario });
}
