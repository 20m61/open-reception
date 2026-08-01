import { NextResponse } from 'next/server';
import { getBrandingSettings } from '@/lib/branding/branding-store';
import { defaultTenantIdFrom } from '@/lib/tenant/default-scope';

/**
 * GET /api/kiosk/branding — 受付端末向けのブランディング設定 (issue #88)。
 * 秘匿情報は無く、ロゴ（公開アセット）・アクセント色・社名のみ公開する。
 *
 * **これは旧・個別 API で、既定テナント固定のまま据え置く** (#419 台帳 §9 B-03 の撤去対象)。
 * 端末の正規経路は `GET /api/configuration/effective`（`section-loaders.ts` が端末セッション
 * 由来のテナントで解決する）。ここは端末セッションを要求しない公開経路なので、
 * テナントを受け取る形にすると**任意のテナントのブランディングを無認証で引ける**入口に
 * なる。テナント対応させるのではなく、撤去するのが正しい。挙動は従来と同じ。
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(await getBrandingSettings(defaultTenantIdFrom()));
}
