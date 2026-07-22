/**
 * シナリオ → KioskFlow 外部注入点 マッピング層 (issue #363 第7wave / 第6wave 注入点の統合)。
 *
 * 第6wave で KioskFlow に追加された 4 つの外部注入点（`operatingStatus` /
 * `sttAdapterFactory` / `qrScanner` / `/call` 応答 `stages[]`）を、DemoScenario の
 * `initialMode` / `simulatedResults` から**決定論的に**導出する純関数群。本モジュールは
 * `src/components/kiosk/**` を一切変更せず、公開 API（props 型・注入用ヘルパ）を利用するだけ。
 *
 * 目的（issue #363 本文の背景）: 「この設定がどう見えるか」を非エンジニアが理解できるよう、
 * 組込シナリオ（営業時間外・STT失敗→タッチ切替・QR期限切れ等）を**実際の専用UIとして**
 * 再現する。データが揃っているだけで表示されない状態（旧 Inc1 の制約）を解消する。
 *
 * サンドボックス安全設計（#363 最重要 AC）:
 *   Vonage 発信失敗の「段階表示」は KioskCallView（`vonageCallId` が立つ非同期経路）を経由
 *   しないと実際には見えない（`case 'calling'` は `vonageCallId` が無いとき従来の CallingView を
 *   描画し、stages を使わない）。しかし KioskCallView は VonageCallClient 経由で実 CDN
 *   （opentok.js）を動的ロードしうる — token 取得（`/token`）が成立して初めて `client.connect()`
 *   が呼ばれる（call-controller.ts）。よって「段階表示 → 失敗」の再現は **token を必ず非 ok で
 *   返す**（mock-adapter.ts）ことで `client.connect()` 自体を回避し、外部 SDK ロードを一切
 *   発生させない。'answered'/'no_answer' など段階表示を伴わない終端は従来どおり `/call` が
 *   直接終端状態を返す同期経路のままにし、実 SDK 接続を要する非同期経路には踏み込まない。
 */
import type { ReceptionState } from '@/domain/reception/state';
import type { KioskFlowProps } from '@/components/kiosk/KioskFlow';
import type { KioskOperatingStatus } from '@/domain/kiosk/operating-status';
import type { SttAdapterFactory } from '@/components/kiosk/stt-adapter';
import { InjectableQrScanner } from '@/components/kiosk/qr-injection';
import type { QrScanner } from '@/domain/checkin/scanner';
import type { CallStage } from '@/domain/kiosk/call-stages';
import type { DemoCallResult, DemoScenario } from './scenario';

/** 営業時間外シナリオの再開時刻サンプルのオフセット（現在時刻 + 12 時間, デモ用の擬似値）。 */
const OUT_OF_HOURS_REOPEN_OFFSET_MS = 12 * 60 * 60 * 1000;

/**
 * 営業状態の注入 (#363 「営業時間外」)。`initialMode==='out_of_hours'` のときのみ closed を返す。
 * それ以外は undefined（fail-open。`operatingStateOf` が undefined を返し通常受付のまま）。
 * `nowMs` は基準時刻（省略時 `Date.now()`）で、テスト可能な決定論的 reopenAt を導出する。
 */
export function deriveOperatingStatus(
  scenario: DemoScenario,
  nowMs: number = Date.now(),
): KioskOperatingStatus | undefined {
  if (scenario.initialMode !== 'out_of_hours') return undefined;
  return {
    state: 'closed',
    reopenAt: new Date(nowMs + OUT_OF_HOURS_REOPEN_OFFSET_MS).toISOString(),
    // 実連絡先・PII は含めない（`.claude/rules/pii-secret-minimization.md`）。表示ラベルのみ。
    emergencyContactLabel: '警備室内線（デモ）',
  };
}

/** 空白除外・最大3件（既定 MockSttAdapter と同じ規則）。 */
function topCandidates(phrases: string[], limit: number): string[] {
  return phrases.filter((p) => p.trim() !== '').slice(0, limit);
}

/**
 * STT アダプタファクトリの注入 (#363 「音声認識失敗→タッチ切替」)。
 * `simulatedResults.stt` 未指定は undefined（既定 MockSttAdapter を使わせる＝非退行）。
 *   - 'error': 候補ゼロ（実際の失敗＝候補が出ないまま、来訪者は検索欄＝タッチへ自然に縮退する。
 *     KioskFlow は候補未着でもエラー表示を出さない現行契約と一致させる）。
 *   - 'low_confidence': 曖昧な認識を模し、候補を 1 件のみに絞る（success と視覚的に区別できる）。
 *   - 'success': 既定 MockSttAdapter と同じ規則（最大3件）。
 */
export function deriveSttAdapterFactory(scenario: DemoScenario): SttAdapterFactory | undefined {
  const stt = scenario.simulatedResults.stt;
  if (stt === undefined) return undefined;
  return (phrases: string[]) => ({
    async listen(): Promise<string[]> {
      if (stt === 'error') return [];
      if (stt === 'low_confidence') return topCandidates(phrases, 1);
      return topCandidates(phrases, 3);
    },
  });
}

/**
 * QR スキャナの注入 (#363 「QR系シナリオ」)。実カメラ不要で payload を注入する
 * `InjectableQrScanner`（`src/components/kiosk/qr-injection.ts`、公開 API）を使う。
 * `simulatedResults.qr` 未指定は undefined（実カメラ経路のまま・非退行）。
 *
 * 注入する payload の**中身**はダミー（`demo-qr-<scenario.id>`）で構わない: 実際の解決結果
 * （valid/expired/used/revoked）は mock-adapter.ts の `/api/kiosk/checkin/resolve` が
 * `simulatedResults.qr` を見て決めるため、CheckinFlow から見れば「何らかの非空 payload が
 * 読み取れた」ことだけが重要（PII/実 token は載せない, `rules/pii-secret-minimization.md`）。
 */
export function deriveQrScanner(scenario: DemoScenario): QrScanner | undefined {
  if (scenario.simulatedResults.qr === undefined) return undefined;
  return new InjectableQrScanner(`demo-qr-${scenario.id}`);
}

/** KioskFlow へ渡す注入 props をまとめて導出する。未該当のフィールドは undefined のまま。 */
export function deriveKioskFlowProps(
  scenario: DemoScenario,
  nowMs: number = Date.now(),
): KioskFlowProps {
  return {
    operatingStatus: deriveOperatingStatus(scenario, nowMs),
    sttAdapterFactory: deriveSttAdapterFactory(scenario),
    qrScanner: deriveQrScanner(scenario),
  };
}

/** #374 RouteResult 部分集合 → Kiosk が期待する受付状態への写像（mock-adapter.ts と同一契約）。 */
const CALL_RESULT_TO_STATE: Record<DemoCallResult, Extract<ReceptionState, 'connected' | 'timeout' | 'failed'>> = {
  answered: 'connected',
  no_answer: 'timeout',
  declined: 'failed',
  failed: 'failed',
};

/**
 * 取次段階の導出 (#363 injection point 4「取次段階」)。
 *
 * 各試行（代理→部門代表などの複数手）を 1 段階ずつ `done` として表す。ただし**最終手が
 * 'failed'** のときだけ、その最終手を発信内訳（dial → ring → connect）へ展開し、
 * dial=done / ring=active / connect=pending として「進行中に失敗する」様子を見せる
 * （Vonage 発信失敗の段階表示, issue #363 AC）。それ以外の終端（answered/no_answer/declined）は
 * 段階表示を伴う非同期経路（KioskCallView）に乗せない（下記 deriveCallResponse 参照）ため、
 * 単に `done` の 1 段階として記録するに留める（データとしては欠落させない）。
 */
export function deriveCallStages(call?: ReadonlyArray<DemoCallResult>): CallStage[] {
  const attempts = call && call.length > 0 ? call : (['no_answer'] as const);
  const stages: CallStage[] = [];
  attempts.forEach((result, i) => {
    const isLast = i === attempts.length - 1;
    if (isLast && result === 'failed') {
      stages.push({ key: 'dial', status: 'done' });
      stages.push({ key: 'ring', status: 'active' });
      stages.push({ key: 'connect', status: 'pending' });
      return;
    }
    stages.push({ key: `attempt-${i + 1}`, status: 'done' });
  });
  return stages;
}

export type DemoCallResponse = {
  /**
   * 'calling' は KioskCallView（非同期経路）へ乗せて段階表示させることを意味する。
   * それ以外は従来どおり `/call` が直接終端状態を返す同期経路（非退行・実SDK接続を誘発しない）。
   */
  state: ReceptionState | 'calling';
  stages: CallStage[];
};

/**
 * `/api/kiosk/receptions/:id/call` の Mock 応答本体を導出する (#363)。
 *
 * 最終手が 'failed'（技術的な発信失敗）のときだけ `state:'calling'` を返し、KioskCallView が
 * 段階表示してから（mock-adapter.ts が `/token` を非 ok にすることで）フォールバック→
 * CALL_FAILED へ落ちる。'declined'（担当者到達済み・明示拒否）はそもそも接続自体は成立している
 * ため、段階表示や非同期経路は使わず直接 'failed' を返す（意味的に技術的失敗と区別する）。
 */
export function deriveCallResponse(scenario: DemoScenario): DemoCallResponse {
  const call = scenario.simulatedResults.call;
  const stages = deriveCallStages(call);
  const attempts = call && call.length > 0 ? call : (['no_answer'] as const);
  const last = attempts[attempts.length - 1]!;
  const state: ReceptionState | 'calling' = last === 'failed' ? 'calling' : CALL_RESULT_TO_STATE[last];
  return { state, stages };
}
