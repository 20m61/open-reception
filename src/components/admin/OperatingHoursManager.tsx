'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Field, SaveFeedback, useSaveFeedback } from '@/components/admin/ui';
import { color, space } from '@/components/admin/ui/tokens';
import { WEEKDAYS, type Weekday } from '@/domain/operating-policy/tz';
import { formatExceptionsText, formatTimeRanges, parseExceptionsText, parseTimeRangesText } from '@/domain/operating-policy/text-format';
import type { ServiceOperatingPolicy } from '@/domain/operating-policy/types';

const WEEKDAY_LABEL: Record<Weekday, string> = {
  mon: '月', tue: '火', wed: '水', thu: '木', fri: '金', sat: '土', sun: '日',
};

type PolicyView = ServiceOperatingPolicy | null;

/**
 * 営業時間ポリシー編集 (issue #367)。
 *
 * 曜日別営業時間・固定休業日・単発例外日を「文章形式」テキスト入力で編集する（既存の
 * `RoutingPolicyManager`/`SecurityManager` の慣例に合わせ、テーブル UI ではなくテキスト欄 +
 * 保存時サーバ検証の構成）。営業時間帯は "09:00-18:00"（複数はカンマ区切り、日跨ぎは末尾 *、
 * 例: "22:00-02:00*"）。単発例外日は 1 行 1 件 "YYYY-MM-DD:closed" または
 * "YYYY-MM-DD:10:00-15:00"（`@/domain/operating-policy/text-format`、往復変換の純関数）。
 *
 * 保存前検証（逆転区間・オーバーラップ・不正フォーマット）は保存時にサーバ
 * （`validatePolicyInput`）が行い、`issues` をそのまま表示する — フロントでの二重実装を避ける。
 */
export function OperatingHoursManager({ tenantId, siteId }: { tenantId: string; siteId: string }) {
  const [policy, setPolicy] = useState<PolicyView>(null);
  const [loaded, setLoaded] = useState(false);
  const [timezone, setTimezone] = useState('Asia/Tokyo');
  const [weeklyText, setWeeklyText] = useState<Record<Weekday, string>>(
    () => Object.fromEntries(WEEKDAYS.map((d) => [d, ''])) as Record<Weekday, string>,
  );
  const [fixedHolidaysText, setFixedHolidaysText] = useState('');
  const [exceptionsText, setExceptionsText] = useState('');
  const [emergencyContactLabel, setEmergencyContactLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<{ field: string; message: string }[]>([]);
  const { feedback, success, failure, clear } = useSaveFeedback();

  const qs = `tenantId=${encodeURIComponent(tenantId)}&siteId=${encodeURIComponent(siteId)}`;

  const applyPolicy = useCallback((p: PolicyView) => {
    setPolicy(p);
    setTimezone(p?.timezone ?? 'Asia/Tokyo');
    setWeeklyText(
      Object.fromEntries(WEEKDAYS.map((d) => [d, formatTimeRanges(p?.weeklySchedule[d] ?? [])])) as Record<
        Weekday,
        string
      >,
    );
    setFixedHolidaysText((p?.fixedHolidays ?? []).join('\n'));
    setExceptionsText(formatExceptionsText(p?.exceptionDates ?? []));
    setEmergencyContactLabel(p?.emergencyContactLabel ?? '');
  }, []);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/operating-policy?${qs}`);
    if (res.ok) {
      const body = (await res.json()) as { policy: PolicyView };
      applyPolicy(body.policy);
    }
    setLoaded(true);
  }, [qs, applyPolicy]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    clear();
    setIssues([]);
    try {
      const weeklySchedule: Partial<Record<Weekday, ReturnType<typeof parseTimeRangesText>>> = {};
      for (const d of WEEKDAYS) {
        const ranges = parseTimeRangesText(weeklyText[d]);
        if (ranges.length > 0) weeklySchedule[d] = ranges;
      }
      const fixedHolidays = fixedHolidaysText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const exceptionDates = parseExceptionsText(exceptionsText);

      const res = await fetch('/api/admin/operating-policy', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenantId,
          siteId,
          timezone: timezone.trim() || 'Asia/Tokyo',
          weeklySchedule,
          fixedHolidays,
          exceptionDates,
          ...(emergencyContactLabel.trim() ? { emergencyContactLabel: emergencyContactLabel.trim() } : {}),
        }),
      });
      if (res.ok) {
        const body = (await res.json()) as { policy: PolicyView };
        applyPolicy(body.policy);
        success();
      } else {
        const body = (await res.json().catch(() => null)) as { issues?: { field: string; message: string }[] } | null;
        setIssues(body?.issues ?? []);
        failure();
      }
    } finally {
      setBusy(false);
    }
  }, [busy, clear, weeklyText, fixedHolidaysText, exceptionsText, timezone, emergencyContactLabel, tenantId, siteId, applyPolicy, success, failure]);

  if (!loaded) {
    return (
      <section>
        <h1 style={{ marginTop: 0 }}>営業時間設定</h1>
        <p>読み込み中…</p>
      </section>
    );
  }

  return (
    <section style={{ maxWidth: 640 }}>
      <h1 style={{ marginTop: 0 }}>営業時間設定</h1>
      <p style={{ color: color.muted }}>
        営業時間外は受付端末で待機画面の代わりに営業時間外案内が表示され、新規発信は拒否されます。
        {policy ? (
          <> 現在 version {policy.version}（最終更新 {policy.updatedAt} / {policy.updatedBy}）。</>
        ) : (
          <> まだ設定がありません（未設定の間は常時営業として扱われます）。</>
        )}
      </p>

      {issues.length > 0 ? (
        <div className="notice notice--danger" data-testid="operating-hours-issues" style={{ marginBottom: space.md }}>
          <strong>入力に誤りがあります</strong>
          <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
            {issues.map((issue, i) => (
              <li key={i}>
                {issue.field}: {issue.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: space.md }}>
        <Field label="タイムゾーン（IANA 名。既定 Asia/Tokyo）" htmlFor="operating-hours-timezone">
          <input
            id="operating-hours-timezone"
            data-testid="operating-hours-timezone"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            style={input}
          />
        </Field>

        <fieldset style={{ border: '1px solid var(--color-surface-2)', borderRadius: 8, padding: space.sm }}>
          <legend>曜日別営業時間（例: 09:00-18:00 / 複数区間はカンマ区切り / 日跨ぎは末尾に * ）</legend>
          <div style={{ display: 'flex', flexDirection: 'column', gap: space.xs }}>
            {WEEKDAYS.map((d) => (
              <Field key={d} label={WEEKDAY_LABEL[d]} htmlFor={`operating-hours-${d}`}>
                <input
                  id={`operating-hours-${d}`}
                  data-testid={`operating-hours-weekday-${d}`}
                  placeholder="空欄は終日休業"
                  value={weeklyText[d]}
                  onChange={(e) => setWeeklyText((prev) => ({ ...prev, [d]: e.target.value }))}
                  style={input}
                />
              </Field>
            ))}
          </div>
        </fieldset>

        <Field label="固定休業日（毎年、1行1件・MM-DD。例: 01-01）" htmlFor="operating-hours-fixed-holidays">
          <textarea
            id="operating-hours-fixed-holidays"
            data-testid="operating-hours-fixed-holidays"
            rows={3}
            value={fixedHolidaysText}
            onChange={(e) => setFixedHolidaysText(e.target.value)}
            style={input}
          />
        </Field>

        <Field
          label="単発の休業日/臨時営業（1行1件・YYYY-MM-DD:closed または YYYY-MM-DD:09:00-12:00）"
          htmlFor="operating-hours-exceptions"
        >
          <textarea
            id="operating-hours-exceptions"
            data-testid="operating-hours-exceptions"
            rows={4}
            value={exceptionsText}
            onChange={(e) => setExceptionsText(e.target.value)}
            style={input}
          />
        </Field>

        <Field label="営業時間外案内の緊急連絡ラベル（実電話番号等は入れない。表示ラベルのみ）" htmlFor="operating-hours-emergency-label">
          <input
            id="operating-hours-emergency-label"
            data-testid="operating-hours-emergency-label"
            value={emergencyContactLabel}
            onChange={(e) => setEmergencyContactLabel(e.target.value)}
            style={input}
          />
        </Field>

        <div style={{ display: 'flex', gap: space.sm, alignItems: 'center' }}>
          <Button variant="primary" data-testid="operating-hours-save" onClick={save} disabled={busy}>
            保存
          </Button>
          <SaveFeedback feedback={feedback} successTestId="operating-hours-saved" errorTestId="operating-hours-error" />
        </div>
      </div>
    </section>
  );
}

const input: React.CSSProperties = {
  minHeight: 40,
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--color-surface-2)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
};
