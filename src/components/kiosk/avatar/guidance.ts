/**
 * 受付状態と同期したアバター案内データ (issue #123 / Epic #119)。
 *
 * 役割: アバターは「人間スタッフの代替」ではなく、受付状態を伝える案内役。
 * 本モジュールは #120 の `deriveAvatarState(screenState)` が返す `AvatarState` を入力に、
 * 状態ごとの「表情/モーション・短い発話・字幕・軽い誘導・フォールバック」を
 * 純データ + 純関数として定義する（副作用なし・I/O なし・PII を持ち込まない）。
 *
 * 設計原則:
 *  - 状態の所有者は state.ts / ui-contract.ts。本モジュールは導出された `AvatarState` を
 *    消費するだけで、独自に状態を進めない。
 *  - 音声が出ない/出せない場合も「字幕」で同じ内容を表示する。よって発話文言と字幕は
 *    常に同一文字列（`subtitle === speech`）であることを不変条件とする。
 *  - アバターは過剰に喋らない。短文に保つ。
 *  - 多言語は #103 の i18n（locale）に従う。アバター専用の短文は本モジュール内に内製で持つ
 *    （共有辞書 dictionary.ts は別トラック所有のため触らない）。
 *  - 視線/手振りなどの「軽い誘導」は次に触るべき場所を邪魔しない範囲のヒントに留める。
 */

import type { AvatarState } from '@/domain/reception/ui-contract';
import { MOTION_KEYS, type MotionKey } from '@/domain/motion/types';
import { DEFAULT_LOCALE, normalizeLocale, type Locale } from '@/lib/i18n';

/** アバターの表情（VRM の expression プリセットに対応する論理名。実適用は #65）。 */
export const AVATAR_EXPRESSIONS = [
  'neutral',
  'happy',
  'relaxed',
  'thinking',
  'concerned',
] as const;
export type AvatarExpression = (typeof AVATAR_EXPRESSIONS)[number];

/**
 * 軽い誘導（視線/手振り）の論理名。VRM へは #65 で接続する。
 *  - none: 誘導なし（待機/通話中など、操作を促さない局面）
 *  - inviteTouch: 「画面に触れて」と促す（待機）
 *  - lookAtChoices: 選択肢へ視線を向ける（目的/担当選択）
 *  - lookAtForm: 入力欄へ視線を向ける（情報入力）
 *  - lookAtConfirm: 確認ボタンへ視線を向ける（確認）
 *  - reassure: 安心を促す穏やかな所作（呼び出し中）
 *  - offerAlternative: 代替導線へ視線を向ける（失敗/未応答）
 */
export const AVATAR_GUIDANCE_CUES = [
  'none',
  'inviteTouch',
  'lookAtChoices',
  'lookAtForm',
  'lookAtConfirm',
  'reassure',
  'offerAlternative',
] as const;
export type AvatarGuidanceCue = (typeof AVATAR_GUIDANCE_CUES)[number];

/**
 * アバター案内の 1 状態ぶんの提示内容（locale 適用済み）。
 *  - speech: 発話文言（TTS が有効なら読み上げる短文）
 *  - subtitle: 字幕。音声が出ない/出せない場合も同内容を表示するため speech と必ず一致する。
 *  - expression / motionKey: 表情・モーション（実再生は VRM レンダラ #5/#31、UAT は #65）。
 *  - cue: 軽い誘導（操作領域を邪魔しない範囲）。
 *  - fallbackText: VRM ロード失敗時に静止画/テキストへ落ちた際に見せる短い案内。
 */
export type AvatarGuidance = {
  avatarState: AvatarState;
  expression: AvatarExpression;
  motionKey: MotionKey;
  speech: string;
  subtitle: string;
  cue: AvatarGuidanceCue;
  fallbackText: string;
};

/** locale 非依存の表現（表情/モーション/誘導）の定義。 */
type AvatarPresentation = {
  expression: AvatarExpression;
  motionKey: MotionKey;
  cue: AvatarGuidanceCue;
};

const PRESENTATION: Record<AvatarState, AvatarPresentation> = {
  idle: { expression: 'happy', motionKey: 'idle', cue: 'inviteTouch' },
  greeting: { expression: 'happy', motionKey: 'greeting', cue: 'lookAtChoices' },
  guiding: { expression: 'neutral', motionKey: 'selecting', cue: 'lookAtChoices' },
  listening: { expression: 'relaxed', motionKey: 'listening', cue: 'lookAtForm' },
  confirming: { expression: 'thinking', motionKey: 'thinking', cue: 'lookAtConfirm' },
  calling: { expression: 'relaxed', motionKey: 'calling', cue: 'reassure' },
  connected: { expression: 'happy', motionKey: 'connected', cue: 'none' },
  apologizing: { expression: 'concerned', motionKey: 'failed', cue: 'offerAlternative' },
  farewell: { expression: 'happy', motionKey: 'success', cue: 'none' },
};

/**
 * アバター専用の短文（発話=字幕）。多言語は #103 の locale に従う。
 * 既定 locale (ja) は全状態網羅必須。他 locale はサブセット可で、欠落は ja へフォールバックする。
 *
 * 注意（#123）:
 *  - 短文に保つ（過剰に喋らない）。
 *  - idle は「AI受付」であることを自然に明示する（初期体験で AI 受付と分かるように）。
 *  - 画面文言・音声・字幕が矛盾しないよう、受付フローの主導線（タッチUI）と整合する案内にする。
 */
type AvatarLines = Record<AvatarState, string>;
type PartialAvatarLines = Partial<AvatarLines>;

const ja: AvatarLines = {
  idle: 'AI受付です。画面にタッチして受付を始めてください',
  greeting: 'ようこそ。ご用件をお選びください',
  guiding: 'お訪ねする担当や部署をお選びください',
  listening: 'お名前など、ごゆっくりご入力ください',
  confirming: '内容をご確認のうえ、お進みください',
  calling: '担当者を呼び出しています。少々お待ちください',
  connected: 'おつなぎしました。どうぞお話しください',
  apologizing: '只今おつなぎできませんでした。別の方法をご案内します',
  farewell: '受付が完了しました。ご案内をお待ちください',
};

const en: PartialAvatarLines = {
  idle: 'AI reception here. Tap the screen to begin.',
  greeting: 'Welcome. Please choose your reason for visiting.',
  guiding: 'Please choose the person or department to reach.',
  listening: 'Please enter your details at your own pace.',
  confirming: 'Please review the details and continue.',
  calling: 'Calling the person in charge. Please wait a moment.',
  connected: "You're connected. Please go ahead.",
  apologizing: "We couldn't connect just now. Let us guide you another way.",
  farewell: 'Check-in complete. Please wait to be guided.',
};

const ko: PartialAvatarLines = {
  idle: 'AI 접수입니다. 화면을 터치해 시작하세요.',
  greeting: '환영합니다. 방문 목적을 선택해 주세요.',
  guiding: '찾으시는 담당자나 부서를 선택해 주세요.',
  listening: '성함 등을 천천히 입력해 주세요.',
  confirming: '내용을 확인하신 후 진행해 주세요.',
  calling: '담당자를 호출하고 있습니다. 잠시만 기다려 주세요.',
  connected: '연결되었습니다. 말씀해 주세요.',
  apologizing: '지금은 연결되지 않았습니다. 다른 방법을 안내해 드릴게요.',
  farewell: '접수가 완료되었습니다. 안내를 기다려 주세요.',
};

const zh: PartialAvatarLines = {
  idle: 'AI 接待。请触摸屏幕开始登记。',
  greeting: '欢迎。请选择来访事由。',
  guiding: '请选择要联系的负责人或部门。',
  listening: '请放心慢慢填写您的信息。',
  confirming: '请确认信息后继续。',
  calling: '正在呼叫负责人，请稍候。',
  connected: '已为您接通，请讲。',
  apologizing: '暂时无法接通，我们为您提供其他方式。',
  farewell: '登记完成，请等待引导。',
};

const LINES: Record<Locale, PartialAvatarLines> = { ja, en, ko, zh };

/** locale を適用して 1 状態の短文を返す（欠落は既定 locale へフォールバック）。 */
function lineFor(avatarState: AvatarState, locale: Locale): string {
  const normalized = normalizeLocale(locale);
  return LINES[normalized][avatarState] ?? LINES[DEFAULT_LOCALE][avatarState] ?? '';
}

/**
 * VRM/静止画とも使えない最終フォールバックの短い案内（locale 適用）。
 * アバターが一切描画できなくても、字幕と同等の案内をテキストで保証する。
 * ここでは「現在状態の発話＝字幕」をそのまま再利用し、表示と矛盾しないようにする。
 */
function fallbackTextFor(avatarState: AvatarState, locale: Locale): string {
  return lineFor(avatarState, locale);
}

/**
 * avatarState（+ locale）から提示内容を導出する純関数。
 * 発話と字幕は常に同一（音声が無くても字幕で同内容を保証する不変条件）。
 */
export function avatarGuidanceFor(
  avatarState: AvatarState,
  locale: Locale = DEFAULT_LOCALE,
): AvatarGuidance {
  const presentation = PRESENTATION[avatarState];
  const text = lineFor(avatarState, locale);
  return {
    avatarState,
    expression: presentation.expression,
    motionKey: presentation.motionKey,
    speech: text,
    subtitle: text, // 音声が出せない場合も字幕で同内容を表示する。
    cue: presentation.cue,
    fallbackText: fallbackTextFor(avatarState, locale),
  };
}

/** モーションキーが #31 の語彙に含まれることの保証（テスト/アサーション用）。 */
export function isResolvableMotionKey(key: MotionKey): boolean {
  return (MOTION_KEYS as readonly string[]).includes(key);
}
