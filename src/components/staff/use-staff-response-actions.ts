'use client';

/**
 * この受付で**担当者が選べる応答種別**を取る (#99 / #1137)。
 *
 * ## なぜ `StaffResponseActions` から持ち上げたか
 *
 * 🔴 **文言と画面が同じ事実を見るようにするため (#1137)。**
 * `staffCallFailureMessage('unreachable')` は「下の応答からの返答も試せます」と
 * `StaffResponseActions` を名指しする。ところが取得結果はその子の中の state にしかなく、
 * **文言を作る側からは「ボタンが 0 個かどうか」が見えなかった** ——
 * サイト設定で応答種別を全部無効化していると、文言が**空の領域を指す**。
 * 担当者は画面下を探しに行き、その間**来訪者は呼び出しが成立したまま待つ**
 * （answer API は 200 を返し終えている）。
 *
 * **取得元を 1 つにして、文言と描画の両方へ同じ値を配る。** 兄弟間で state を
 * 同期させる機構（callback prop 等）は足さない —— 持ち上げれば要らない。
 */
import { useEffect, useState } from 'react';
import {
  listStaffResponseDefinitions,
  type StaffResponseAction,
  type StaffResponseSeverity,
} from '@/domain/reception/staff-response';

/** 担当者ボタンに必要な最小メタ（GET /respond の応答形）。来訪者文言・PII は含まない。 */
export type ActionMeta = {
  action: StaffResponseAction;
  staffLabel: string;
  severity: StaffResponseSeverity;
  requiresConfirmation: boolean;
  enabled: boolean;
};

/** 設定取得前/失敗時のフォールバック: ドメイン既定（defaultEnabled）から組み立てる。 */
function defaultActionMeta(): ActionMeta[] {
  return listStaffResponseDefinitions().map((d) => ({
    action: d.action,
    staffLabel: d.staffLabel,
    severity: d.severity,
    requiresConfirmation: d.requiresConfirmation,
    enabled: d.defaultEnabled,
  }));
}

/**
 * GET の応答から応答種別の一覧を読む。**読めなければ `null`**（＝既定のまま据え置く）。
 *
 * 🔴 **純関数へ切り出した理由（レビュー 1 周目 MINOR 2）。** 以前は `Array.isArray` の
 * ガードを `useEffect` の中に直接書いていたため、**そのガードを落とす変異が生存した**
 * （e2e も unit も素通り。hook は `fetch` を注入していないので unit で踏めない）。
 * ガードが守るのは「配列でない応答で `filter` が throw し、**担当者画面が丸ごと落ちる**」
 * ことなので、**守る対象がある機構**である。切り出せば最も安い層で縛れる。
 */
export function parseActions(data: unknown): ActionMeta[] | null {
  if (typeof data !== 'object' || data === null) return null;
  const actions = (data as { actions?: unknown }).actions;
  return Array.isArray(actions) ? (actions as ActionMeta[]) : null;
}

/**
 * 有効な応答種別が 1 件以上あるか。
 *
 * 🔴 **`length > 0` ではなく `enabled` を見る。** 取得結果は無効な種別も含むので、
 * 件数だけを見ると「全部無効なのに在ることになる」形になる（#1137 そのもの）。
 */
export function hasEnabledResponses(actions: ReadonlyArray<ActionMeta>): boolean {
  return actions.some((a) => a.enabled);
}

/**
 * この受付で有効な応答種別を取得する。
 *
 * 取得前・取得失敗時は**ドメイン既定**へフォールバックする（担当者を操作不能にしない）。
 * つまり「0 件」になるのは**サイト設定が明示的に全部無効化しているときだけ**である。
 */
export function useStaffResponseActions(receptionId: string, token: string): ActionMeta[] {
  const [actions, setActions] = useState<ActionMeta[]>(defaultActionMeta);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/staff/calls/${receptionId}/respond?token=${encodeURIComponent(token)}`,
          { cache: 'no-store' },
        );
        if (!res.ok || cancelled) return;
        const parsed = parseActions(await res.json());
        if (!cancelled && parsed !== null) setActions(parsed);
      } catch {
        /* 取得失敗時はフォールバック（defaultEnabled）のまま操作可能にする */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [receptionId, token]);

  return actions;
}
