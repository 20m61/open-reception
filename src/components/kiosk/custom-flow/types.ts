/**
 * 受付端末 カスタムフローレンダラの共有型 (issue #100, increment 1)。
 *
 * 受付端末側で扱う「目的別フロー」の最小表現。管理側の StoredReceptionFlow から
 * /api/kiosk/flow が返すサブセット（端末表示に必要な分のみ・PII なし）に対応する。
 */
import type { FlowField, FlowStepKind } from '@/domain/reception/custom-flow';

/** 受付端末が /api/kiosk/flow から受け取るフロー（表示・入力に必要な分）。 */
export type KioskFlow = {
  id: string;
  purposeKey: string;
  displayName: string;
  description?: string;
  order: number;
  steps: FlowStepKind[];
  fields: FlowField[];
  completionMessage?: string;
};

/** 来訪者がフォームで入力した値（key → 値）。text/textarea/select は文字列、checkbox は真偽。 */
export type FlowFieldValues = Record<string, string | boolean>;
