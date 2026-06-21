'use client';

/**
 * 例外対応用の Chat-assisted ドロワー (issue #122 / Epic #119)。
 *
 * 方針（Touch-first / Chat-assisted）:
 *  - 主導線はタッチUI。本ドロワーは「お困りですか？」程度の控えめな補助で、必要時に開く。
 *  - チャット返答の下には必ずタッチ可能なクイックリプライ/カードを出す（chat-logic が保証）。
 *  - 自由文の結果は直接実行せず、候補提示＋タッチ確認に変換する。
 *  - 実行できるアクションは ui-contract の `isChatActionAllowed` に限定（chat-logic 経由）。
 *    呼び出し確定・個人情報確定はチャットから確定不可（confirm-redirect でタッチ確認へ誘導）。
 *  - LLM は差し替え可能 adapter + mock（実 LLM は呼ばない / #104 整合 / 実検証は #65）。
 *  - オフライン/失敗時は定型 FAQ/固定導線へフォールバックする。
 *  - 会話履歴・入力は完了後に残さない（PII を保持しない）。
 *
 * スタンドアロン: KioskFlow への配線は後続（#121 のスロット or オーケストレータ）に委ねる。
 * 本コンポーネントは props 経由でのみ受付状態とコールバックを受け取り、自前で状態を進めない。
 * スタイルはコンポーネント内に閉じる（globals.css は編集しない）。
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReceptionAction, ReceptionState } from '@/domain/reception/ui-contract';
import {
  buildGreetingMessage,
  clearOnComplete,
  runChatTurn,
  type ChatTurnResult,
  type QuickReply,
} from './chat/chat-logic';
import { MockChatLlmAdapter, type ChatLlmAdapter } from './chat/llm-adapter';

export type KioskChatDrawerProps = {
  /** 現在の受付状態。許可アクション判定の文脈に使う。 */
  screenState: ReceptionState;
  /** 補助ドロワーを開けるか（ui-contract の deriveChatAvailability から渡す想定）。 */
  available: boolean;
  /**
   * 許可済みアクションをタッチ確定したときのコールバック。
   * 実際の状態遷移は呼び出し側（KioskFlow）が所有する。本ドロワーは確定しない。
   * optionId は選択値の不透明識別子（staffId / purposeId 等。PII を含めない）。
   */
  onAction: (action: ReceptionAction, optionId?: string) => void;
  /** 「スタッフに繋ぐ」等の固定導線/フォールバックを選んだとき。 */
  onRequestStaff: () => void;
  /**
   * 重要操作（呼び出し確定・個人情報確定）への誘導をタッチしたとき。
   * チャットからは確定できないため、タッチUIの確認画面へ誘導する用途。
   */
  onRedirectToConfirm?: (action: ReceptionAction) => void;
  /** LLM アダプタ（差し替え可能）。未指定なら mock を使う（実 LLM は呼ばない）。 */
  adapter?: ChatLlmAdapter;
  /** オンライン状態。false でフォールバックへ倒す（既定 true）。 */
  online?: boolean;
  /** 初期表示で開いておくか（既定 false = 控えめ）。 */
  defaultOpen?: boolean;
};

type DisplayMessage =
  | { id: string; role: 'visitor' | 'assistant'; text: string }
  | { id: string; role: 'turn'; text: string; quickReplies: QuickReply[]; isFallback: boolean };

let turnSeq = 0;

export function KioskChatDrawer({
  screenState,
  available,
  onAction,
  onRequestStaff,
  onRedirectToConfirm,
  adapter,
  online = true,
  defaultOpen = false,
}: KioskChatDrawerProps): React.ReactElement | null {
  const [open, setOpen] = useState(defaultOpen);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const panelId = useId();
  const llm = useMemo(() => adapter ?? new MockChatLlmAdapter(), [adapter]);
  const listEndRef = useRef<HTMLDivElement>(null);

  // 補助が使えない局面（待機/終端）では履歴を残さず閉じる（PII を残さない設計）。
  // 会話履歴は clearOnComplete() の意図どおり完全に破棄する。
  useEffect(() => {
    if (!available) {
      setOpen(false);
      setDraft('');
      setMessages(() => clearOnComplete() as DisplayMessage[]);
    }
  }, [available]);

  // 開いた直後に控えめな呼びかけを 1 件だけ出す。
  useEffect(() => {
    if (open && messages.length === 0) {
      const greet = buildGreetingMessage();
      setMessages([{ id: greet.id, role: 'assistant', text: greet.text }]);
    }
  }, [open, messages.length]);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const appendTurn = useCallback((utterance: string, result: ChatTurnResult) => {
    turnSeq += 1;
    setMessages((prev) => [
      ...prev,
      { id: `visitor-${turnSeq}`, role: 'visitor', text: utterance },
      {
        id: `turn-${turnSeq}`,
        role: 'turn',
        text: result.reply,
        quickReplies: result.quickReplies,
        isFallback: result.isFallback,
      },
    ]);
  }, []);

  const submit = useCallback(async () => {
    const utterance = draft.trim();
    if (utterance === '' || busy) return;
    setBusy(true);
    setDraft('');
    try {
      const result = await runChatTurn(llm, screenState, utterance, { online });
      appendTurn(utterance, result);
    } finally {
      setBusy(false);
    }
  }, [draft, busy, llm, screenState, online, appendTurn]);

  const handleQuickReply = useCallback(
    (qr: QuickReply) => {
      if (qr.kind === 'action') {
        onAction(qr.action, qr.optionId);
        return;
      }
      if (qr.kind === 'confirm-redirect') {
        // チャットからは確定しない。タッチUIの確認画面へ誘導するだけ。
        onRedirectToConfirm?.(qr.action);
        return;
      }
      // 'staff' = 固定導線/フォールバック。
      onRequestStaff();
    },
    [onAction, onRedirectToConfirm, onRequestStaff],
  );

  if (!available) {
    return null;
  }

  const scope = `chatdrawer-${panelId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  return (
    <div className={scope} data-testid="kiosk-chat-drawer" data-open={open}>
      <style>{scopedStyles(scope)}</style>

      {!open && (
        <button
          type="button"
          className={`${scope}__fab`}
          aria-expanded={false}
          aria-controls={panelId}
          onClick={() => setOpen(true)}
        >
          お困りですか？
        </button>
      )}

      {open && (
        <section
          id={panelId}
          className={`${scope}__panel`}
          role="dialog"
          aria-label="受付のお手伝いチャット"
          aria-modal={false}
        >
          <header className={`${scope}__head`}>
            <span className={`${scope}__title`}>お手伝い</span>
            <button
              type="button"
              className={`${scope}__close`}
              aria-label="閉じる"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </header>

          <div className={`${scope}__log`} role="log" aria-live="polite">
            {messages.map((m) =>
              m.role === 'turn' ? (
                <div key={m.id} className={`${scope}__turn`}>
                  <p className={`${scope}__bubble ${scope}__bubble--assistant`}>{m.text}</p>
                  <div className={`${scope}__replies`} role="group" aria-label="次の操作">
                    {m.quickReplies.map((qr, i) => (
                      <button
                        key={`${m.id}-qr-${i}`}
                        type="button"
                        className={`${scope}__reply ${scope}__reply--${qr.kind}`}
                        data-kind={qr.kind}
                        onClick={() => handleQuickReply(qr)}
                      >
                        {qr.label}
                        {qr.kind === 'confirm-redirect' && (
                          <span className={`${scope}__hint`}>（確認画面で操作します）</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <p
                  key={m.id}
                  className={`${scope}__bubble ${scope}__bubble--${m.role}`}
                >
                  {m.text}
                </p>
              ),
            )}
            <div ref={listEndRef} />
          </div>

          <form
            className={`${scope}__form`}
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <input
              className={`${scope}__input`}
              type="text"
              inputMode="text"
              value={draft}
              placeholder="例: 山田さんに会いに来ました"
              aria-label="ご用件を入力"
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button
              type="submit"
              className={`${scope}__send`}
              disabled={busy || draft.trim() === ''}
            >
              送信
            </button>
          </form>
        </section>
      )}
    </div>
  );
}

/**
 * コンポーネントに閉じたスタイル。globals.css を汚さないため一意 scope クラスで限定する。
 * タッチ前提なので各ボタンは十分な高さ（>=48px 相当）を確保する。
 */
function scopedStyles(scope: string): string {
  return `
.${scope} { position: fixed; right: 16px; bottom: 16px; z-index: 40; font-size: 16px; }
.${scope}__fab {
  min-height: 48px; padding: 12px 20px; border-radius: 24px; border: none;
  background: #1f6feb; color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.2); cursor: pointer;
}
.${scope}__panel {
  width: min(360px, 92vw); max-height: min(70vh, 560px); display: flex; flex-direction: column;
  background: #fff; color: #111; border-radius: 16px; box-shadow: 0 8px 32px rgba(0,0,0,.25);
  overflow: hidden;
}
.${scope}__head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; background: #1f6feb; color: #fff;
}
.${scope}__title { font-weight: 600; }
.${scope}__close { background: transparent; border: none; color: #fff; font-size: 22px; min-width: 44px; min-height: 44px; cursor: pointer; }
.${scope}__log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.${scope}__turn { display: flex; flex-direction: column; gap: 8px; }
.${scope}__bubble { margin: 0; padding: 10px 12px; border-radius: 12px; line-height: 1.4; max-width: 90%; }
.${scope}__bubble--assistant { background: #f1f3f5; align-self: flex-start; }
.${scope}__bubble--visitor { background: #d7e7ff; align-self: flex-end; }
.${scope}__replies { display: flex; flex-direction: column; gap: 8px; }
.${scope}__reply {
  text-align: left; min-height: 48px; padding: 12px 14px; border-radius: 12px;
  border: 1px solid #1f6feb; background: #fff; color: #1f6feb; cursor: pointer; font-size: 16px;
}
.${scope}__reply--staff { border-color: #888; color: #333; }
.${scope}__reply--confirm-redirect { border-style: dashed; }
.${scope}__hint { display: block; font-size: 12px; color: #666; margin-top: 2px; }
.${scope}__form { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #eee; }
.${scope}__input { flex: 1; min-height: 48px; padding: 10px 12px; border: 1px solid #ccc; border-radius: 10px; font-size: 16px; }
.${scope}__send { min-height: 48px; padding: 0 16px; border: none; border-radius: 10px; background: #1f6feb; color: #fff; cursor: pointer; }
.${scope}__send:disabled, .${scope}__input:disabled { opacity: .5; cursor: not-allowed; }
`;
}
