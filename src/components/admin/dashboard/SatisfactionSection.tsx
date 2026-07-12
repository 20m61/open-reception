'use client';

import { useState } from 'react';
import type { CallOutcome } from '@/domain/reception/session';
import type { SatisfactionSummary } from '@/domain/reception/satisfaction-summary';
import type { ExperiencePeriodKey, SatisfactionPeriodKpi } from '@/domain/reception/dashboard-summary';
import { Button } from '@/components/admin/ui';
import { color, space } from '../ui/tokens';
import { MetricCard } from './MetricCard';
import { Section, CardGrid } from './Section';

/**
 * ワンタップ満足度フィードバック セクション (issue #320)。
 *
 * 来訪者の声を拾うチャネルが無かったことに対する増分。KPI（#319, 「行動」の計測）に対して
 * 本セクションは「感想」の集計を示す: 評価分布・終端状態（outcome）別内訳・理由コード別件数。
 *
 * 期間指定 (AC「期間指定の評価集計が見られる」): `periods`（本日/直近7日/直近30日を JST 暦日境界で
 * 集計済み）を受け取り、追加 API を叩かずクライアント側で表示期間を切り替える（体験 KPI セクションと
 * 同じ方式）。`periods` 未提供（rolling deploy 中の旧 API 形）の場合は `summary`（本日）を表示する。
 *
 * 管理画面ラベルは日本語のまま（kiosk 向けではないため i18n 対象外、ExperienceKpiSection と同方針）。
 */
const RATING_LABEL: Record<string, string> = {
  happy: '😊 満足',
  neutral: '😐 普通',
  unhappy: '😞 不満',
};

const OUTCOME_LABEL: Record<CallOutcome, string> = {
  connected: '接続',
  timeout: '未応答',
  failed: '失敗',
  cancelled: 'キャンセル',
};

const REASON_LABEL: Record<string, string> = {
  waitTooLong: '待ち時間が長い',
  hardToOperate: '操作が分かりにくい',
  staffUnavailable: '担当者につながらなかった',
  other: 'その他',
};

function pct(numerator: number, denominator: number): string {
  return denominator === 0 ? '—' : `${Math.round((numerator / denominator) * 100)}%`;
}

export function SatisfactionSection({
  summary,
  periods,
}: {
  summary: SatisfactionSummary;
  periods?: SatisfactionPeriodKpi[];
}) {
  const [selectedKey, setSelectedKey] = useState<ExperiencePeriodKey>(periods?.[0]?.key ?? 'today');
  const selected = periods?.find((p) => p.key === selectedKey) ?? periods?.[0];
  const s = selected?.summary ?? summary;
  const periodLabel = selected?.label ?? '本日';

  const outcomesWithData = (Object.keys(s.byOutcome) as CallOutcome[]).filter(
    (o) => Object.values(s.byOutcome[o]).some((n) => n > 0),
  );

  return (
    <Section title="来訪者満足度">
      {periods && periods.length > 0 ? (
        <div
          data-testid="satisfaction-period-picker"
          role="group"
          aria-label="集計期間"
          style={{ display: 'flex', gap: space.sm, flexWrap: 'wrap', marginBottom: space.md }}
        >
          {periods.map((p) => {
            const active = p.key === selectedKey;
            return (
              <Button
                key={p.key}
                type="button"
                variant={active ? 'primary' : 'ghost'}
                aria-pressed={active}
                data-testid={`satisfaction-period-${p.key}`}
                onClick={() => setSelectedKey(p.key)}
              >
                {p.label}
              </Button>
            );
          })}
        </div>
      ) : null}

      <p style={{ opacity: 0.75, marginTop: 0, maxWidth: 680 }} data-testid="satisfaction-responded">
        {periodLabel}の集計。フィードバック件数: {s.responded} / {s.total} 件（任意評価のため受付件数と一致しません）。
      </p>

      <CardGrid>
        {(['happy', 'neutral', 'unhappy'] as const).map((rating) => (
          <MetricCard
            key={rating}
            label={RATING_LABEL[rating] ?? rating}
            value={s.byRating[rating]}
            unit="件"
            tone={rating === 'unhappy' && s.byRating[rating] > 0 ? 'warning' : 'neutral'}
            hint={`回答比 ${pct(s.byRating[rating], s.responded)}`}
          />
        ))}
      </CardGrid>

      <div style={{ marginTop: space.lg }} data-testid="satisfaction-by-outcome">
        <h3 style={{ margin: `0 0 ${space.sm}px` }}>終端状態別の内訳</h3>
        <p style={{ opacity: 0.7, marginTop: 0 }}>接続・未応答・失敗のどれで評価が分かれているかを確認できます。</p>
        {outcomesWithData.length === 0 ? (
          <p style={{ opacity: 0.7 }} data-testid="satisfaction-by-outcome-empty">
            この期間はまだフィードバックがありません。
          </p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: space.sm }}>
            {outcomesWithData.map((outcome) => {
              const row = s.byOutcome[outcome];
              const total = row.happy + row.neutral + row.unhappy;
              return (
                <li
                  key={outcome}
                  data-testid={`satisfaction-outcome-${outcome}`}
                  style={{ display: 'grid', gridTemplateColumns: '8rem 1fr', alignItems: 'center', gap: space.sm }}
                >
                  <span>{OUTCOME_LABEL[outcome]}</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                    😊 {row.happy} ・ 😐 {row.neutral} ・{' '}
                    <span style={{ color: row.unhappy > 0 ? color.danger : undefined }}>😞 {row.unhappy}</span>
                    {' '}（計 {total} 件）
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div style={{ marginTop: space.lg }} data-testid="satisfaction-by-reason">
        <h3 style={{ margin: `0 0 ${space.sm}px` }}>理由チップの内訳</h3>
        <p style={{ opacity: 0.7, marginTop: 0 }}>
          評価に添えられた定型理由（複数選択可・自由記述は無し）の件数です。
        </p>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', gap: space.md, flexWrap: 'wrap' }}>
          {(Object.keys(s.byReasonCode) as (keyof typeof s.byReasonCode)[]).map((code) => (
            <li key={code} data-testid={`satisfaction-reason-${code}`}>
              <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{s.byReasonCode[code]}</strong>{' '}
              <span style={{ opacity: 0.75 }}>{REASON_LABEL[code] ?? code}</span>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}
