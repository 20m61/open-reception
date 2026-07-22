/**
 * 取次（呼び出し）の段階通知 (issue #363 injection point 4)。
 *
 * `/api/kiosk/receptions/:id/call` の応答に、取次の段階（例: 発信→呼出→接続）を段階的に
 * 伝える `stages[]` を **後方互換で追加**する受け口。既存応答は `{ state }` のみで、旧形は
 * `parseCallStages` が空配列を返す（#363 Mock が旧形で返しても壊れない・既存 e2e green 維持）。
 *
 * PII/機密の最小化 (#105 / #19): 段階は「識別子キー + 状態」だけで表す。氏名・会社名・電話番号
 * などの個人情報を段階ラベルに載せない運用を強制するため、`key` は英数字と `._-` のみ許容し、
 * それ以外を含む要素は捨てる（表示は i18n ラベル or キーそのものに限定される）。
 */
export type CallStageStatus = 'pending' | 'active' | 'done';

export type CallStage = {
  /** 段階の識別子（英数字/._- のみ）。表示ラベルは i18n 側で解決、未知キーは素の値で表示。 */
  key: string;
  status: CallStageStatus;
};

const STAGE_STATUSES: ReadonlySet<string> = new Set<CallStageStatus>(['pending', 'active', 'done']);
/** 個人情報の混入を防ぐキー許容パターン（英数字と ._- のみ）。 */
const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;
/** 表示暴走を防ぐ段階数の上限。 */
const MAX_STAGES = 8;

/**
 * `/call` 応答（未知の形）から段階配列を安全に抽出する。
 * 旧形・非オブジェクト・非配列・不正要素はすべて捨て、最悪でも `[]` を返す（後方互換）。
 */
export function parseCallStages(res: unknown): CallStage[] {
  if (typeof res !== 'object' || res === null) return [];
  const raw = (res as { stages?: unknown }).stages;
  if (!Array.isArray(raw)) return [];

  const stages: CallStage[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const key = (item as { key?: unknown }).key;
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) continue;
    const rawStatus = (item as { status?: unknown }).status;
    const status: CallStageStatus =
      typeof rawStatus === 'string' && STAGE_STATUSES.has(rawStatus)
        ? (rawStatus as CallStageStatus)
        : 'pending';
    stages.push({ key, status });
    if (stages.length >= MAX_STAGES) break;
  }
  return stages;
}
