/**
 * 端末が heartbeat で報告する構成の反映状況 (issue #420 / #422)。
 *
 * 管理画面の「反映状況」（`/admin/experience-versions`）は、**端末からの報告**が無いと全台
 * `pending` のままになる。サーバ側の受け口・分類・画面は第 19〜21 wave で在り、本モジュールは
 * その最後の一片＝「端末が何を報告するか」を純関数として決める。
 *
 * 報告するのは **`version.contentHash`（内容の指紋）** であって、`/api/configuration/effective`
 * 応答の `configHash` ではない。後者は context（端末 ID）を含むため端末ごとに違い、管理側で
 * 「期待値」を 1 つに決められない（`src/lib/experience-version/deployment-store.ts` の doc 参照）。
 *
 * PII を載せない: 報告に含めるのは版番号・内容の指紋・エラー分類だけで、来訪者情報や設定値
 * そのものは一切送らない（`.claude/rules/pii-secret-minimization.md`）。
 */

export type KioskConfigurationReport =
  | { kind: 'loaded'; revision: number; contentHash: string }
  | { kind: 'failed'; errorCode: string }
  /** 報告しない（旧経路・取得中・版管理を使っていない拠点）。 */
  | { kind: 'none' };

/** 構成取得の結果から報告内容を決める。 */
export function reportForConfiguration(input: {
  status: 'disabled' | 'loading' | 'ready' | 'error';
  revision?: number;
  contentHash?: string;
  /** 取得失敗時の HTTP ステータス。通信断・パース失敗では未定義。 */
  httpStatus?: number;
}): KioskConfigurationReport {
  if (input.status === 'error') {
    return {
      kind: 'failed',
      errorCode: input.httpStatus
        ? `effective_config_${input.httpStatus}`
        : 'effective_config_unreachable',
    };
  }

  if (input.status !== 'ready') return { kind: 'none' };

  // 内容の指紋を持たない構成は報告しない。版管理をまだ使っていない拠点は live 配信
  // （`LIVE_VERSION` = revision 0・指紋なし）で、これを報告すると管理側の突き合わせが
  // 常に不一致になり、正常な端末が「旧版で稼働」として並ぶ。
  if (input.revision === undefined || !input.contentHash) return { kind: 'none' };

  return { kind: 'loaded', revision: input.revision, contentHash: input.contentHash };
}

/**
 * 報告を heartbeat の query パラメータへ写す。`kind: 'none'` は空（既存 30 秒周期に
 * 無用な書込を足さない — サーバは 3 つとも未指定なら記録をスキップする）。
 */
export function configurationReportParams(
  report: KioskConfigurationReport,
): Record<string, string> {
  switch (report.kind) {
    case 'loaded':
      return {
        loadedRevision: String(report.revision),
        loadedConfigHash: report.contentHash,
      };
    case 'failed':
      // `errorRevision` は送らない。取得自体に失敗した端末は「どの版の読込で失敗したか」を
      // 知り得ず、推測値が desired と偶然一致すると `failed` へ誤分類される
      // （`domain/experience-version/deployment.ts` の classifyDeployment 参照）。
      return { errorCode: report.errorCode };
    case 'none':
      return {};
  }
}
