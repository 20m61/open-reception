import {
  Button,
  Card,
  CardGrid,
  DangerZone,
  DataTable,
  EmptyState,
  Field,
  FormRow,
  MetricCard,
  Section,
  SecretStatusField,
  StatusBadge,
  type Column,
  type StatusKind,
} from '@/components/admin/ui';

/**
 * 開発者向け UI カタログ (issue #92, increment 1)。
 *
 * `src/components/admin/ui/**` の共有プリミティブを目視確認するための自前ルート。
 * 既存ナビ（navigation.ts）には **載せない**（直接 /admin/ui-catalog を開く）。
 * 本ページは ui/ プリミティブのみを使い、他トラックの領域には一切触れない。
 *
 * 注: /admin レイアウトの認証ガード配下に入る（dev 確認時はログイン済みであること）。
 */
const STATUSES: StatusKind[] = ['ok', 'warning', 'critical', 'stopped', 'maintenance'];

type SampleRow = { name: string; status: StatusKind; count: number };
const SAMPLE_ROWS: SampleRow[] = [
  { name: '受付端末 A', status: 'ok', count: 12 },
  { name: '受付端末 B', status: 'warning', count: 3 },
  { name: '受付端末 C', status: 'stopped', count: 0 },
];
const COLUMNS: Column<SampleRow>[] = [
  { key: 'name', header: '対象', cell: (r) => r.name },
  { key: 'status', header: '状態', cell: (r) => <StatusBadge status={r.status} /> },
  { key: 'count', header: '件数', align: 'right', cell: (r) => r.count },
];

export default function UiCatalogPage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <h1 style={{ margin: 0 }}>管理画面 UI カタログ</h1>
      <p style={{ opacity: 0.7, margin: 0 }}>
        共有プリミティブ（src/components/admin/ui）の見た目確認用。デザイン方針は
        docs/component-catalog.md を参照。
      </p>

      <Section title="状態表現 StatusBadge" description="正常 / 注意 / 異常 / 停止 / メンテナンス中">
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {STATUSES.map((s) => (
            <StatusBadge key={s} status={s} />
          ))}
        </div>
      </Section>

      <Section title="指標カード MetricCard / CardGrid">
        <CardGrid>
          <MetricCard label="本日の受付" value={128} unit="件" tone="success" hint="前日比 +12" />
          <MetricCard label="未応答" value={4} unit="件" tone="warning" />
          <MetricCard label="今月の予想コスト" value="¥12,300" tone="neutral" hint="概算・予想値" />
          <MetricCard label="未接続指標" placeholder note="実データ未接続（次増分で接続）" />
        </CardGrid>
      </Section>

      <Section title="ボタン Button">
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Button variant="primary">主操作</Button>
          <Button variant="secondary">副操作</Button>
          <Button variant="ghost">控えめ</Button>
          <Button variant="danger">危険操作</Button>
        </div>
      </Section>

      <Section title="テーブル DataTable">
        <Card>
          <DataTable columns={COLUMNS} rows={SAMPLE_ROWS} rowKey={(r) => r.name} />
        </Card>
      </Section>

      <Section title="空状態 EmptyState">
        <EmptyState
          title="データがありません"
          message="まだ受付履歴がありません。"
          action={<Button variant="primary">追加する</Button>}
        />
      </Section>

      <Section title="フォーム Field / FormRow">
        <Card>
          <FormRow>
            <Field label="表示名" htmlFor="demo-name" hint="一覧に表示される名前" required>
              <input id="demo-name" className="input" style={{ minHeight: 34, fontSize: '0.95rem', padding: '6px 12px' }} />
            </Field>
            <Field label="メール" htmlFor="demo-mail" error="メールアドレスの形式が不正です">
              <input id="demo-mail" className="input" style={{ minHeight: 34, fontSize: '0.95rem', padding: '6px 12px' }} />
            </Field>
          </FormRow>
        </Card>
      </Section>

      <Section title="シークレット状態 SecretStatusField" description="値は表示せず状態のみ">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SecretStatusField name="VONAGE_API_KEY" presence="configured" updatedLabel="最終更新: 2026-06-01" />
          <SecretStatusField name="VONAGE_API_SECRET" presence="needs_rotation" updatedLabel="最終更新: 2025-12-01" actions={<Button variant="secondary">更新済みにする</Button>} />
          <SecretStatusField name="SMTP_PASSWORD" presence="missing" />
        </div>
      </Section>

      <Section title="危険操作 DangerZone" description="挙動は #91 danger/ が担当。ここは器のみ">
        <DangerZone description="この操作は取り消せません。実行前に対象を必ず確認してください。">
          <Button variant="danger">テナントを削除する</Button>
        </DangerZone>
      </Section>
    </div>
  );
}
