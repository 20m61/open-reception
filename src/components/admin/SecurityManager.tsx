'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Field, Form, SaveFeedback, saveFailureMessage, useSaveFeedback } from '@/components/admin/ui';
import { space } from '@/components/admin/ui/tokens';
import { AdminReadGate } from './AdminReadGate';

type SecurityView = { pinRequired: boolean; ipAllowlist: string[]; pinConfigured: boolean; emergencyStop: boolean };

/**
 * 緊急停止の送信に張る締切 (#973)。応答が返らない経路でボタンが恒久的に無効化されるのを防ぐ。
 * 一覧取得（`use-site-list.ts` の `SITE_LIST_TIMEOUT_MS`）と同じ長さに合わせてある。
 */
const EMERGENCY_TIMEOUT_MS = 10_000;

/** セキュリティ設定 (issue #23, #29)。PIN 必須・PIN 変更・IP 許可リストを編集する。 */
export function SecurityManager() {
  const [view, setView] = useState<SecurityView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pinRequired, setPinRequired] = useState(false);
  const [pin, setPin] = useState('');
  const [ipText, setIpText] = useState('');
  const [busy, setBusy] = useState(false);
  const { feedback, success, failure, clear } = useSaveFeedback();
  const [confirmingEmergency, setConfirmingEmergency] = useState(false);
  /**
   * 緊急停止は**フォームの保存とは別の系統**として持つ (#973)。
   *
   * 同じ `feedback` に相乗りさせると、結果が画面の下端（フォーム内）にしか出ない。
   * 緊急停止のトグルは画面の最上部なので、**視線導線の上にあるトグルが嘘をつき、
   * 下に本当のことが書いてある**という並びになる（独立レビュー MAJOR-1）。
   */
  const {
    feedback: emergencyFeedback,
    success: emergencySucceeded,
    // 🔴 名前は `fetch-failure-scan` の**閉じた語彙**に合わせる（`set…Failed`）。
    // `emergencyFailed` と綴ると走査が「報告していない」と数え、台帳が実態から離れる。
    failure: setEmergencyFailed,
    clear: clearEmergencyFeedback,
  } = useSaveFeedback();
  /** 緊急停止の送信中。**押下から確定までの窓**を無言にしない（独立レビュー MAJOR-4）。 */
  const [emergencyBusy, setEmergencyBusy] = useState(false);
  /**
   * 応答は 200 だったのに本文を読めず、**表示へ反映できなかった**。
   *
   * 🔴 これは「保存の結果」ではなく**表示の性質**なので、保存フィードバックに載せない
   * （載せると、あとで取り直して新しくなっても文言が残る。独立レビュー 2 周目 MINOR-3）。
   */
  const [viewStale, setViewStale] = useState(false);

  /** 取得した（あるいは書き込みが返した）状態を画面へ載せる。 */
  const applyView = useCallback((v: SecurityView) => {
    setView(v);
    setPinRequired(v.pinRequired);
    setIpText(v.ipAllowlist.join('\n'));
    setLoadFailed(false);
    setViewStale(false);
  }, []);

  /**
   * 初回取得と再試行。**書き込みの後には呼ばない。**
   *
   * 🔴 **書き込みの後にもう一度取りに行かない**（独立レビュー 2 周目 MAJOR-A/B）。
   * `PUT /api/admin/security` は更新後の `SecurityView` をそのまま返すので、2 度目の往復は
   * 情報を増やさずに**壊れ方だけ増やす**:
   *
   * - GET が失敗すると、直前に出した「保存できたか分かりません」を「表示が古いかも」で
   *   上書きしてしまい、**要求が届いていない可能性が画面から消える**
   * - 逆に PUT が成功していても、GET の失敗で確定した真が「不明」へ格下げされる
   * - 2 本の `load()` が競合すると、遅い方が勝ってトグルが巻き戻る
   *
   * 応答本体を採ればどれも起きない。ここに残るのは「まだ何も無い」ときの取得だけである。
   */
  const load = useCallback(async () => {
    // `catch` を省くとオフラインで例外になり、`void load()` が握り潰して
    // **失敗にすら落ちない**（画面は「読み込み中…」のまま固まる）。
    const res = await fetch('/api/admin/security').catch(() => null);
    if (!res?.ok) {
      setLoadFailed(true);
      return;
    }
    const v = (await res.json().catch(() => null)) as SecurityView | null;
    if (v === null) {
      setLoadFailed(true);
      return;
    }
    applyView(v);
  }, [applyView]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    clear();
    // 「応答が届いたか」を持つ。`catch` は fetch の reject と、届いた後の例外の
    // **両方**を拾うので、綴りだけでは区別できない。
    let reached = false;
    try {
      const ipAllowlist = ipText.split('\n').map((s) => s.trim()).filter(Boolean);
      const body: Record<string, unknown> = { pinRequired, ipAllowlist };
      if (pin.trim() !== '') body.pin = pin.trim();
      const res = await fetch('/api/admin/security', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      reached = true;
      if (!res.ok) {
        failure();
        return;
      }
      setPin('');
      // 🔴 **応答本体を表示にする**（`load()` で取り直さない。上の `load` の解説を見ること）。
      applyView((await res.json()) as SecurityView);
      success();
    } catch {
      // 応答が**届いたのか**で言い分けを変える。`reached` の後に throw しうるのは
      // `res.json()`（200 だが本文が壊れている）で、そこまで「接続できませんでした」に
      // 丸めると、保存できているのに運用者を通信の調査へ行かせる。
      failure(saveFailureMessage(reached ? 'unreadable' : 'unreachable'));
    } finally {
      setBusy(false);
    }
  }, [busy, ipText, pinRequired, pin, applyView, success, failure, clear]);

  const setEmergency = useCallback(
    async (emergencyStop: boolean) => {
      if (emergencyBusy) return;
      setConfirmingEmergency(false);
      setEmergencyBusy(true);
      clearEmergencyFeedback();
      /*
        **緊急停止は結果を確かめる。** それまでは応答を見ずに `load()` していたので、
        403 / 5xx でもオフラインでも「押したのに何も言われない」だけになり、運用者は
        **止めたつもりで止まっていない**状態に置かれる（受付を止める操作なので、
        取り違えの代償が最も大きい）。
      */
      /*
        🔴 **締切を張る。** 応答が返らない経路（キャプティブポータル・half-open TCP・
        LB のブラックホール）では `emergencyBusy` が真のまま固定され、**停止も再開も
        押せない画面**になる。復帰手段が再読み込みだけになるが、通信が半死のときは
        それ自体が成功しない —— `use-site-list.ts` が一覧取得で踏んで対策済みの型で、
        受付を止める操作はそれより止まってはいけない（独立レビュー 2 周目 MAJOR-E）。
      */
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), EMERGENCY_TIMEOUT_MS);
      let reached = false;
      try {
        const res = await fetch('/api/admin/security', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ emergencyStop }),
          signal: controller.signal,
        });
        reached = true;
        if (!res.ok) {
          setEmergencyFailed(
            emergencyStop ? '緊急停止を有効にできませんでした。' : '緊急停止を解除できませんでした。',
          );
          return;
        }
        /*
          🔴 **応答本体でトグルを更新する**（`load()` で取り直さない）。
          取り直すと、GET が失敗したときに直前の結論（届いていないかもしれない／
          確かに止めた）を「表示が古いかも」で**上書きして消して**しまう
          （独立レビュー 2 周目 MAJOR-A）。ここでは編集中のフォーム（IP 許可リスト・
          PIN 必須）へは触らない —— 押していない入力を書き換えない。
        */
        const applied = (await res.json().catch(() => null)) as SecurityView | null;
        if (applied === null) {
          // 200 なので**適用はされている**。反映できなかったのは表示のほうだと言う。
          setViewStale(true);
        } else {
          setView(applied);
          setViewStale(false);
        }
        emergencySucceeded(emergencyStop ? '緊急停止を有効にしました。' : '緊急停止を解除しました。');
      } catch {
        setEmergencyFailed(saveFailureMessage(reached ? 'unreadable' : 'unreachable'));
      } finally {
        clearTimeout(deadline);
        setEmergencyBusy(false);
      }
    },
    [emergencyBusy, clearEmergencyFeedback, emergencySucceeded, setEmergencyFailed],
  );

  if (!view) {
    return (
      <AdminReadGate
        heading="セキュリティ設定"
        failed={loadFailed}
        failureMessage="セキュリティ設定を取得できませんでした。通信状況を確認して再試行してください。"
        onRetry={() => void load()}
        testId="security-unavailable"
      />
    );
  }

  return (
    <section style={{ maxWidth: 480 }}>
      <h1 style={{ marginTop: 0 }}>セキュリティ設定</h1>

      <div
        data-testid="emergency-section"
        className={view.emergencyStop ? 'notice notice--danger' : 'notice notice--warning'}
        style={{ marginBottom: 24 }}
      >
        <strong>緊急停止モード</strong>
        <p style={{ margin: '8px 0' }} data-testid="emergency-state">
          現在: {view.emergencyStop ? '停止中（全端末で受付を停止）' : '通常稼働'}
        </p>
        {view.emergencyStop ? (
          <Button
            variant="primary"
            data-testid="emergency-resume"
            onClick={() => void setEmergency(false)}
            disabled={emergencyBusy}
          >
            {emergencyBusy ? '送信中…' : '受付を再開する'}
          </Button>
        ) : confirmingEmergency ? (
          <div style={{ display: 'flex', gap: space.sm }}>
            <Button
              variant="danger"
              data-testid="emergency-confirm"
              onClick={() => void setEmergency(true)}
              disabled={emergencyBusy}
            >
              {emergencyBusy ? '送信中…' : '本当に全端末を停止する'}
            </Button>
            <Button data-testid="emergency-cancel" onClick={() => setConfirmingEmergency(false)} disabled={emergencyBusy}>
              やめる
            </Button>
          </div>
        ) : (
          <Button
            variant="danger"
            data-testid="emergency-stop"
            onClick={() => setConfirmingEmergency(true)}
            disabled={emergencyBusy}
          >
            {emergencyBusy ? '送信中…' : '緊急停止する'}
          </Button>
        )}
        {/*
          🔴 **押下から確定までの窓を無言にしない**（独立レビュー MAJOR-4）。
          冒頭で `confirmingEmergency` を false へ戻すので、確認ボタンは即座に消える。
          オフラインの iPad では reject まで数十秒かかることがあり、何も出ないと
          **やめたのと区別が付かない** —— 緊急時に運用者を待たせたまま迷わせる。
        */}
        {emergencyBusy ? (
          <p data-testid="emergency-pending" role="status" aria-live="polite" style={{ margin: '8px 0 0' }}>
            全端末へ送信しています…
          </p>
        ) : null}
        <div style={{ marginTop: space.sm }}>
          <SaveFeedback
            feedback={emergencyFeedback}
            successTestId="emergency-saved"
            errorTestId="emergency-error"
          />
        </div>
        {/*
          🔴 **「表示が古い」は保存の結果ではなく view の性質**なので、保存フィードバックに
          載せず独立して持つ（載せると、次の取得で新しくなっても文言が残る。
          独立レビュー 2 周目 MINOR-3）。適用そのものは 200 で確定しているので、
          ここで言うのは「反映できなかった」だけである。
        */}
        {viewStale ? (
          <p data-testid="security-view-stale" role="status" aria-live="polite" style={{ margin: '8px 0 0' }}>
            適用しましたが、最新の状態を表示に反映できませんでした。画面を再読み込みして確かめてください。
          </p>
        ) : null}
      </div>

      <Form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: space.md }}>
        <label style={{ display: 'flex', gap: space.sm, alignItems: 'center' }}>
          <input
            type="checkbox"
            data-testid="security-pin-required"
            checked={pinRequired}
            onChange={(e) => setPinRequired(e.target.checked)}
          />
          受付端末の表示に PIN 許可を必須にする
        </label>
        <Field
          label={`PIN を変更（空欄なら変更しない／現在: ${view.pinConfigured ? '設定済み' : '未設定'}）`}
          htmlFor="security-pin"
        >
          <input type="password" id="security-pin" data-testid="security-pin" value={pin} onChange={(e) => setPin(e.target.value)} style={input} />
        </Field>
        <Field label="IP 許可リスト（1 行に 1 件、空なら全許可）" htmlFor="security-ip">
          <textarea id="security-ip" data-testid="security-ip" value={ipText} onChange={(e) => setIpText(e.target.value)} rows={4} style={input} />
        </Field>
        <div style={{ display: 'flex', gap: space.sm, alignItems: 'center' }}>
          <Button variant="primary" type="submit" data-testid="security-save" disabled={busy}>
            保存
          </Button>
          <SaveFeedback feedback={feedback} successTestId="security-saved" errorTestId="security-error" />
        </div>
      </Form>
    </section>
  );
}

const input: React.CSSProperties = {
  minHeight: 40,
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--color-surface-2)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
};
