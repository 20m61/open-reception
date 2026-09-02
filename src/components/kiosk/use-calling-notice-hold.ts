'use client';

/**
 * 呼び出し中の段階演出 + 予告保持ゲート (#323 AC3 / #826 / #832)。
 *
 * `KioskFlow`（通常受付・ビデオ）と `CheckinFlow`（QR）が同じゲートを使う。判断を
 * 2 か所に書くと、片方だけ直して他方が素通りする形になる（#832 の PSTN がまさにそれだった）。
 *
 * 🔴 **記録は useLayoutEffect、発火は useEffect。** 両方をこのフックに閉じる。片方だけ
 * 親へ残す／別フックへ抜くと、同一コミットのゲートが `noticeShownAtRef === null` を読み、
 * timeout が二度と dispatch されない（#837.2）。layout はすべての passive effect より先に
 * 走るので、呼び出し側の宣言順を契約にしない。
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  advanceCallingStage,
  deriveCallingStage,
  timeoutDispatchGateMs,
  type CallingStage,
  type CallingStageThresholds,
} from '@/domain/reception/calling-experience';

/** 「動いている」演出のための定期更新の上限間隔（ms）。段階境界が近ければもっと短く刻む。 */
const CALLING_TICK_MAX_MS = 500;

export type UseCallingNoticeHoldArgs = {
  /** 呼び出し中か。false なら段も起点も捨てる（次の来訪者へ持ち越さない）。 */
  active: boolean;
  thresholds: CallingStageThresholds;
  /**
   * timeout が確定し、予告保持ゲート待ちの受付。無い間はゲートは何もしない。
   * 🔴 **timeout / unanswered 以外を載せない。** 発火側は未応答として扱う。
   */
  pendingSessionId: string | null;
  /** 保持が満了したとき。sessionId は `pendingSessionId`。 */
  onFire: (sessionId: string) => void;
};

/**
 * 呼び出し中(calling)の経過段階を UI 層のタイマーで導出する (#323)。
 *
 * 「動いている」ことの伝達を優先し、正確な秒数カウントより段階（dialing/waiting/
 * preTimeoutNotice）の切り替えを重視する。次の tick は「段階の境界（waitingAfterMs /
 * noticeAfterMs）」または `CALLING_TICK_MAX_MS` のどちらか近い方に合わせて動的に予約する
 * （固定間隔だと、E2E のようにしきい値を短く上書きしたときに境界を読み飛ばしうるため）。
 *
 * state.ts の遷移表・ui-contract.ts の screenState/avatarState 写像は一切変更しない
 * （ここで導出する段階は見た目の演出のみ）。
 */
function useCallingStage(
  active: boolean,
  startedAtRef: RefObject<number | null>,
  thresholds: CallingStageThresholds,
  /** timeout が確定し予告保持ゲート待ちか (#832)。真なら waiting を飛ばして予告段へ進む。 */
  timeoutPending: boolean,
): { stage: CallingStage; elapsedMs: number } {
  const [elapsedMs, setElapsedMs] = useState(0);
  // 🔴 **到達した最大段を state でラッチする** (#832 5 周目レビュー MAJOR-1)。
  // `deriveCallingStage` は「その瞬間の段」しか返さず、`timeoutPending` が真になった瞬間に
  // `waiting → dialing` へ後退しうる（床が `waitingAfterMs` を上回る設定。テナントは 100ms
  // まで下げられる）。生で出すと来訪者は逆行するちらつきを見て、保持も数え直しになる。
  //
  // ref ではなく state に置くのは、**レンダー中に ref を読み書きできない**ため
  // （`react-hooks/refs`。最初 ref で書いて lint に落とされた）。更新は必ず tick の中で、
  // 関数更新でラッチする。`calling` を抜けたら捨てる（次の受付へ持ち越さない）。
  const [latchedStage, setLatchedStage] = useState<CallingStage>('dialing');
  useEffect(() => {
    if (!active) {
      setLatchedStage('dialing');
      setElapsedMs(0);
      return;
    }
    let timer = 0;
    const tick = () => {
      const startedAt = startedAtRef.current;
      const elapsed = startedAt !== null ? Math.max(0, Date.now() - startedAt) : 0;
      setElapsedMs(elapsed);
      setLatchedStage((previous) =>
        advanceCallingStage(previous, deriveCallingStage(elapsed, thresholds, { timeoutPending })),
      );
      const nextBoundaryMs =
        elapsed < thresholds.waitingAfterMs
          ? thresholds.waitingAfterMs
          : elapsed < thresholds.noticeAfterMs
            ? thresholds.noticeAfterMs
            : null;
      const untilBoundaryMs = nextBoundaryMs === null ? Infinity : Math.max(0, nextBoundaryMs - elapsed);
      const delay = Math.min(
        CALLING_TICK_MAX_MS,
        Number.isFinite(untilBoundaryMs) ? untilBoundaryMs + 10 : CALLING_TICK_MAX_MS,
      );
      timer = window.setTimeout(tick, delay);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [active, startedAtRef, thresholds, timeoutPending]);
  return { stage: latchedStage, elapsedMs };
}

export function useCallingNoticeHold({
  active,
  thresholds,
  pendingSessionId,
  onFire,
}: UseCallingNoticeHoldArgs): { stage: CallingStage; elapsedMs: number } {
  const startedAtRef = useRef<number | null>(null);
  useEffect(() => {
    startedAtRef.current = active ? Date.now() : null;
  }, [active]);

  const thresholdsRef = useRef(thresholds);
  useEffect(() => {
    thresholdsRef.current = thresholds;
  }, [thresholds]);

  const onFireRef = useRef(onFire);
  useEffect(() => {
    onFireRef.current = onFire;
  });

  const callingStageState = useCallingStage(
    active,
    startedAtRef,
    thresholds,
    pendingSessionId !== null,
  );

  const noticeShownAtRef = useRef<number | null>(null);
  // 予告段階を「描画した」瞬間を記録する (#826 / #837.2)。calling を抜けたら起点を捨てる。
  useLayoutEffect(() => {
    if (!active) {
      // 🔴 **この分岐は下の「段が予告以外なら捨てる」と冗長である**（実測: この行だけを消しても
      // e2e 34・unit 317 が全部通る）。`calling` を抜けるとラッチが `dialing` へ戻るので、
      // 下の分岐が必ず拾うため。**変異が生き残るのはテストの穴ではなく、二重に守っているから**
      // ―― 次に測る人が「穴」と誤判定しないように書いておく。
      noticeShownAtRef.current = null;
      return;
    }
    if (callingStageState.stage !== 'preTimeoutNotice') {
      // 段が予告以外なら起点を捨てる。
      //
      // 🔴 **ラッチ導入後、`calling` 中の逆行は原理的に起こらない**（#832。壁時計の巻き戻しも
      // `advanceCallingStage` が吸収する）。この分岐が実際に効くのは `calling` へ入った直後
      // （まだ予告に達していない）だけである。
      noticeShownAtRef.current = null;
      return;
    }
    if (noticeShownAtRef.current === null) {
      noticeShownAtRef.current = Date.now();
    }
  }, [active, callingStageState.stage]);

  // 予告保持ゲート (#323 AC3 / #826)。予告を実際に描画してから noticeMinDurationMs 経つまで
  // 発火しない。未描画（gate=null）の間は何もせず、描画されると stage の変化で再評価される。
  useEffect(() => {
    if (!active || pendingSessionId === null) return;
    const gateMs = timeoutDispatchGateMs(
      noticeShownAtRef.current,
      Date.now(),
      thresholdsRef.current,
    );
    if (gateMs === null) return;
    const fire = () => onFireRef.current(pendingSessionId);
    if (gateMs <= 0) {
      fire();
      return;
    }
    const timer = window.setTimeout(fire, gateMs);
    return () => window.clearTimeout(timer);
  }, [active, pendingSessionId, callingStageState.stage]);

  return callingStageState;
}
