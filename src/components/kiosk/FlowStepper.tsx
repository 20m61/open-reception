'use client';

import type { ReceptionState } from '@/domain/reception/state';
import { makeT, type Locale, type MessageKey } from '@/lib/i18n';

/**
 * 受付フローの進捗ステッパー (issue #121 / Epic #119, UX 研究準拠)。
 *
 * 来訪者が「今どのステップか・あと何ステップか」を把握できるようにする（Envoy 等モダン
 * 受付の標準パターン）。入力系の 4 状態（目的→相手→情報→確認）にのみ表示し、待機・呼び出し
 * 中・結果などの状態では非表示（null）。pointer-events を持たない純表示要素。
 */

/** ステッパーに出す入力ステップの定義（表示順）。 */
const FLOW_STEPS: ReadonlyArray<{ state: ReceptionState; labelKey: MessageKey }> = [
  { state: 'selectingPurpose', labelKey: 'reception.step.purpose' },
  { state: 'selectingTarget', labelKey: 'reception.step.target' },
  { state: 'inputVisitorInfo', labelKey: 'reception.step.info' },
  { state: 'confirming', labelKey: 'reception.step.confirm' },
];

/** 現在状態のステップ位置（0 始まり）。フロー外の状態は -1。純関数（テスト対象）。 */
export function flowStepIndex(state: ReceptionState): number {
  return FLOW_STEPS.findIndex((s) => s.state === state);
}

export const FLOW_STEP_COUNT = FLOW_STEPS.length;

export function FlowStepper({ state, locale }: { state: ReceptionState; locale: Locale }) {
  const current = flowStepIndex(state);
  if (current < 0) return null; // 入力フロー外は表示しない
  const tr = makeT(locale);
  return (
    <ol
      className="flow-stepper"
      data-testid="flow-stepper"
      aria-label={`${current + 1} / ${FLOW_STEP_COUNT}`}
    >
      {FLOW_STEPS.map((step, i) => {
        const status = i < current ? 'done' : i === current ? 'current' : 'upcoming';
        return (
          <li
            key={step.state}
            className="flow-stepper__item"
            data-status={status}
            aria-current={status === 'current' ? 'step' : undefined}
          >
            <span className="flow-stepper__dot" aria-hidden="true">
              {i + 1}
            </span>
            <span className="flow-stepper__label" lang={locale}>
              {tr(step.labelKey)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
