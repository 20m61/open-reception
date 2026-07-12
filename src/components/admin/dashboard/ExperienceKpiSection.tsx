import type { ExperienceKpi } from '@/domain/reception/experience-summary';
import { color, space } from '../ui/tokens';
import { MetricCard } from './MetricCard';
import { Section, CardGrid } from './Section';

/**
 * 受付体験 KPI セクション (issue #319)。
 *
 * 「30 秒以内呼び出し開始率・完遂率・中央値所要」を主要指標カードで、ステップ別ファネルを
 * 到達バーで表示する。体験メトリクスを持つ受付のみが 30 秒 KPI/ファネルの対象になるため、
 * 測定件数（measured）を添えて母数を明示する。表示は本日（JST）分の集計（#254 と境界を揃える）。
 *
 * 数値の定義（分子/分母）は docs/reception-experience-kpi.md を参照。管理画面ラベルは日本語のまま
 * （kiosk 向けではないため i18n 対象外）。
 */
const STEP_LABEL: Record<string, string> = {
  selectingPurpose: '用件選択',
  selectingTarget: '呼び出し先選択',
  inputVisitorInfo: '来訪者情報入力',
  confirming: '確認',
  calling: '呼び出し',
  connected: '接続',
};

const INPUT_METHOD_LABEL: Record<string, string> = {
  touch: 'タッチ',
  stt: '音声',
  chat: 'チャット',
  qr: 'QR',
};

function pct(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

function seconds(ms: number | null): string {
  return ms === null ? '—' : `${(ms / 1000).toFixed(1)} 秒`;
}

export function ExperienceKpiSection({ experience }: { experience: ExperienceKpi }) {
  const { callStartWithin30s, completion, funnel, inputMethods, measured } = experience;
  const reachedTop = Math.max(1, funnel[0]?.reached ?? 0);

  return (
    <Section title="受付体験 KPI（本日）">
      <p style={{ opacity: 0.75, marginTop: 0, maxWidth: 680 }} data-testid="experience-measured">
        体験メトリクス記録あり: {measured} 件（30 秒 KPI・ファネルの母数）。定義は KPI 定義ドキュメント参照。
      </p>
      <CardGrid>
        <MetricCard
          label="30 秒以内 呼び出し開始率"
          value={pct(experience.callStartWithin30sRate)}
          tone={experience.callStartWithin30sRate !== null && experience.callStartWithin30sRate >= 0.8 ? 'success' : 'neutral'}
          href="/admin/receptions"
          hint={`30 秒以内 ${callStartWithin30s.within} / 呼び出し到達 ${callStartWithin30s.reached}`}
        />
        <MetricCard
          label="完遂率"
          value={pct(experience.completionRate)}
          href="/admin/receptions"
          hint={`接続 ${completion.connected} / 受付 ${completion.total}`}
        />
        <MetricCard
          label="所要時間の中央値"
          value={seconds(experience.medianDurationMs)}
          href="/admin/receptions"
          hint="受付開始から終了までの中央値"
        />
      </CardGrid>

      <div style={{ marginTop: space.lg }} data-testid="experience-funnel">
        <h3 style={{ margin: `0 0 ${space.sm}px` }}>ステップ別ファネル</h3>
        <p style={{ opacity: 0.7, marginTop: 0 }}>各ステップへの到達数と、そのステップでの離脱数（離脱が多い局面を特定できます）。</p>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: space.sm }}>
          {funnel.map((f) => {
            const widthPct = Math.round((f.reached / reachedTop) * 100);
            return (
              <li key={f.step} data-testid={`funnel-${f.step}`} style={{ display: 'grid', gridTemplateColumns: '10rem 1fr auto', alignItems: 'center', gap: space.sm }}>
                <span>{STEP_LABEL[f.step] ?? f.step}</span>
                <span aria-hidden="true" style={{ background: color.surface2, borderRadius: 4, height: 12, overflow: 'hidden' }}>
                  <span style={{ display: 'block', width: `${widthPct}%`, height: '100%', background: color.accent }} />
                </span>
                <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  到達 {f.reached}
                  {f.abandoned > 0 ? <span style={{ color: color.danger }}>・離脱 {f.abandoned}</span> : null}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <div style={{ marginTop: space.lg }} data-testid="experience-input-methods">
        <h3 style={{ margin: `0 0 ${space.sm}px` }}>入力手段の利用</h3>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', gap: space.md, flexWrap: 'wrap' }}>
          {(Object.keys(inputMethods) as (keyof typeof inputMethods)[]).map((m) => (
            <li key={m} data-testid={`input-method-${m}`}>
              <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{inputMethods[m]}</strong>{' '}
              <span style={{ opacity: 0.75 }}>{INPUT_METHOD_LABEL[m] ?? m}</span>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}
