/**
 * 担当者への外線音声案内（NCCO）の組み立て (issue #4 MVP 1)。
 *
 * **二段階に分ける理由**: 外線は誰が出るか分からない。留守番電話・家族・同僚が応答しうる。
 * そこで第 1 段では「受付からの電話」であることだけを伝えて DTMF を要求し、**担当者本人が
 * 意思表示した後**（第 2 段）で初めて来訪者情報を案内する。#4 の
 * 「留守番電話や第三者に来訪者情報を読み上げない」はこの分割で満たす。
 *
 * 純関数。Vonage への送信・HTTP・状態は持たない（`ConnectionProvider` の adapter が使う）。
 * NCCO の形は Vonage Voice API の仕様に合わせるが、**受付ドメインの語彙は持ち込まない**
 * （`RouteResult` への写像は `staffChoiceToRouteResult` に閉じる）。
 */
import type { RouteResult } from '@/domain/routing/policy';

/** 読み上げ言語。担当者向けの案内は日本語固定（来訪者向け多言語とは別物）。 */
const ANNOUNCE_LANGUAGE = 'ja-JP';

/** NCCO の talk アクション。 */
export type NccoTalk = {
  readonly action: 'talk';
  readonly text: string;
  readonly language: string;
  /** 読み上げ中の DTMF 入力を許可する（最後まで聞かせない）。 */
  readonly bargeIn: boolean;
};

/** NCCO の input アクション（DTMF）。 */
export type NccoInput = {
  readonly action: 'input';
  readonly type: readonly ['dtmf'];
  readonly dtmf: { readonly maxDigits: number; readonly timeOut: number };
  readonly eventUrl: readonly [string];
};

export type NccoAction = NccoTalk | NccoInput;
export type Ncco = readonly NccoAction[];

/** 担当者が DTMF で選べる意思表示。 */
export type StaffChoice = 'accept' | 'coming' | 'declined' | 'delegate';

/**
 * DTMF の割り当て。**案内文と写像を同じ表から導く**ため 1 箇所に置く。
 * 分けて書くと「案内では 4 を案内しているのに押しても効かない」がすり抜ける。
 */
export const DTMF_CHOICES = [
  { digit: '1', choice: 'accept', label: '来訪者と話す' },
  { digit: '2', choice: 'coming', label: 'まもなく向かう' },
  { digit: '3', choice: 'declined', label: '対応できない' },
  { digit: '4', choice: 'delegate', label: '代理担当へ' },
] as const satisfies readonly { digit: string; choice: StaffChoice; label: string }[];

export type VisitorAnnouncement = {
  readonly visitorName: string;
  readonly companyName: string;
  /** 用件（任意）。設定されていれば第 2 段でのみ案内する。 */
  readonly purpose?: string;
};

export type ConfirmationParams = {
  readonly eventUrl: string;
  readonly timeoutSeconds: number;
};

export type DetailsParams = {
  readonly visitor: VisitorAnnouncement;
  readonly eventUrl: string;
  readonly timeoutSeconds: number;
};

function dtmfInput(eventUrl: string, timeoutSeconds: number): NccoInput {
  return {
    action: 'input',
    type: ['dtmf'],
    // 1 桁だけ受ける。複数桁を待つと、誤入力のたびにタイムアウトまで沈黙する。
    dtmf: { maxDigits: 1, timeOut: timeoutSeconds },
    eventUrl: [eventUrl],
  };
}

/**
 * 第 1 段: 応答者が担当者本人かを確かめる。
 *
 * **来訪者情報を引数に取らない。** 受け取れる形にすると、いつか誰かがここへ載せる。
 * 型で不可能にしておくのが、この分割を将来にわたって守る唯一の方法
 * （`voice-announcement.test.ts` が引数の数も固定している）。
 */
export function buildConfirmationNcco(params: ConfirmationParams): Ncco {
  return [
    {
      action: 'talk',
      text: '受付からのお電話です。ご対応いただける場合は、1 を押してください。',
      language: ANNOUNCE_LANGUAGE,
      bargeIn: true,
    },
    dtmfInput(params.eventUrl, params.timeoutSeconds),
  ];
}

/** 第 2 段: 担当者本人と確認できた後に来訪者情報と選択肢を案内する。 */
export function buildDetailsNcco(params: DetailsParams): Ncco {
  const { visitor } = params;
  const purpose = visitor.purpose ? `ご用件は、${visitor.purpose}です。` : '';
  const options = DTMF_CHOICES.map((c) => `${c.digit}、${c.label}。`).join('');
  return [
    {
      action: 'talk',
      text: `${visitor.companyName}の${visitor.visitorName}様がお越しです。${purpose}`,
      language: ANNOUNCE_LANGUAGE,
      bargeIn: true,
    },
    {
      action: 'talk',
      text: options,
      language: ANNOUNCE_LANGUAGE,
      bargeIn: true,
    },
    dtmfInput(params.eventUrl, params.timeoutSeconds),
  ];
}

/** DTMF 入力を意思表示へ写す。未定義の入力は undefined（呼び出し側で再案内 or タイムアウト扱い）。 */
export function resolveStaffChoice(digits: string): StaffChoice | undefined {
  return DTMF_CHOICES.find((c) => c.digit === digits)?.choice;
}

/**
 * 意思表示を取次語彙（`RouteResult`）へ写す。
 *
 * `declined` と `delegate` はどちらも `'declined'`（＝次の手へ進む）。**Provider が代理先を
 * 選ばない**のが #4 の設計方針で、次に誰へ行くかは RoutingPolicy / Orchestrator が決める。
 * 「対応不可」と「代理へ」の区別は `StaffChoice` のまま監査・来訪者向け表示へ渡す。
 */
export function staffChoiceToRouteResult(choice: StaffChoice): RouteResult {
  switch (choice) {
    case 'accept':
      return 'answered';
    case 'coming':
      return 'staff_coming';
    case 'declined':
    case 'delegate':
      return 'declined';
  }
}
