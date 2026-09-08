'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Field, Form, SaveFeedback, saveFailureMessage, siteLabel, useSaveFeedback } from '@/components/admin/ui';
import { useSiteScope } from './use-site-scope';
import { resolveScopeGate } from './scope-gate';
import { EmptyState } from '@/components/admin/ui';
import { SiteScopeSelect } from './SiteScopeSelect';
import { color, space } from '@/components/admin/ui/tokens';
import { WEEKDAYS, type Weekday } from '@/domain/operating-policy/tz';
import { duplicateExceptionDates } from '@/domain/operating-policy/schedule';
import { formatExceptionsText, formatTimeRanges, parseExceptionsText, parseTimeRangesText } from '@/domain/operating-policy/text-format';
import {
  asOperatingPolicyResponse,
  asSavedOperatingPolicyResponse,
} from '@/domain/operating-policy/parse';
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
  /**
   * **取得に失敗したこと**を状態として持つ (#870 増分 03)。
   *
   * 以前は `setLoadedScopeKey` を `if (res.ok)` の**外**で呼んでいたため、401 / 403 / 5xx /
   * オフラインでも「読めた」状態になっていた。その結果、画面は
   * **「まだ設定がありません（未設定の間は常時営業として扱われます）」と断定表示**する ——
   * 取得できていないことを、設定が無いことと言い換えていた。
   *
   * さらに悪いことに、その状態からの保存は `policy` が null なので `expectedVersion` を
   * 落とす。**この画面が土台にしている楽観ロック（#367）も同時に外れる**ため、他の管理者の
   * 更新を黙って上書きできてしまう。
   */
  const [loadFailed, setLoadFailed] = useState(false);
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

  /**
   * 可否と「出せない理由」の判断は 1 箇所へ寄せる (#870 増分 03)。
   *
   * `SignageManager` / `StaffResponseManager` / `ReservationsManager` と同じ `resolveScopeGate`
   * を使う。**理由の種別**（拠点一覧が読めない / 拠点が 0 件 / この画面の取得に失敗 / まだ）を
   * 返すので、失敗を「読み込み中…」や「未設定」と言い換えずに済む。
   */
  const gate = resolveScopeGate({
    scopeReady,
    dataLoaded: loaded,
    sitePending,
    busy,
    listStatus,
    loadFailed,
    hasSites: sites.length > 0,
  });

  const load = useCallback(async () => {
    // 拠点が確定するまで取得しない。確定前に投げると deep link のたびに
    // 既定拠点への要求が先に飛び、応答順次第で選択中でない拠点の内容が載る。
    if (!scopeReady) return;
    const requestedScope = scopeKey;
    // `catch` が無いとオフラインで例外になり、`void load()` が握り潰して**失敗にすら
    // 落ちない**（画面は「読み込み中…」のまま固まる）。
    const res = await fetch(`/api/admin/operating-policy?${qs}`).catch(() => null);
    // 取得中に拠点が変わっていたら捨てる。反映すると、セレクタは新拠点なのにフォームは
    // 旧拠点の値、という状態になる（保存は loadedSiteId 不一致で止まるが表示が嘘になる）。
    if (!isCurrentScope(requestedScope)) return;
    if (!res?.ok) {
      // **`setLoadedScopeKey` をここで呼ばない。** 呼ぶと「読めた」ことになり、
      // 未設定と断定表示し、楽観ロックまで外れる（上の `loadFailed` のコメント）。
      setLoadFailed(true);
      return;
    }
    // 🔴 **形を確かめてから載せる**（#1004）。`policy` キーごと欠けた 200 で
    // `applyPolicy(undefined)` が走ると、フォームが黙って既定値へ初期化され、
    // `expectedVersion` が落ちて **#367 の楽観ロックが外れる**。`policy: null`（未設定）とは別物。
    const body = asOperatingPolicyResponse(await res.json().catch(() => null));
    if (body === null) {
      setLoadFailed(true);
      return;
    }
    applyPolicy(body.policy);
    setLoadFailed(false);
    setLoadedScopeKey(requestedScope);
  }, [qs, scopeKey, scopeReady, isCurrentScope, applyPolicy]);

  useEffect(() => {
    // 拠点が変わったら「まだ読めていない」へ戻す。これを忘れると前拠点の値のまま
    // 保存できてしまう。
    setLoadedScopeKey((prev) => (prev === scopeKey ? prev : null));
    // 前拠点の失敗を新しい拠点へ持ち越さない（切替直後に「取得できませんでした」と出る）。
    setLoadFailed(false);
    void load();
  }, [load, scopeKey]);

  const save = useCallback(async () => {
    // 選択中の拠点の内容が載りきるまで保存させない（載っているのは別拠点の値かもしれない）。
    // **ハンドラとボタンが同じ値を見る。** 片方だけ強くするとサイレント no-op になる
    // （#552 で実際に P1 になった型）。
    if (!gate.canMutate) return;
    // **応答の適用にも同じ門が要る** (#554 レビュー B1 と同型)。PUT が飛行中に拠点を
    // 切り替えると、遅れて届いた A の応答が B の画面へ載り、以後 B として保存できてしまう。
    const startedWith = scopeKey;
    // 失敗の宛先は、保存を**始めた時点**の拠点である（切り替え後の名前を出すと嘘になる）。
    const startedFor = siteLabel(sites, siteId);

    /*
      🔴 **入力の解釈は `try` の外でやる。** ここを `try` の中に置くと、`parseTimeRangesText`
      などの例外（入力起因・実装バグ）まで `catch` が拾い、「サーバーに接続できませんでした」
      という**まったく無関係な文言**になる（独立レビュー MINOR）。`try` に入れるのは
      送信と応答の解釈だけにする。
    */
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

    setBusy(true);
    clear();
    setIssues([]);
    // 「応答が届いたか」を持つ。`catch` は fetch の reject と、届いた後の例外の
    // **両方**を拾うので、綴りだけでは区別できない。
    let reached = false;
    try {
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
      reached = true;
      /*
        🔴 **門は「画面へ書き込む行」だけに掛ける。**

        それまでは `if (!isCurrentScope(startedWith)) return;` を応答の直後に置いていたので、
        飛行中に拠点を切り替えると **成功も失敗も丸ごと飲み込まれた** —— A の保存が 409
        （他の管理者が先に保存）や 400（検証エラー）で失敗しても画面には何も出ず、運用者は
        A が保存されたと信じる。営業時間は営業時間外案内と発信可否を決めるので、来訪者の
        受付完遂に直結する（独立レビュー 2 周目 MAJOR-C）。

        報告（`success` / `failure`）は宛先ラベル付きで**必ず出す**。フォームに紐づく表示
        （`applyPolicy` / `setIssues` / `setConflict`）だけを門の内側に置く —— こちらは
        A の内容を B のフォームへ書くことになるので、載せてはいけない。
      */
      if (res.ok) {
        // 🔴 **確かめられた 200 だけを成功と呼ぶ**（#973 増分 02 の規則を広げる。#1004）。
        // 🔴 **保存の応答に `policy: null` はあり得ない**（GET の「未設定」と共用しない）。
        // 通すと画面が「まだ設定がありません」へ化けたうえで「保存しました」を出し、次の保存で
        // `expectedVersion` が落ちて 409 →「ほかの管理者が更新済み」という嘘になる（レビュー MAJOR-4）。
        const saved = asSavedOperatingPolicyResponse(await res.json().catch(() => null));
        if (saved === null) {
          failure(saveFailureMessage('unreadable', startedFor));
          return;
        }
        // 🔴 **書き込みの直前で評価し直す。** `await res.json()` を跨ぐので、パース中に
        // 切り替わると A の内容が B の state へ入る（独立レビュー 3 周目 MINOR-4）。
        if (isCurrentScope(startedWith)) {
          applyPolicy(saved);
          setLoadedScopeKey(startedWith);
        }
        success(`${startedFor}: 保存しました`);
      } else {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
          issues?: { field: string; message: string }[];
        } | null;
        // 🔴 **書き込みの直前で評価し直す。** `await res.json()` を跨ぐので、パース中に
        // 切り替わると A の内容が B の state へ入る（独立レビュー 3 周目 MINOR-4）。
        if (isCurrentScope(startedWith)) {
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
        }
        failure(saveFailureMessage('rejected', startedFor));
      }
    } catch {
      /*
        応答を受け取れていない。`failure()` の既定（サーバが拒否した）を使うと嘘になる。

        🔴 **ここにスコープの門を置かない。** 成功経路が `isCurrentScope` を見るのは、
        A の応答を B の画面へ**書き込む**と状態が壊れるからである。失敗の報告は
        データを書かない —— 押した操作が失敗した事実は、その後どの拠点を見ていても
        運用者に伝えるべきもので、門を足すと「切り替えたら黙る」という元の欠陥へ戻る。
      */
      failure(saveFailureMessage(reached ? 'unreadable' : 'unreachable', startedFor));
    } finally {
      setBusy(false);
    }
  }, [gate.canMutate, scopeKey, isCurrentScope, clear, weeklyText, fixedHolidaysText, exceptionsText, timezone, emergencyContactLabel, tenantId, siteId, sites, policy, applyPolicy, success, failure]);

  if (gate.unavailable !== null) {
    // **理由で出し分ける。** 失敗を「読み込み中…」と出すと運用者は終わらない待ちに入り、
    // 「未設定」と出すと**取得できていないこと**を**設定が無いこと**として読ませてしまう。
    const failed = gate.unavailable === 'load-failed' || gate.unavailable === 'site-list-error';
    return (
      <section>
        <h1 style={{ marginTop: 0 }}>営業時間設定</h1>
        {/*
          🔴 **保存の結果はこちらの枝にも出す**（独立レビュー MAJOR-2）。拠点を切り替えると
          `gate.unavailable` が非 null になってフォームごと差し替わる。切替先の取得も失敗すると、
          直前の保存失敗は**永久に描画されない** —— 門を外しても「切り替えたら黙る」が残る。
        */}
        <SaveFeedback feedback={feedback} successTestId="operating-hours-saved" errorTestId="operating-hours-error" />
        {failed ? (
          <EmptyState
            testId="operating-hours-unavailable"
            title="読み込めませんでした"
            message={
              gate.unavailable === 'site-list-error'
                ? '拠点を確認できないため、営業時間設定を表示できません。'
                : '営業時間設定を取得できませんでした。通信状況を確認して再試行してください。'
            }
            action={
              <Button
                data-testid="operating-hours-unavailable-retry"
                onClick={() => {
                  if (gate.unavailable === 'site-list-error') reloadSites();
                  else void load();
                }}
                disabled={!gate.canRefresh}
              >
                再試行
              </Button>
            }
          />
        ) : gate.unavailable === 'no-site' ? (
          <p data-testid="operating-hours-no-site" style={{ color: color.muted }}>
            このテナントにはまだ拠点がありません。拠点を登録すると営業時間を設定できます。
          </p>
        ) : (
          <p style={{ color: color.muted }}>読み込み中…</p>
        )}
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

      {/*
        🔴 **一度読めた後の取得失敗は、どこにも出ていなかった**（独立レビュー MAJOR-3）。
        `loadFailed` を描くのは `resolveScopeGate` 経由の差し替え枝だけで、そこは
        `dataLoaded` が真になると通らない。つまり 409 の復旧導線「最新を読み込む」を押して
        失敗しても**バナーが消えるだけ**で、運用者は最新を掴んだと信じて保存し、また 409 になる。
        編集中の内容を捨てないために `loadedScopeKey` は落とさず、**失敗したことだけ**を言う。
      */}
      {loadFailed && loaded ? (
        <p
          data-testid="operating-hours-reload-error"
          role="alert"
          aria-live="assertive"
          style={{ color: color.danger, marginBottom: space.md }}
        >
          最新の営業時間を取得できませんでした。画面の内容は古い可能性があります。通信状態を
          確かめて、もう一度お試しください。
        </p>
      ) : null}
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

      <Form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: space.md }}>
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
          <Button variant="primary" type="submit" data-testid="operating-hours-save" disabled={!gate.canMutate}>
            保存
          </Button>
          <SaveFeedback feedback={feedback} successTestId="operating-hours-saved" errorTestId="operating-hours-error" />
        </div>
      </Form>
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
