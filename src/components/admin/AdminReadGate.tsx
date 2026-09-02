import { Button, EmptyState, color } from '@/components/admin/ui';
import { resolveAdminReadState } from './read-state';

/**
 * テナント単位の設定画面で「まだ読めていない」を描く門 (#870 増分 04)。
 *
 * ## なぜ共有するか
 *
 * 6 画面が同じ形の欠陥を持っていた —— `if (!x) return <p>読み込み中…</p>` で門を閉じ、
 * 読み取りの失敗を「読み込み中…」と表示していた。運用者は**終わらない待ち**に入り、
 * 何が起きたのかも再試行の手段も画面に無い。**同じ欠陥は `SignageManager` と
 * `StaffResponseManager` で修正済みで、理由まで書いてあった**のに伝播していなかった。
 * 各画面が自前で分岐を書き続ける限り、次に画面を足す人がまた同じ穴を開ける。
 *
 * 拠点別画面は判断材料が多い（どのスコープのデータが載っているか・拠点一覧そのものが
 * 読めたか）ので `./scope-gate.ts` の `resolveScopeGate` を使う。ここは拠点の次元を持たない
 * 設定画面向けの最小版で、そうした画面が `resolveScopeGate` の入力を偽装しなくて済むように
 * 分けてある。
 *
 * ## 使い方: **早期 return の位置で使う**
 *
 * ```tsx
 * if (!settings) {
 *   return <AdminReadGate heading="音声設定" failed={loadFailed} … />;
 * }
 * ```
 *
 * children を包む形にしていないのは、多くの画面が門の**後ろ**で値を参照しており
 * （`settings.foo`）、TypeScript の絞り込みには早期 return が要るため。包む形にすると
 * 各画面に `settings!` が生えて、型で守れていたものを崩す。
 *
 * ## 失敗表示に再試行を必ず添える
 *
 * 理由だけ出して手段を出さないと、運用者に残るのは画面リロードだけになる。
 * 既存プリミティブ（`EmptyState` + `Button`）で組み、新しい見た目を増やさない。
 */
export function AdminReadGate({
  heading,
  failed,
  failureMessage,
  onRetry,
  retryDisabled = false,
  testId,
}: {
  /** 画面見出し。読めていない間も出す（何の画面で待たされているか分かるように）。 */
  heading: string;
  /** 直近の読み取りが失敗したか（HTTP エラー・オフラインの双方）。 */
  failed: boolean;
  /** 失敗時の本文。画面ごとに「何が」取れなかったかを書く。 */
  failureMessage: string;
  onRetry: () => void;
  retryDisabled?: boolean;
  /** 失敗表示の testid。e2e が画面ごとに引けるようにする。 */
  testId: string;
}) {
  // ここへ来るのは「載っていない」ときだけ。残りは「まだ」か「だめだった」かの区別。
  const state = resolveAdminReadState({ loaded: false, failed });

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>{heading}</h1>
      {state === 'failed' ? (
        <EmptyState
          testId={testId}
          title="読み込めませんでした"
          message={failureMessage}
          action={
            <Button data-testid={`${testId}-retry`} onClick={onRetry} disabled={retryDisabled}>
              再試行
            </Button>
          }
        />
      ) : (
        <p style={{ color: color.muted }}>読み込み中…</p>
      )}
    </section>
  );
}
