/**
 * webhook 応答までの所要時間を段ごとに測る (#744)。
 *
 * ## なぜ先に計測なのか
 *
 * `/choice` は担当者の選択を相関へ書き、必要なら次の手を撃ってから talk（受領応答）を返す。
 * 順序は意図的で、先に返すと担当者が切って `completed` が先に届いたときに取次が次の手へ
 * 進む（#742 の B1 が塞いだ事故そのもの）。
 *
 * だから「遅いから順序を変える」は危ない。**どこが遅いのか**が分からないまま入れ替えると、
 * 塞いだ B1 を別の形で開けかねない。まず段ごとに測る。
 *
 * ## PII を持たない
 *
 * 記録するのは**段の名前と所要ミリ秒だけ**。選択の値・宛先・通話 ID は載せない
 * （`.claude/rules/pii-secret-minimization.md`）。段名は列挙で、外部入力を混ぜない。
 *
 * 純関数 + 注入された時計。HTTP も provider も知らない。
 */

/** 測る段。**列挙で固定する** ── 呼び出し側が任意の文字列を書けると PII が混ざりうる。 */
export const WEBHOOK_STAGES = [
  'signature',
  'correlation_read',
  'policy_resolve',
  'endpoint_resolve',
  'reception_read',
  'correlation_write',
  'provider_initiate',
] as const;

export type WebhookStage = (typeof WEBHOOK_STAGES)[number];

export type StageTimings = {
  readonly route: string;
  readonly totalMs: number;
  readonly stages: Readonly<Partial<Record<WebhookStage, number>>>;
};

export type StageRecorder = {
  /** 1 段を測る。**例外も測る**（遅いのが失敗経路だと分からないと意味がない）。 */
  measure<T>(stage: WebhookStage, run: () => Promise<T>): Promise<T>;
  /** 計測結果。呼び出し側がログへ出す。 */
  finish(): StageTimings;
};

/**
 * 段の計測器を作る。`now` は注入する（テストで決定的に固定するため）。
 *
 * 🔴 **計測が本処理を止めない。** ここで投げると webhook が 5xx を返し、Vonage の再送が
 * 走る。計測は本処理の外側に居るべきで、失敗しても本処理の結果を変えない。
 */
export function createStageRecorder(route: string, now: () => number = () => Date.now()): StageRecorder {
  const startedAt = now();
  const stages: Partial<Record<WebhookStage, number>> = {};

  return {
    async measure<T>(stage: WebhookStage, run: () => Promise<T>): Promise<T> {
      const from = now();
      try {
        return await run();
      } finally {
        // 失敗した段も測る。遅いのが失敗経路（タイムアウト等）だと分からないと切り分けられない。
        stages[stage] = now() - from;
      }
    },
    finish(): StageTimings {
      return { route, totalMs: now() - startedAt, stages: { ...stages } };
    },
  };
}

/** 構造化ログ 1 行。値・宛先・通話 ID は載せない。 */
export function stageTimingLog(timings: StageTimings): string {
  return JSON.stringify({ event: 'vonage_webhook_timing', ...timings });
}
