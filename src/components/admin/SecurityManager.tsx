'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Field, Form, SaveFeedback, saveFailureMessage, useSaveFeedback } from '@/components/admin/ui';
import { space } from '@/components/admin/ui/tokens';
import { AdminReadGate } from './AdminReadGate';

type SecurityView = { pinRequired: boolean; ipAllowlist: string[]; pinConfigured: boolean; emergencyStop: boolean };

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
   * 取得し直す。**成否を返す。**
   *
   * 🔴 `loadFailed` を描くのは `if (!view)` の枝だけで、`view` は初回取得後に `null` へ
   * 戻らない。つまり**2 回目以降の取得失敗は画面のどこにも出ない**ので、呼び出し側が
   * 「表示はサーバの状態を映している」と言い張れないことを知る必要がある
   * （独立レビュー MAJOR-1）。
   */
  const load = useCallback(async (): Promise<boolean> => {
    // `catch` を省くとオフラインで例外になり、`void load()` が握り潰して
    // **失敗にすら落ちない**（画面は「読み込み中…」のまま固まる）。
    const res = await fetch('/api/admin/security').catch(() => null);
    if (!res?.ok) {
      setLoadFailed(true);
      return false;
    }
    // 本文が壊れていると `json()` が throw する。呼び出し側（`finally` の中を含む）へ
    // 例外を投げ返すと unhandled rejection になるので、ここで失敗として畳む。
    const v = (await res.json().catch(() => null)) as SecurityView | null;
    if (v === null) {
      setLoadFailed(true);
      return false;
    }
    setView(v);
    setPinRequired(v.pinRequired);
    setIpText(v.ipAllowlist.join('\n'));
    setLoadFailed(false);
    return true;
  }, []);

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
      if (res.ok) {
        setPin('');
        success();
        await load();
      } else {
        failure();
      }
    } catch {
      // 応答が**届いたのか**で言い分けを変える。届いた後の例外（本文が壊れている・
      // `load()` の中）まで「接続できませんでした」に丸めると、保存できているのに
      // 運用者を通信の調査へ行かせる（独立レビュー MINOR）。
      failure(saveFailureMessage(reached ? 'unreadable' : 'unreachable'));
    } finally {
      setBusy(false);
    }
  }, [busy, ipText, pinRequired, pin, load, success, failure, clear]);

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
      let reached = false;
      try {
        const res = await fetch('/api/admin/security', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ emergencyStop }),
        });
        reached = true;
        if (res.ok) {
          emergencySucceeded(emergencyStop ? '緊急停止を有効にしました。' : '緊急停止を解除しました。');
        } else {
          setEmergencyFailed(
            emergencyStop ? '緊急停止を有効にできませんでした。' : '緊急停止を解除できませんでした。',
          );
        }
      } catch {
        setEmergencyFailed(saveFailureMessage(reached ? 'unreadable' : 'unreachable'));
      } finally {
        /*
          🔴 **取り直せなかったら、そう言う。**

          下のトグルは `view.emergencyStop` を映すが、`load()` が失敗しても `view` は
          前の値のまま残り、`loadFailed` は `if (!view)` の枝にしか出ない。黙って戻ると
          「緊急停止を有効にしました」と書いてあるすぐ上で**トグルが「通常稼働」と言う**
          （解除側はもっと悪く、成功したのに「停止中」が残って次に見た人が読み違える）。
          成功の報告を**上書きして**、表示が当てにならないことを先に伝える。
        */
        if (!(await load())) {
          setEmergencyFailed(
            '現在の状態を取得できませんでした。上の表示は古い可能性があります。画面を再読み込みして確かめてください。',
          );
        }
        setEmergencyBusy(false);
      }
    },
    [emergencyBusy, load, clearEmergencyFeedback, emergencySucceeded, setEmergencyFailed],
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
