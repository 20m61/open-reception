'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Field, SaveFeedback, useSaveFeedback } from '@/components/admin/ui';
import { useSiteScope } from './use-site-scope';
import { SiteScopeSelect } from './SiteScopeSelect';
import { color, space } from '@/components/admin/ui/tokens';
import { WEEKDAYS, type Weekday } from '@/domain/operating-policy/tz';
import { duplicateExceptionDates } from '@/domain/operating-policy/schedule';
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
export function OperatingHoursManager({
  tenantId,
  siteId: defaultSiteId,
}: {
  tenantId: string;
  /** サーバ (`resolveDefaultScope`) 由来の既定拠点。URL 未指定時のフォールバック。 */
  siteId: string;
}) {
  // 対象拠点は URL が真実源 (#421)。以前はここが既定拠点に固定で、UI から別拠点の
  // 営業時間へ到達する手段が無かった（env でしか変えられなかった）。
  const { sites, siteId, scopeKey, scopeReady, isCurrentScope, selectSite, sitePending, listStatus, reloadSites } = useSiteScope(
    tenantId,
    defaultSiteId,
  );
  const [policy, setPolicy] = useState<PolicyView>(null);
  /** ほかの管理者が先に保存していた（409）。入力の誤りとは別物として出す。 */
  const [conflict, setConflict] = useState(false);
  /**
   * **どのスコープ（テナント + 拠点）の内容が今フォームに載っているか。**
   *
   * 単なる真偽値だと、切り替えた直後に「前のスコープの値が入ったまま loaded=true」の窓が
   * でき、そこで保存すると**新しい対象の設定を前の対象の値で上書きする**（#534 レビュー P1）。
   * 拠点だけで識別すると、**同じ拠点 ID を持つ別テナント**へ切り替えたときに守れない
   * （#541 レビュー P1）。
   */
  const [loadedScopeKey, setLoadedScopeKey] = useState<string | null>(null);
  const loaded = loadedScopeKey === scopeKey;
  const [timezone, setTimezone] = useState('Asia/Tokyo');
  const [weeklyText, setWeeklyText] = useState<Record<Weekday, string>>(
    () => Object.fromEntries(WEEKDAYS.map((d) => [d, ''])) as Record<Weekday, string>,
  );
  const [fixedHolidaysText, setFixedHolidaysText] = useState('');
  const [exceptionsText, setExceptionsText] = useState('');
  const [duplicateDates, setDuplicateDates] = useState<string[]>([]);
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
    /*
     * 🔴 保存済みの重複を**読み込んだ時点で**知らせる。検証（#799）は新規保存を止めるだけで、
     * 既に入っている重複は残り続ける——読み側は先勝ちなので、臨時営業日に受付が開かない。
     * 保存を押すまで気づけないと、そのときには当該の日は過ぎている。
     */
    setDuplicateDates(duplicateExceptionDates(p?.exceptionDates ?? []));
    setEmergencyContactLabel(p?.emergencyContactLabel ?? '');
  }, []);

  const load = useCallback(async () => {
    // 拠点が確定するまで取得しない。確定前に投げると deep link のたびに
    // 既定拠点への要求が先に飛び、応答順次第で選択中でない拠点の内容が載る。
    if (!scopeReady) return;
    const requestedScope = scopeKey;
    const res = await fetch(`/api/admin/operating-policy?${qs}`);
    // 取得中に拠点が変わっていたら捨てる。反映すると、セレクタは新拠点なのにフォームは
    // 旧拠点の値、という状態になる（保存は loadedSiteId 不一致で止まるが表示が嘘になる）。
    if (!isCurrentScope(requestedScope)) return;
    if (res.ok) {
      const body = (await res.json()) as { policy: PolicyView };
      applyPolicy(body.policy);
    }
    setLoadedScopeKey(requestedScope);
  }, [qs, siteId, scopeKey, scopeReady, isCurrentScope, applyPolicy]);

  useEffect(() => {
    // 拠点が変わったら「まだ読めていない」へ戻す。これを忘れると前拠点の値のまま
    // 保存できてしまう。
    setLoadedScopeKey((prev) => (prev === scopeKey ? prev : null));
    void load();
  }, [load, scopeKey]);

  const save = useCallback(async () => {
    // 選択中の拠点の内容が載りきるまで保存させない（載っているのは別拠点の値かもしれない）。
    if (busy || !loaded || sitePending) return;
    // **応答の適用にも同じ門が要る** (#554 レビュー B1 と同型)。PUT が飛行中に拠点を
    // 切り替えると、遅れて届いた A の応答が B の画面へ載り、以後 B として保存できてしまう。
    const startedWith = scopeKey;
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
          // 読んだ版を添える (#367)。同時編集の後勝ち上書きをサーバ側で 409 にするため、
          // 既存レコードの更新では必須。未取得（新規作成）のときだけ省く。
          ...(policy ? { expectedVersion: policy.version } : {}),
        }),
      });
      if (!isCurrentScope(startedWith)) return;
      if (res.ok) {
        const body = (await res.json()) as { policy: PolicyView };
        applyPolicy(body.policy);
        setLoadedScopeKey(startedWith);
        success();
      } else {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
          issues?: { field: string; message: string }[];
        } | null;
        if (res.status === 409) {
          // 競合は「入力の誤り」ではない。検証 issue のリストへ相乗りさせず、専用の通知に
          // する（見出しが「入力に誤りがあります」になり、`version:` という内部フィールド名が
          // 運用者に出ていた）。**次に何をすべきか**は押せる導線として置く。
          setConflict(true);
          setIssues([]);
        } else {
          setConflict(false);
          setIssues(body?.issues ?? []);
        }
        failure();
      }
    } finally {
      setBusy(false);
    }
  }, [busy, loaded, sitePending, scopeKey, isCurrentScope, clear, weeklyText, fixedHolidaysText, exceptionsText, timezone, emergencyContactLabel, tenantId, siteId, applyPolicy, success, failure]);

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

      {conflict ? (
        <div
          className="notice notice--warning"
          data-testid="operating-hours-conflict"
          style={{ marginBottom: space.md }}
        >
          <strong>保存できませんでした（ほかの管理者が更新済み）</strong>
          <p style={{ margin: '8px 0 0' }}>
            この拠点の営業時間は、あなたが画面を開いたあとに更新されています。上書きを避けるため
            保存していません。最新を読み込んでから、変更をやり直してください。
          </p>
          <p style={{ margin: '8px 0 0' }}>
            <strong>読み込み直すと、この画面で編集中の内容は失われます。</strong>
          </p>
          <div style={{ marginTop: space.sm }}>
            <Button
              variant="secondary"
              data-testid="operating-hours-reload"
              onClick={() => {
                setConflict(false);
                void load();
              }}
            >
              最新を読み込む
            </Button>
          </div>
        </div>
      ) : null}

      {duplicateDates.length > 0 ? (
        <div
          className="notice notice--warning"
          data-testid="operating-hours-duplicate-exceptions"
          style={{ marginBottom: space.md }}
        >
          <strong>同じ日付の例外日が重複しています</strong>
          <p style={{ margin: '8px 0 0' }}>
            対象日: {duplicateDates.join(' / ')}
          </p>
          <p style={{ margin: '8px 0 0' }}>
            重複した日は<strong>最初の 1 件だけが有効</strong>で、後の行は無視されます。臨時営業の
            設定が効かない原因になります。同じ日に複数の時間帯を設定するには、1 行にまとめて
            カンマで区切ってください（例 10:00-12:00, 14:00-16:00）。
          </p>
        </div>
      ) : null}

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
        {/* 対象拠点を常時表示する (#421「管理者が現在の対象を見失わない」)。 */}
        <SiteScopeSelect
          sites={sites}
          siteId={siteId}
          onSelect={selectSite}
          // 切替が確定するまで触らせない（他 2 画面と揃える。#552 レビュー N2）。
          disabled={sitePending}
          testId="operating-hours-site-select"
          status={listStatus}
          onRetry={reloadSites}
        />
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
          label="単発の休業日/臨時営業（1行1件・YYYY-MM-DD:closed または YYYY-MM-DD:09:00-12:00。同じ日に複数の時間帯はカンマ区切り）"
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
          {/* 拠点切替の遷移確定前は siteId が古いままなので保存しない（#532 と同じ理由）。 */}
          <Button variant="primary" data-testid="operating-hours-save" onClick={save} disabled={busy || sitePending || !loaded}>
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
