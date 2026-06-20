import type { Metadata } from 'next';
import { StaffCallView } from '@/components/staff/StaffCallView';

// 応答トークンを URL に含むため、Referer 経由の漏えいを避ける。
export const metadata: Metadata = { referrer: 'no-referrer' };

/**
 * 担当者応答ページ (issue #4 increment 2c-残)。
 * 通知リンク（/staff/calls/<receptionId>?token=<answerToken>）から開く。
 * token が無ければ案内のみ表示する。認可は応答エンドポイント側のトークン検証で行う。
 */
export default async function StaffCallPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ token?: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  const { token } = await searchParams;

  if (!token) {
    return (
      <main className="staff-call-page">
        <p>無効なリンクです。通知に記載のリンクからアクセスしてください。</p>
      </main>
    );
  }

  return (
    <main className="staff-call-page">
      <StaffCallView receptionId={id} token={token} />
    </main>
  );
}
