/**
 * 受付フローストア / ReceptionFlowService の組み立て (issue #100, increment 1)。
 *
 * route から使う ReceptionFlowService を 1 つ生成して共有する。永続化は getBackend()
 * （DATA_BACKEND=memory|dynamodb）に委譲する DataBackedReceptionFlowRepository。
 *
 * dev seed は memory backend のみ有効（dynamodb では無視され実データを正とする）。
 * 既定テナント（internal / default-site）に投入する。管理画面・受付端末（kiosk）とも
 * 同じ既定プロビジョニング・スコープ（lib/tenant/default-scope）を参照するため、
 * いずれの初期表示でも同じフローが見える（#171）。
 *
 * 監査は既存 appendAdminAudit（src/lib/data-stores/reception-log-store）を使い、
 * actor=admin・PII なしで記録する（事前定義済み reception_flow.* アクションを参照）。
 */
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';
import { asReceptionFlowId } from '@/domain/reception/custom-flow';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import { DataBackedReceptionFlowRepository } from './repository';
import { ReceptionFlowService } from './service';
import type { StoredReceptionFlow } from './types';

const SEED_TS = '2026-01-01T00:00:00.000Z';

function seedFlow(
  id: string,
  tenantId: string,
  siteId: string,
  partial: Omit<
    StoredReceptionFlow,
    'id' | 'tenantId' | 'siteId' | 'createdAt' | 'updatedAt'
  >,
): StoredReceptionFlow {
  return {
    id: asReceptionFlowId(id),
    tenantId: asTenantId(tenantId),
    siteId: asSiteId(siteId),
    ...partial,
    createdAt: SEED_TS,
    updatedAt: SEED_TS,
  };
}

/** 各テナント/サイトに投入する初期フロー（通常受付・面接・宅配の 3 目的）。 */
function seedFlowsFor(prefix: string, tenantId: string, siteId: string): StoredReceptionFlow[] {
  return [
    seedFlow(`flow-${prefix}-general`, tenantId, siteId, {
      purposeKey: 'general',
      displayName: '通常来訪',
      description: 'ご担当者または部署を選んでお呼び出しします。',
      order: 0,
      enabled: true,
      steps: ['purpose', 'target', 'visitorInfo', 'confirm', 'call'],
      fields: [
        { key: 'name', label: 'お名前', type: 'text', required: false },
        { key: 'company', label: '会社名', type: 'text', required: false },
      ],
      completionMessage: undefined,
    }),
    seedFlow(`flow-${prefix}-interview`, tenantId, siteId, {
      purposeKey: 'interview',
      displayName: '面接・採用候補者',
      description: '面接でお越しの方はこちら。',
      order: 1,
      enabled: true,
      steps: ['purpose', 'visitorInfo', 'confirm', 'call'],
      fields: [
        { key: 'name', label: 'お名前', type: 'text', required: true },
        { key: 'appointment-time', label: '面接予定時刻', type: 'text', required: false },
      ],
      completionMessage: '担当者がお迎えにあがります。少々お待ちください。',
    }),
    seedFlow(`flow-${prefix}-delivery`, tenantId, siteId, {
      purposeKey: 'delivery',
      displayName: '宅配・納品',
      description: '配送・納品でお越しの方はこちら。',
      order: 2,
      enabled: true,
      steps: ['purpose', 'visitorInfo', 'confirm', 'call'],
      fields: [
        { key: 'carrier', label: '配送業者名', type: 'text', required: false },
        { key: 'requires-signature', label: '受領サインが必要', type: 'checkbox', required: false },
      ],
      completionMessage: '担当者が受け取りにまいります。',
    }),
  ];
}

function seed(): StoredReceptionFlow[] {
  // E2E では dev seed を無効化する (issue #239)。/kiosk がセッション必須になった結果、enroll 済み
  // kiosk が常に seed 済みカスタムフローを表示し、既定（組込み）受付フローを検証する e2e と衝突する
  // ため。dev/デモ（npm run dev）では従来どおり seed する。dynamodb では seed 自体が無視される。
  if (process.env.RECEPTION_DISABLE_DEV_SEED === '1') return [];
  return [...seedFlowsFor('internal', 'internal', 'default-site')];
}

let service: ReceptionFlowService | undefined;

export function getReceptionFlowService(): ReceptionFlowService {
  if (!service) {
    service = new ReceptionFlowService({
      flows: new DataBackedReceptionFlowRepository(seed),
      appendAudit: appendAdminAudit,
    });
  }
  return service;
}

/** テスト用: サービスを破棄する（次回 getReceptionFlowService で再生成）。 */
export function __resetReceptionFlowService(): void {
  service = undefined;
}
