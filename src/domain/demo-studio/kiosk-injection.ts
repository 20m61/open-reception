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
import { createSyntheticVoiceSession, type VoiceSessionFactory } from '@/lib/voice-session/kiosk-binding';
import type { EntityDirectory } from '@/domain/voice-stt/entity-resolver';
import type { Staff } from '@/domain/staff/types';
import type { Department } from '@/domain/department/types';
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

// =============================================================================
// Synthetic 音声セッションの注入 (#363 音声シナリオ再現 / #364 kiosk 配線)
// =============================================================================

/**
 * synthetic 音声解決が参照する合成ディレクトリ (#364)。**mock-adapter.ts の `demoDirectory()` と
 * 同じ id/表示名**を持つ（`staff-sato` / `staff-suzuki` / `staff-tanaka`・`dept-reception` /
 * `dept-sales`）。これにより音声で解決した候補 id が、KioskFlow が `/api/kiosk/directory` から
 * 得る相手一覧の id と一致し、`SELECT_TARGET` がそのまま噛み合う。PII は含まない合成表示名のみ
 * （`.claude/rules/pii-secret-minimization.md`）。
 */
function mkDemoStaff(id: string, displayName: string, kana: string, departmentId: string, aliases: string[] = []): Staff {
  return {
    id,
    displayName,
    kana,
    aliases,
    departmentId,
    enabled: true,
    available: true,
    callTargets: [],
    fallbackStaffIds: [],
  };
}

export function demoVoiceDirectory(): EntityDirectory {
  return {
    staff: [
      mkDemoStaff('staff-sato', 'デモ 佐藤', 'さとう', 'dept-reception'),
      mkDemoStaff('staff-suzuki', 'デモ 鈴木', 'すずき', 'dept-sales', ['スズキ']),
      mkDemoStaff('staff-tanaka', 'デモ 田中', 'たなか', 'dept-sales'),
    ] satisfies Staff[],
    departments: [
      { id: 'dept-reception', name: '受付', kana: 'うけつけ', displayOrder: 0, enabled: true },
      { id: 'dept-sales', name: '営業部', kana: 'えいぎょうぶ', displayOrder: 1, enabled: true },
    ] satisfies Department[],
  };
}

/**
 * 発話取り込み〜復唱〜確定の各段の既定間隔（ms）。第9wave からは selectingTarget 到達
 * （`notifyReceptionState`）を起点に測る（マウント起点ではない）ため、この値は「相手選択画面が
 * 表示されてから発話が始まるまでの間」の演出上の猶予にすぎない。
 */
export const DEMO_VOICE_STEP_MS = 2000;
/**
 * synthetic の STT confidence 既定値。閾値（#370 既定 0.6）**未満**にして必ず復唱確認を挟む。
 * 「重要な固有名詞は必ず画面で確認する」(#364 原則) の再現でもある（発話→**復唱**→確定を見せる）。
 */
export const DEMO_VOICE_CONFIDENCE = 0.4;
/** voice 入力が無いが stt success のときの既定発話（合成ディレクトリの担当者に解決する）。 */
export const DEMO_VOICE_DEFAULT_UTTERANCE = '鈴木';

/** setTimeout 互換のタイマー。テストは決定論のため手動スケジューラを注入できる。 */
export type DemoTimerHandle = ReturnType<typeof setTimeout>;
export type DemoScheduler = {
  set: (fn: () => void, ms: number) => DemoTimerHandle;
  clear: (handle: DemoTimerHandle) => void;
};
const DEFAULT_DEMO_SCHEDULER: DemoScheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle),
};

export type DeriveVoiceSessionOptions = {
  directory?: EntityDirectory;
  stepDelayMs?: number;
  sttConfidence?: number;
  scheduler?: DemoScheduler;
};

/**
 * シナリオが「音声成功系」かどうか (#363/#364)。
 *  - `stt: 'error' | 'low_confidence'`（失敗系）は synthetic 音声を作らず、第7wave の失敗
 *    `SttAdapter` 経路（`deriveSttAdapterFactory`）＝「音声認識失敗→タッチ切替」のまま残す（非退行）。
 *  - それ以外で `stt: 'success'` か、`visitorInputs` に `mode:'voice'` があれば音声成功系とみなす。
 */
export function wantsSyntheticVoice(scenario: DemoScenario): boolean {
  const stt = scenario.simulatedResults.stt;
  if (stt === 'error' || stt === 'low_confidence') return false;
  const hasVoiceInput = scenario.visitorInputs.some((i) => i.mode === 'voice');
  return stt === 'success' || hasVoiceInput;
}

/** 最初の voice 入力の value（発話文）。無ければ undefined。 */
function firstVoiceUtterance(scenario: DemoScenario): string | undefined {
  return scenario.visitorInputs.find((i) => i.mode === 'voice')?.value;
}

/**
 * 音声成功シナリオの synthetic セッション factory を導出する (#363/#364、第9wave でゼロタッチ化)。
 *
 * 返る factory を KioskFlow の `voiceSession` prop へ渡すと、**受付が相手選択画面
 * （`selectingTarget`）へ到達するたび**に自動再生が走る: `beginListening`（字幕「お話しください」）
 * → `hearTurn(発話文)`（→ 低信頼のため復唱確認「◯◯様ですね？」）→ `confirmYes`（「はい」で確定）。
 * 確定は KioskFlow が差し込む `onResolved` hook 経由で相手選択（`SELECT_TARGET`）へ橋渡しされる。
 *
 * 起点は **マウント時刻ではなく `notifyReceptionState('selectingTarget')`**（KioskFlow →
 * `VoiceSessionLayer` → `useVoiceSession` → `VoiceKioskStore` 経由の通知）。これにより、操作者が
 * 用件選択などのタッチ手順を終えて実際に相手選択画面へ到達した瞬間に発話が始まり、
 * 「選択画面へ進めば音声が確実に相手を確定する」ことを保証する（取りこぼしゼロ）。BACK 等で
 * selectingTarget へ再入場した場合も再実行する。
 *
 * 音声成功系でないシナリオは undefined を返す（従来どおり音声 UI を一切マウントしない＝非退行）。
 * タイマーは `close`（アンマウント）または次回の selectingTarget 到達時に必ず解除し、
 * アンマウント後の発火・多重発火・sandbox 越えを防ぐ。
 */
export function deriveVoiceSession(
  scenario: DemoScenario,
  opts?: DeriveVoiceSessionOptions,
): VoiceSessionFactory | undefined {
  if (!wantsSyntheticVoice(scenario)) return undefined;

  const directory = opts?.directory ?? demoVoiceDirectory();
  const utterance = firstVoiceUtterance(scenario) ?? DEMO_VOICE_DEFAULT_UTTERANCE;
  const stepMs = opts?.stepDelayMs ?? DEMO_VOICE_STEP_MS;
  const confidence = opts?.sttConfidence ?? DEMO_VOICE_CONFIDENCE;
  const scheduler = opts?.scheduler ?? DEFAULT_DEMO_SCHEDULER;

  return (emit, hooks) => {
    const driver = createSyntheticVoiceSession({ directory, sttConfidence: confidence });
    const controller = driver.factory(emit, hooks);
    const timers = new Set<DemoTimerHandle>();
    const at = (step: number, fn: () => void): void => {
      timers.add(scheduler.set(fn, stepMs * step));
    };
    const cancelAll = (): void => {
      for (const handle of timers) scheduler.clear(handle);
      timers.clear();
    };

    /**
     * 発話→復唱→確定 の 1 サイクルを、呼び出し時点を起点にスケジュールする
     * (issue #364/#363/#361 第9wave ゼロタッチ完全自動化)。
     * 保留中の前回タイマーは必ず解除してから積み直す（再入場の多重発火防止）。
     */
    const playSequence = (): void => {
      cancelAll();
      at(1, () => driver.beginListening());
      at(2, () => driver.hearTurn(utterance));
      at(3, () => controller.confirmYes());
    };

    return {
      start: () => {
        void controller.start();
        // ここでは何もスケジュールしない (第8wave 申し送りの解消): マウント時点の受付局面は
        // 大抵 idle/selectingPurpose で、selectingTarget とは限らない。旧実装のようにマウント
        // 起点の固定タイマーで即時再生すると、操作者がまだ相手選択画面へ到達していないうちに
        // confirmYes が SELECT_TARGET を dispatch してしまい、reducer が selectingTarget 以外を
        // no-op にする設計のため取りこぼす。再生の起点は `notifyReceptionState` に一本化する。
      },
      close: () => {
        cancelAll();
        void controller.close();
      },
      confirmYes: () => controller.confirmYes(),
      confirmNo: () => controller.confirmNo(),
      // KioskFlow が data.state の変化を通知するたび呼ばれる（VoiceSessionLayer 経由）。
      // selectingTarget へ到達する**たびに**（初回到達・BACK からの再到達いずれも）発話
      // シーケンスを (再)開始することで「操作者が選択画面へ進めば音声が確実に相手を確定する」
      // ことを保証する（取りこぼしゼロ）。それ以外の局面通知は無視する。
      notifyReceptionState: (state) => {
        if (state === 'selectingTarget') playSequence();
      },
    };
  };
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
    voiceSession: deriveVoiceSession(scenario),
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
