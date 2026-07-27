'use client';

/**
 * 受付体験メトリクスの計測を `KioskFlow` から分離したフック (issue #422 increment 2 / #319 / #322)。
 *
 * 計測は**非破壊**で、受付の状態機械・画面には一切影響しない。ステップ滞在所要・呼び出し到達
 * までの所要・「戻る」回数（ステップ後退で検知）・「キャンセル」回数・主入力手段・担当者検索の
 * ヒット有無を集計し、呼び出し作成時にスナップショットをサーバへ同送する。
 *
 * **PII を持ち込まない** (`.claude/rules/pii-secret-minimization.md`): 検索クエリ文字列・検索結果・
 * 来訪者情報はトラッカへ入れない。入るのは所要・回数・入力手段・ヒット有無だけ。
 *
 * 値は state ではなく **ref** で持つ。計測のたびに再描画すると、受付画面が入力のたびに
 * 描き直されるため（計測が体験を変えてしまう）。ref の更新は描画中ではなくイベント
 * ハンドラ・effect の中だけで行う（react-hooks ルール準拠）。
 */
import { useCallback, useEffect, useRef } from 'react';
import type { ReceptionState } from '@/domain/reception/state';
import {
  createTracker,
  enterStep,
  finalizeExperience,
  recordBack,
  recordCancel,
  recordInputMethod,
  recordSearchQuery,
  stepForState,
  type ExperienceTracker,
} from '@/domain/reception/experience-metrics';
import { EXPERIENCE_STEP_ORDER } from '@/domain/reception/experience-summary';

export type ExperienceMetrics = {
  markInputMethod: (method: Parameters<typeof recordInputMethod>[1]) => void;
  /** 音声検索の採用を主入力手段=音声として記録する安定ハンドラ (#319)。 */
  markVoiceInput: () => void;
  /** 担当者検索の実行（**ヒット有無のみ**）をヒット率/0 件率へ記録する (#322)。 */
  markSearchQuery: (hasHit: boolean) => void;
  /** 呼び出し到達時点のスナップショット（`timeToCall` はこの時点で確定する）。 */
  snapshotForCall: (nowMs: number) => ReturnType<typeof finalizeExperience>;
};

export function useExperienceMetrics(state: ReceptionState): ExperienceMetrics {
  const experienceRef = useRef<ExperienceTracker>(createTracker());
  const prevStepRef = useRef<ReturnType<typeof stepForState>>(null);

  const markInputMethod = useCallback((method: Parameters<typeof recordInputMethod>[1]) => {
    experienceRef.current = recordInputMethod(experienceRef.current, method);
  }, []);
  // renderScreen は素の関数呼び出しのため、ref を触る処理は（インライン arrow ではなく）
  // useCallback で渡す（react-hooks/refs: レンダー中に ref を触らない）。実行はクリック時のみ。
  const markVoiceInput = useCallback(() => markInputMethod('stt'), [markInputMethod]);
  // クエリ文字列や検索結果自体は ref に持ち込まない（PII 最小化）。
  const markSearchQuery = useCallback((hasHit: boolean) => {
    experienceRef.current = recordSearchQuery(experienceRef.current, hasHit);
  }, []);
  const snapshotForCall = useCallback(
    (nowMs: number) => finalizeExperience(experienceRef.current, { abandoned: false, nowMs }),
    [],
  );

  // 状態遷移から体験メトリクスを計測する (issue #319)。idle でトラッカをリセットする
  // （次の来訪者へ持ち越さない）。
  useEffect(() => {
    if (state === 'idle') {
      experienceRef.current = createTracker();
      prevStepRef.current = null;
      return;
    }
    const step = stepForState(state);
    if (step) {
      const prev = prevStepRef.current;
      if (prev && EXPERIENCE_STEP_ORDER.indexOf(step) < EXPERIENCE_STEP_ORDER.indexOf(prev)) {
        experienceRef.current = recordBack(experienceRef.current);
      }
      experienceRef.current = enterStep(experienceRef.current, step, Date.now());
      prevStepRef.current = step;
    } else if (state === 'cancelled') {
      experienceRef.current = recordCancel(experienceRef.current);
    }
  }, [state]);

  return { markInputMethod, markVoiceInput, markSearchQuery, snapshotForCall };
}
