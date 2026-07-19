/**
 * provider 共通の実行 interface とスイート実行 (issue #365)。
 *
 * `VoiceEvalProvider` は #369 (Transport) / #370 (STT) / #371 (TTS) / #372 (Turn) が実装する
 * 唯一の入口である。実装は「シナリオを受け取り、共通イベント列のセッションを返す」だけでよく、
 * 指標・SLO・レポートはここから先が面倒を見る。
 *
 * この increment では実 Transcribe / Polly を呼ばない。`createReplayProvider` が固定の
 * イベント列を再生する mock provider として先行し、実 provider は同じ interface に
 * 差し替わる（#370 / #371）。実音声ファイルはリポジトリに入れない — 入力は合成発話と
 * 固定 fixture のみ（#365 のデータ方針）。
 */
import {
  VOICE_EVAL_SCHEMA_VERSION,
  validateVoiceEvalSession,
  type VoiceEvalEvent,
  type VoiceEvalGroundTruth,
  type VoiceEvalSession,
} from './evaluation-events';
import { computeSessionMetrics, computeSuiteMetrics, type VoiceEvalSuiteMetrics } from './evaluation-metrics';
import { evaluateAgainstSlo, type SloResult, type VoiceEvalProfile } from './evaluation-thresholds';

/**
 * シナリオ入力。実音声を持ち込まないため、合成発話テキストか、事前に用意した
 * 合成音声 fixture の識別子だけを持つ（音声そのものはリポジトリ外）。
 */
export type VoiceEvalScenarioInput =
  | { kind: 'synthetic'; utterances: { turnIndex: number; text: string; startAtMs?: number }[] }
  | { kind: 'fixture'; fixtureId: string };

export type VoiceEvalScenario = {
  id: string;
  locale: string;
  description: string;
  /** データセットの切り口（'person-name' / 'homophone' / 'backchannel' 等）。比較の絞り込みに使う。 */
  tags: string[];
  input: VoiceEvalScenarioInput;
  groundTruth: VoiceEvalGroundTruth;
};

/** provider 共通の実行 interface。実装はイベント列を返すことだけに責任を持つ。 */
export interface VoiceEvalProvider {
  readonly id: string;
  run(scenario: VoiceEvalScenario): Promise<VoiceEvalSession>;
}

/**
 * 記録済みイベント列を再生する mock provider。実 provider が入るまでの先行実装であり、
 * 回帰の基準線（ゴールデン）としても使う。
 */
export function createReplayProvider(config: {
  id: string;
  providers: VoiceEvalSession['providers'];
  sessionsByScenario: Record<string, VoiceEvalEvent[]>;
}): VoiceEvalProvider {
  return {
    id: config.id,
    run: async (scenario) => {
      const events = config.sessionsByScenario[scenario.id];
      if (!events) {
        // 記録が無いのを「0 件成功」にすると、データセット追加が黙って未計測になる。
        throw new Error(`replay provider '${config.id}': シナリオ '${scenario.id}' の記録が無い`);
      }
      return {
        schemaVersion: VOICE_EVAL_SCHEMA_VERSION,
        sessionId: `${config.id}/${scenario.id}`,
        locale: scenario.locale,
        providers: config.providers,
        events,
        groundTruth: scenario.groundTruth,
      };
    },
  };
}

export type VoiceEvalProviderResult = {
  providerId: string;
  metrics: VoiceEvalSuiteMetrics;
  slo: SloResult;
  /** 共通スキーマ違反。1 件でもあれば #369〜#372 の適合が崩れているので FAIL。 */
  schemaErrors: string[];
  /** provider の実行時例外。1 つの provider の失敗でスイート全体を落とさない。 */
  errors: string[];
};

export type VoiceEvalSuiteReport = {
  profile: VoiceEvalProfile['name'];
  schemaVersion: number;
  scenarioCount: number;
  providers: VoiceEvalProviderResult[];
  passed: boolean;
};

/**
 * 同一データセットを複数 provider に流し、provider ごとに指標と SLO 判定を返す。
 * provider の失敗は握りつぶさず `errors` に積み、スイートは FAIL にしつつ他 provider の
 * 計測は続行する（1 つ落ちただけで比較が全部消えるのを避ける）。
 */
export async function runVoiceEvalSuite(config: {
  providers: readonly VoiceEvalProvider[];
  scenarios: readonly VoiceEvalScenario[];
  profile: VoiceEvalProfile;
}): Promise<VoiceEvalSuiteReport> {
  const results: VoiceEvalProviderResult[] = [];

  for (const provider of config.providers) {
    const sessions: VoiceEvalSession[] = [];
    const schemaErrors: string[] = [];
    const errors: string[] = [];

    for (const scenario of config.scenarios) {
      try {
        const session = await provider.run(scenario);
        const validation = validateVoiceEvalSession(session);
        if (!validation.valid) {
          schemaErrors.push(...validation.errors.map((e) => `${scenario.id}: ${e}`));
          continue;
        }
        sessions.push(session);
      } catch (error) {
        errors.push(`${scenario.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const metrics = computeSuiteMetrics(sessions.map(computeSessionMetrics));
    const slo = evaluateAgainstSlo(metrics, config.profile.thresholds, { strict: config.profile.strict });
    results.push({ providerId: provider.id, metrics, slo, schemaErrors, errors });
  }

  return {
    profile: config.profile.name,
    schemaVersion: VOICE_EVAL_SCHEMA_VERSION,
    scenarioCount: config.scenarios.length,
    providers: results,
    passed: results.every((r) => r.slo.passed && r.schemaErrors.length === 0 && r.errors.length === 0),
  };
}
