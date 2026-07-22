/**
 * 動的な TTS 案内文の組み立て (issue #371)。
 *
 * 設計方針（issue #371 本文）: 動的生成は**担当者名・部門名・例外案内へ限定する**（自由文の
 * 動的合成は対象外 —— 定型文の外側は基本キャッシュ不可能な文言を無制限に増やさない）。
 *
 * すべて純関数で `TtsUtteranceText`（displayText/speechText 分離, `types.ts`）を返すだけ。
 * ここで返した text を `TtsRequest.text` に載せれば、`ttsRequestCacheKey` が自動的に
 * 発音用文をキーへ使う。
 */
import type { TtsUtteranceText } from './types';

export type StaffCalledAnnouncementInput = {
  staffName: string;
  /** 発音用の読み。省略時は staffName をそのまま読みにも使う。 */
  staffNameReading?: string;
  departmentName?: string;
  departmentNameReading?: string;
};

/** 「〇〇部の田中太郎様をお呼びしています」相当の動的案内。 */
export function buildStaffCalledAnnouncement(input: StaffCalledAnnouncementInput): TtsUtteranceText {
  const displayName = input.departmentName ? `${input.departmentName} ${input.staffName}` : input.staffName;
  const speechName = input.departmentName
    ? `${input.departmentNameReading ?? input.departmentName} ${input.staffNameReading ?? input.staffName}`
    : (input.staffNameReading ?? input.staffName);
  return {
    displayText: `${displayName}様をお呼びしています。`,
    speechText: `${speechName} さまを お呼びしています。`,
  };
}

export type DepartmentGuidanceAnnouncementInput = {
  departmentName: string;
  departmentNameReading?: string;
};

/** 「経理部へご案内します」相当の動的案内。 */
export function buildDepartmentGuidanceAnnouncement(input: DepartmentGuidanceAnnouncementInput): TtsUtteranceText {
  return {
    displayText: `${input.departmentName}へご案内します。`,
    speechText: `${input.departmentNameReading ?? input.departmentName} へ ご案内します。`,
  };
}

export type ExceptionAnnouncementInput = {
  /** 呼び出し側が明示的に渡す理由文。ここで自動生成・推測はしない（PII 混入を防ぐ）。 */
  reason: string;
};

/** 担当者不在等の例外案内。理由文は呼び出し側が渡したものをそのまま使い、推測で補わない。 */
export function buildExceptionAnnouncement(input: ExceptionAnnouncementInput): TtsUtteranceText {
  return {
    displayText: input.reason,
    speechText: input.reason,
  };
}
