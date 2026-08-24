/**
 * ManagedRuntimeService registry (issue #367 Increment 1)。
 *
 * issue #367 本文「初期サービス設定」の 10 サービス表を**コード側の正本**として定数化する。
 * ここは「どのサービスが運用ポリシーの対象になり得るか」の許可リストであり、CDK が作る物理
 * リソース（`RuntimeResource` / `ServiceRuntimeBinding`）とも、DynamoDB に保存する
 * `ServiceOperatingPolicy` とも**別のレイヤ**である。
 *
 *   - registry（この定数）… CDK/コードでのみ変更できる静的な集合。運用者は増減できない。
 *   - policy（永続層。本 increment の対象外）… 運用者が管理画面から編集する可変値。
 *
 * この分離が「管理画面から営業時間を変更しても CDK drift が発生しない」（#367 受入条件）
 * の前提になる。I/O は持たない純データ。
 */

/** サービスの運用モード（issue #367 本文の `ServiceOperatingMode`）。 */
export type ServiceOperatingMode = 'always_on' | 'follow_operating_hours' | 'custom_schedule' | 'manual_only';

/**
 * 受付画面が利用できる「能力」（issue #367 本文の `RuntimeCapability`）。
 * 単純な ON/OFF ではなく、どの体験が使えるかを kiosk へ返すための語彙。
 */
export type RuntimeCapability =
  | 'speech_input'
  | 'dynamic_speech_output'
  | 'ai_intent_resolution'
  | 'notify_staff'
  | 'live_bridge';

/** `RuntimeCapability` の全列挙（テスト・UI の網羅チェック用）。 */
export const RUNTIME_CAPABILITIES: readonly RuntimeCapability[] = [
  'speech_input',
  'dynamic_speech_output',
  'ai_intent_resolution',
  'notify_staff',
  'live_bridge',
];

/** registry が管理するサービスキー（issue #367 本文の表と 1:1）。 */
export type ManagedRuntimeServiceKey =
  | 'realtime-conversation'
  | 'stt'
  | 'dynamic-tts'
  | 'bedrock'
  | 'vonage-pstn'
  | 'qr-resolution'
  | 'touch-reception'
  | 'signage'
  | 'admin'
  | 'monitoring';

/** registry の 1 エントリ。 */
export type ManagedRuntimeService = {
  readonly serviceKey: ManagedRuntimeServiceKey;
  /** ポリシー未設定時に使う既定モード。 */
  readonly defaultMode: ServiceOperatingMode;
  /**
   * 依存するサービス（start は依存順・stop は逆依存順）。
   * 依存先が動いていない状態で依存元だけを running にはしない（安全側補正）。
   */
  readonly dependsOn: readonly ManagedRuntimeServiceKey[];
  /** running のときに提供する能力。1 能力の提供元は 1 サービスに限る（欠落原因を一意に辿るため）。 */
  readonly provides: readonly RuntimeCapability[];
};

/**
 * issue #367「初期サービス設定」表。順序は表と同じ（解決結果の並び順もこれに従う）。
 *
 * 依存の考え方:
 *   - `stt` / `dynamic-tts` はリアルタイム会話ランタイム（EC2）上のセッションに載るため、
 *     ランタイムが停止していれば成立しない。
 *   - `bedrock` / `vonage-pstn` はマネージド外部サービスで、EC2 の起動状態とは独立に呼べる。
 *     （営業時間外に「新規呼び出し禁止」「新規発信禁止」にするのはモード側の責務。）
 *
 * 能力の割り当て:
 *   - `speech_input` = STT、`dynamic_speech_output` = 動的 TTS、`ai_intent_resolution` = Bedrock。
 *   - `live_bridge`（有人接続）= Vonage PSTN 発信。
 *   - `notify_staff`（担当者への通知）= monitoring。表の「監視・通知継続」に対応し、営業時間外
 *     でも通知経路を残す（always_on）。
 *   - `realtime-conversation` 自身は能力を提供しない（STT/TTS を載せる器であり、能力欠落は
 *     依存補正を通じて stt / dynamic-tts 側に現れる）。
 */
export const MANAGED_RUNTIME_SERVICES: readonly ManagedRuntimeService[] = [
  { serviceKey: 'realtime-conversation', defaultMode: 'follow_operating_hours', dependsOn: [], provides: [] },
  { serviceKey: 'stt', defaultMode: 'follow_operating_hours', dependsOn: ['realtime-conversation'], provides: ['speech_input'] },
  { serviceKey: 'dynamic-tts', defaultMode: 'follow_operating_hours', dependsOn: ['realtime-conversation'], provides: ['dynamic_speech_output'] },
  { serviceKey: 'bedrock', defaultMode: 'follow_operating_hours', dependsOn: [], provides: ['ai_intent_resolution'] },
  { serviceKey: 'vonage-pstn', defaultMode: 'follow_operating_hours', dependsOn: [], provides: ['live_bridge'] },
  { serviceKey: 'qr-resolution', defaultMode: 'always_on', dependsOn: [], provides: [] },
  { serviceKey: 'touch-reception', defaultMode: 'always_on', dependsOn: [], provides: [] },
  { serviceKey: 'signage', defaultMode: 'always_on', dependsOn: [], provides: [] },
  { serviceKey: 'admin', defaultMode: 'always_on', dependsOn: [], provides: [] },
  { serviceKey: 'monitoring', defaultMode: 'always_on', dependsOn: [], provides: ['notify_staff'] },
];

/** registry の serviceKey 一覧（許可リスト）。 */
export const MANAGED_RUNTIME_SERVICE_KEYS: readonly ManagedRuntimeServiceKey[] = MANAGED_RUNTIME_SERVICES.map(
  (service) => service.serviceKey,
);

/** serviceKey から registry エントリを引く。未知キーは undefined（許可リスト外は無視する）。 */
export function findManagedRuntimeService(key: ManagedRuntimeServiceKey): ManagedRuntimeService | undefined {
  return MANAGED_RUNTIME_SERVICES.find((service) => service.serviceKey === key);
}
