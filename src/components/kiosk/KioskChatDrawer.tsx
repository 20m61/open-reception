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
 * スタイルはコンポーネントに閉じた CSS Modules（globals.css は編集しない）。
 * inline `<style>` は CSP style-src 'self'（#289）でブロックされるため使わない。
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import styles from './KioskChatDrawer.module.css';
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
  /**
   * 外部（例: 検索 0 件時の誘導ボタン）からドロワーを開かせる合図 (issue #322)。
   * 値が増えるたびに開く（内容は問わない。単調増加のカウンタを想定）。未指定なら外部起動なし。
   */
  openSignal?: number;
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
  openSignal,
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

  // 外部からの開く合図（値が変わるたび）。0/undefined は初期値のため無視し、増加のみで開く (issue #322)。
  const prevOpenSignalRef = useRef(openSignal);
  useEffect(() => {
    if (
      available &&
      openSignal !== undefined &&
      openSignal !== prevOpenSignalRef.current
    ) {
      setOpen(true);
    }
    prevOpenSignalRef.current = openSignal;
  }, [openSignal, available]);

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

  return (
    <div className={styles.root} data-testid="kiosk-chat-drawer" data-open={open}>
      {!open && (
        <button
          type="button"
          className={styles.fab}
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
          className={styles.panel}
          role="dialog"
          aria-label="受付のお手伝いチャット"
          aria-modal={false}
        >
          <header className={styles.head}>
            <span className={styles.title}>お手伝い</span>
            <button
              type="button"
              className={styles.close}
              aria-label="閉じる"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </header>

          <div className={styles.log} role="log" aria-live="polite">
            {messages.map((m) =>
              m.role === 'turn' ? (
                <div key={m.id} className={styles.turn}>
                  <p className={`${styles.bubble} ${styles.bubbleAssistant}`}>{m.text}</p>
                  <div className={styles.replies} role="group" aria-label="次の操作">
                    {m.quickReplies.map((qr, i) => (
                      <button
                        key={`${m.id}-qr-${i}`}
                        type="button"
                        className={replyClassName(qr.kind)}
                        data-kind={qr.kind}
                        onClick={() => handleQuickReply(qr)}
                      >
                        {qr.label}
                        {qr.kind === 'confirm-redirect' && (
                          <span className={styles.hint}>（確認画面で操作します）</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <p key={m.id} className={`${styles.bubble} ${bubbleModifier[m.role]}`}>
                  {m.text}
                </p>
              ),
            )}
            <div ref={listEndRef} />
          </div>

          <form
            className={styles.form}
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <input
              className={styles.input}
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
              className={styles.send}
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

/** 吹き出しの話者別モディファイア（旧 `__bubble--<role>`）。 */
const bubbleModifier: Record<'assistant' | 'visitor', string> = {
  assistant: styles.bubbleAssistant ?? '',
  visitor: styles.bubbleVisitor ?? '',
};

/** クイックリプライの種類別クラス（旧 `__reply--<kind>`。action は基本スタイルのみ）。 */
function replyClassName(kind: QuickReply['kind']): string {
  const modifier =
    kind === 'staff' ? styles.replyStaff : kind === 'confirm-redirect' ? styles.replyConfirmRedirect : undefined;
  return modifier ? `${styles.reply} ${modifier}` : (styles.reply ?? '');
}
