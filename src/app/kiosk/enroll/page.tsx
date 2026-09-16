'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isServerSideFailure } from '@/domain/util/http-failure';

/**
 * 受付端末エンロール画面 (docs/reception-issuance-design.md inc1)。
 *
 * 管理画面が発行した受付URL/QR（`/kiosk/enroll?token=…`）で開かれる。token を
 * `/api/kiosk/enroll` に渡して kiosk セッションへ交換し、成功したら受付画面 `/kiosk` へ遷移する。
 * 成功後は token を URL から消すため replace で遷移する。token は表示・ログに残さない。
 */
type Phase =
  | { kind: 'working' }
  | { kind: 'error'; title: string; detail: string; retryable: boolean };

/**
 * `retryable`: 同じ URL の再試行で復帰しうるか。トークンが無効/使用済み等の端末エラーは
 * 何度叩いても直らないため false（再試行ボタンを出さず「管理画面で再発行」を案内）。通信エラー
 * のみ true（一時的なため再試行が有効）。
 */
type ErrorCopy = { title: string; detail: string; retryable: boolean };

const FALLBACK_ERROR: ErrorCopy = {
  title: 'URLが無効か期限切れです',
  detail: '管理画面で受付URLを再発行してください。',
  retryable: false,
};

/** API のエラーコード → 受付端末向けの平易なメッセージ。 */
const ERROR_MESSAGE: Record<string, ErrorCopy> = {
  missing: {
    title: 'URLが不正です',
    detail: 'QRコードまたはURLをもう一度確認してください。',
    retryable: false,
  },
  invalid_token: FALLBACK_ERROR,
  used: {
    title: 'このURLは既に使用されています',
    detail: '管理画面で受付URLを再発行してください。',
    retryable: false,
  },
  not_found: {
    title: '端末が見つかりません',
    detail: '管理画面で端末の登録を確認してください。',
    retryable: false,
  },
  revoked: {
    title: 'この端末は無効化されています',
    detail: '管理画面で端末を有効化してから再発行してください。',
    retryable: false,
  },
  network: {
    title: '通信に失敗しました',
    detail: 'ネットワークを確認して、もう一度お試しください。',
    retryable: true,
  },
  /**
   * 🔴 **サーバ側の設定不備 (#1123)。** `KIOSK_ENROLLMENT_SECRET` を入れ忘れたデプロイでは
   * `/api/kiosk/enroll` が 503 `unavailable` を返す。
   *
   * ここが無いと `FALLBACK_ERROR`（「URLが無効か期限切れです／**管理画面で再発行してください**」・
   * `retryable: false`）へ落ち、**嘘の原因と嘘の対処**を出す —— 指示どおり再発行しようとしても
   * 発行側（`issueEnrollmentToken`）が同じ鍵で落ちるので、設置者は袋小路をループする。
   * 担当者側（`staff-failure.ts` の `unavailable`）と同じ意味・同じ語彙に揃える。
   */
  unavailable: {
    title: 'サーバー側の問題で登録できません',
    detail: '時間をおいても直らない場合は、管理者へ連絡してください。',
    retryable: true,
  },
};

function toError(code: string): Phase {
  const m = ERROR_MESSAGE[code] ?? FALLBACK_ERROR;
  return { kind: 'error', title: m.title, detail: m.detail, retryable: m.retryable };
}

export default function KioskEnrollPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'working' });

  const enroll = useCallback(async () => {
    setPhase({ kind: 'working' });
    // 既にエンロール済み（kiosk セッション保持）なら、使い捨てトークンを再消費せず受付画面へ。
    // これがないと、URL をホーム画面ブックマークした端末が再起動のたびに consume 済みトークンを
    // 叩いて 409 'used' で締め出される。
    try {
      const status = await fetch('/api/kiosk/session-status', { cache: 'no-store' });
      if (status.ok && ((await status.json()) as { authorized?: boolean }).authorized) {
        router.replace('/kiosk');
        return;
      }
    } catch {
      // セッション確認に失敗しても通常のエンロールへフォールスルー。
    }

    // useSearchParams は Suspense 境界を要するため、ここでは location から直接読む。
    const token = new URLSearchParams(window.location.search).get('token') ?? '';
    if (!token) {
      setPhase(toError('missing'));
      return;
    }
    try {
      const res = await fetch('/api/kiosk/enroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        router.replace('/kiosk');
        return;
      }
      // 🔴 **まず status で判定する (#1123)。** 本文の `error` 文字列だけを見ると、
      // **本文が JSON でない 5xx が全部 `invalid_token` へ落ちる** ——
      // 「URLが無効か期限切れです／管理画面で再発行してください」＋再試行ボタン無し、
      // という**嘘の原因と嘘の対処**になり、再発行しても発行側が同じ鍵で落ちて袋小路になる。
      //
      // これは仮定ではない: CloudFront は 502 / 504 を **HTML の hold page** で返すし
      // （`infra/lib/stacks/web-stack.ts` の `errorResponses`）、Next の既定 500 も HTML である。
      // 🔴 **述語は共有する（`isServerSideFailure`）。** 同じ境界を 2 か所に手書きすると、
      // 片方のテストがもう片方を縛らない —— 最初はそうしており、受付端末側は 502/503 しか
      // 踏まず `>= 501` への変異が素通りした（レビュー 3 周目の実測）。
      if (isServerSideFailure(res.status)) {
        setPhase(toError('unavailable'));
        return;
      }
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setPhase(toError(data?.error ?? 'invalid_token'));
    } catch {
      setPhase(toError('network'));
    }
  }, [router]);

  useEffect(() => {
    void enroll();
  }, [enroll]);

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-lg)',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-lg)',
        textAlign: 'center',
      }}
    >
      {phase.kind === 'working' ? (
        <p data-testid="enroll-working" style={{ fontSize: '1.25rem', opacity: 0.85 }}>
          受付端末を準備しています…
        </p>
      ) : (
        <div
          data-testid="enroll-error"
          // 失敗を支援技術へ**提示する**（`docs/handoff-2026-08-26.md` の失敗 3 ——
          // 「`aria-live` を見て**読み上げている**と主張する」は別物なので、そう書かない）。
          // 🔴 **この要素は error のときに DOM へ挿入される**ので、live region として
          // 実際に告知されるかは支援技術依存である。常時マウントへ直す案は #1130
          // （担当者側の `StaffResponseActions` も同じ条件マウントで、対は揃っていない）。
          role="status"
          style={{ maxWidth: 480, display: 'grid', gap: 'var(--space-md)', wordBreak: 'keep-all' }}
        >
          <h1 style={{ fontSize: '1.6rem', margin: 0 }}>{phase.title}</h1>
          <p style={{ opacity: 0.85, margin: 0 }}>{phase.detail}</p>
          {phase.retryable ? (
            <button
              data-testid="enroll-retry"
              onClick={() => void enroll()}
              style={{
                minHeight: 'var(--touch-target-min)',
                padding: '0 24px',
                borderRadius: 'var(--radius-lg)',
                border: '1px solid rgba(255,255,255,0.2)',
                background: 'var(--color-surface)',
                color: 'var(--color-text)',
                fontWeight: 700,
                fontSize: '1.05rem',
                cursor: 'pointer',
              }}
            >
              再試行
            </button>
          ) : null}
        </div>
      )}
    </main>
  );
}
