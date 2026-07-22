/**
 * 受付体験スタジオの初期デモシナリオ seed (issue #363 Increment 1)。
 *
 * issue #363「初期デモシナリオ」9 件 + #364 音声成功系（担当者/部門解決）2 件を静的定義する。
 * 値は用件カテゴリや合成表示名などのデモ用擬似値のみ（PII なし）。Mock Adapter
 * （`./mock-adapter.ts`）がこの `simulatedResults` を読んで本番 Kiosk のバックエンド応答を
 * 決定論的に返す。
 */
import type { DemoScenario } from './scenario';

export const DEMO_SCENARIOS: ReadonlyArray<DemoScenario> = [
  {
    id: 'normal-visit',
    name: '担当者への通常訪問',
    initialMode: 'reception',
    visitorInputs: [
      { mode: 'touch', value: 'meeting' },
      { mode: 'touch', value: 'staff:sato' },
    ],
    simulatedResults: { call: ['answered'], runtime: 'ready' },
  },
  {
    id: 'unknown-target-interview',
    name: '担当者不明の採用面接',
    initialMode: 'reception',
    visitorInputs: [
      { mode: 'touch', value: 'interview' },
      { mode: 'text', value: '採用担当' },
    ],
    // 担当者が特定できず部門代表が応答する想定。
    simulatedResults: { call: ['answered'], runtime: 'ready' },
  },
  {
    id: 'qr-checkin-valid',
    name: '発行担当者へのQR受付',
    initialMode: 'qr',
    visitorInputs: [{ mode: 'qr', value: 'demo-reservation-token' }],
    simulatedResults: { qr: 'valid', call: ['answered'], runtime: 'ready' },
  },
  {
    id: 'no-answer-escalation',
    name: '個人携帯未応答→代理→部門代表',
    initialMode: 'reception',
    visitorInputs: [
      { mode: 'touch', value: 'meeting' },
      { mode: 'touch', value: 'staff:tanaka' },
    ],
    // 一次（個人携帯）未応答 → 代理未応答 → 部門代表が応答。
    simulatedResults: { call: ['no_answer', 'no_answer', 'answered'], runtime: 'ready' },
  },
  {
    id: 'stt-failure-touch-fallback',
    name: '音声認識失敗→タッチ切替',
    initialMode: 'reception',
    visitorInputs: [
      { mode: 'voice', value: '営業部の鈴木さん' },
      { mode: 'touch', value: 'staff:suzuki' },
    ],
    simulatedResults: { stt: 'error', call: ['answered'], runtime: 'ready' },
  },
  {
    // 音声成功系（#363/#364）。preview で synthetic 音声が自動再生され、発話→復唱→確定→相手選択が
    // 進む。value は合成ディレクトリ（kiosk-injection.demoVoiceDirectory）の担当者に解決する擬似発話。
    // 相手選択画面（selectingTarget）へ到達した瞬間に再生が始まる（第9wave ゼロタッチ化）。
    id: 'voice-staff-visit',
    name: '音声で担当者を呼ぶ（発話→復唱→確定）',
    initialMode: 'reception',
    visitorInputs: [{ mode: 'voice', value: '鈴木' }],
    simulatedResults: { stt: 'success', call: ['answered'], runtime: 'ready' },
  },
  {
    // 部署（department）解決の音声成功系（#364 department 解決デモ、第9wave）。value は合成
    // ディレクトリの部署（kiosk-injection.demoVoiceDirectory の dept-sales「営業部」）に厳密一致で
    // 解決する擬似発話。担当者だけでなく部署も音声で確定できることを示す。
    id: 'voice-department-visit',
    name: '音声で部署を呼ぶ（発話→復唱→部署確定）',
    initialMode: 'reception',
    visitorInputs: [{ mode: 'voice', value: '営業部' }],
    simulatedResults: { stt: 'success', call: ['answered'], runtime: 'ready' },
  },
  {
    id: 'qr-expired',
    name: 'QR期限切れ/使用済み',
    initialMode: 'qr',
    visitorInputs: [{ mode: 'qr', value: 'demo-expired-token' }],
    simulatedResults: { qr: 'expired', runtime: 'ready' },
  },
  {
    id: 'call-failed',
    name: 'Vonage発信失敗',
    initialMode: 'reception',
    visitorInputs: [
      { mode: 'touch', value: 'delivery' },
      { mode: 'touch', value: 'dept:reception' },
    ],
    simulatedResults: { call: ['failed'], runtime: 'ready' },
  },
  {
    id: 'out-of-hours',
    name: '営業時間外',
    initialMode: 'out_of_hours',
    visitorInputs: [],
    simulatedResults: { runtime: 'ready' },
  },
  {
    id: 'signage-attract-reception',
    name: 'サイネージ→ATTRACT→受付開始',
    initialMode: 'signage',
    visitorInputs: [
      { mode: 'touch', value: 'start' },
      { mode: 'touch', value: 'meeting' },
    ],
    simulatedResults: { call: ['answered'], runtime: 'ready' },
  },
];

/** seed シナリオの id 列（表示順を保持）。 */
export const DEMO_SCENARIO_IDS: ReadonlyArray<string> = DEMO_SCENARIOS.map((s) => s.id);

/** id からシナリオを引く。未知 id は undefined。 */
export function getDemoScenario(id: string): DemoScenario | undefined {
  return DEMO_SCENARIOS.find((s) => s.id === id);
}
