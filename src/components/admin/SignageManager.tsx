'use client';

import { useCallback, useEffect, useState } from 'react';
import { asSignageConfig } from '@/domain/signage/parse';
import {
  SIGNAGE_CONTENT_TYPES,
  type SignageConfig,
  type SignageContentType,
  type SignageItem,
} from '@/domain/signage/types';
import { Button, Field, Form, FormRow, SaveFeedback, Section, saveFailureMessage, siteLabel, useSaveFeedback } from '@/components/admin/ui';
import { color, radius, space } from '@/components/admin/ui/tokens';
import { useSiteScope } from './use-site-scope';
import { SiteScopeSelect } from './SiteScopeSelect';
import { resolveScopeGate } from './scope-gate';

/**
 * 待機中サイネージ 管理画面 (issue #101, increment 1)。
 *
 * inc1 のサイネージ API（/api/admin/signage）を介して、サイトの待機画面に出す
 * コンテンツ（時計/案内文/画像/スライド）と表示間隔・有効状態を編集する。
 *
 * 表示するコンテンツに来訪者の PII を含めない。画像/スライドの外部 URL は信頼できる
 * オリジンのみ（サーバ側 rotation.validateConfig が http(s) を強制）。素材ライセンスは
 * #105 に従う（docs/signage-mode-design.md）。
 *
 * **対象拠点は URL が真実源** (#554)。以前は component state ＋自由入力で、既定は
 * ローカル定数の `'default'` だった。**実在する既定拠点は `'default-site'`** なので、
 * 管理画面は `'default'` に保存し、受付端末（`SignageDisplay` は共有の `DEFAULT_SITE_ID`
 * ＝ `'default-site'` を読む）はそれを見に行かない — **保存した設定が端末に反映されない**
 * 状態だった。テナントも `'internal'` 固定で、テナントを切り替えても同じ設定を編集していた。
 */

const TYPE_LABEL: Record<SignageContentType, string> = {
  clock: '時計',
  message: '案内文',
  image: '画像',
  slides: 'スライド',
};

function newItem(): SignageItem {
  return {
    id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'clock',
    enabled: true,
  } as SignageItem;
}

type FieldError = { field: string; message: string };

export function SignageManager({
  tenantId,
  siteId: defaultSiteId,
}: {
  tenantId: string;
  /** サーバが解決した既定拠点（`resolveDefaultScope().siteId`）。ヘッダの対象拠点と同じ出所。 */
  siteId: string;
}) {
  const { sites, siteId, scopeKey, scopeReady, isCurrentScope, selectSite, sitePending, listStatus, reloadSites } =
    useSiteScope(tenantId, defaultSiteId);
  const [config, setConfig] = useState<SignageConfig | null>(null);
  /**
   * **どのスコープの設定が今フォームに載っているか。**
   *
   * ここを持たないと、拠点 A の設定を編集している最中に B へ切り替えたとき、
   * **フォームには A の内容が残ったまま `siteId` だけ B になり、保存すると A の内容を
   * B へ書き込む**（#541 レビュー P1 と同型）。テナントを含む `scopeKey` で持つ。
   */
  const [configScopeKey, setConfigScopeKey] = useState<string | null>(null);
  const dataLoaded = configScopeKey === scopeKey;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 取得の失敗だけを別に持つ（`error` は保存の失敗にも使うため理由がすり替わる）。 */
  const [loadFailed, setLoadFailed] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const { feedback, success, failure, clear } = useSaveFeedback();

  /** 可否の判断は 1 箇所。ハンドラも保存ボタンの `disabled` もこの値を見る。 */
  const gate = resolveScopeGate({
    scopeReady,
    dataLoaded,
    sitePending,
    busy,
    listStatus,
    loadFailed,
    hasSites: sites.length > 0,
  });

  const load = useCallback(async () => {
    // 拠点が確定するまで取得しない（既定拠点と URL 指定で 2 本飛ばさない）。
    if (!scopeReady) return;
    const startedWith = scopeKey;
    setError(null);
    let res: Response;
    try {
      res = await fetch(
        `/api/admin/signage?tenantId=${encodeURIComponent(tenantId)}&siteId=${encodeURIComponent(siteId)}`,
      );
    } catch {
      if (!isCurrentScope(startedWith)) return;
      setLoadFailed(true);
      setError('読み込みに失敗しました');
      return;
    }
    // 取得中に拠点／テナントが変わっていたら捨てる。
    if (!isCurrentScope(startedWith)) return;
    if (res.ok) {
      // 🔴 **形を確かめてから載せる**（#1004）。`as` は実行時に何も検査しないので、
      // `200 {"ok":true}` がそのまま state に入り、次のレンダーで `config.items.map` が
      // TypeError → **この画面ごと落ちる**（admin 配下に error boundary は無い）。
      const loaded = asSignageConfig(await res.json().catch(() => null));
      if (loaded === null) {
        setLoadFailed(true);
        setError('読み込みに失敗しました');
        return;
      }
      setLoadFailed(false);
      setConfigScopeKey(startedWith);
      setConfig(loaded);
    } else {
      setLoadFailed(true);
      setError('読み込みに失敗しました');
    }
  }, [tenantId, siteId, scopeKey, scopeReady, isCurrentScope]);

  useEffect(() => {
    // 拠点が変わった瞬間に前拠点の設定をフォームから捨てる。**編集中の内容ごと消す** —
    // 残すと「B を選んでいるのに A の内容を編集している」状態になり、保存で越境する。
    setConfigScopeKey((prev) => (prev === scopeKey ? prev : null));
    setConfig((prev) => (prev === null ? prev : null));
    setLoadFailed(false);
    setFieldErrors([]);
    void load();
  }, [load, scopeKey]);

  const update = useCallback((patch: Partial<SignageConfig>) => {
    setConfig((c) => (c ? { ...c, ...patch } : c));
  }, []);

  const updateItem = useCallback((id: string, patch: Partial<SignageItem>) => {
    setConfig((c) =>
      c ? { ...c, items: c.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) } : c,
    );
  }, []);

  const addItem = useCallback(() => {
    setConfig((c) => (c ? { ...c, items: [...c.items, newItem()] } : c));
  }, []);

  const removeItem = useCallback((id: string) => {
    setConfig((c) => (c ? { ...c, items: c.items.filter((it) => it.id !== id) } : c));
  }, []);

  const save = useCallback(async () => {
    // **ボタンと同じ 1 つの値を見る。** `config` の有無だけで判断すると、拠点切替中に
    // 前拠点の内容を現在の `siteId` へ書き込める（越境保存）。
    if (!config || !gate.canMutate) return;
    /**
     * **応答を適用する側にも門が要る。**
     *
     * 入口（`gate.canMutate`）は「押した瞬間」しか守らない。PUT が飛行中に拠点を切り替えると、
     * 遅れて届いた A の応答が B の状態を上書きし、**セレクタは B・中身は A** になる。
     * `configScopeKey` は B のままなので `canMutate` は真、そこで保存すると **A の内容が
     * B の待機画面として保存される**（来訪者に他拠点の案内が出る）。
     * 読み（`load`）には写してあった守りを、書きにも写す。
     */
    const startedWith = scopeKey;
    // 失敗の宛先は、保存を**始めた時点**の拠点である（切り替え後の名前を出すと嘘になる）。
    const startedFor = siteLabel(sites, siteId);
    setBusy(true);
    setError(null);
    setFieldErrors([]);
    clear();
    /*
      **`finally` で `busy` を戻す。** それまでは成功経路と失敗経路にそれぞれ
      `setBusy(false)` を置いていたので、`fetch` が reject すると（オフライン・DNS 失敗）
      **どちらも通らず、保存ボタンが押せないまま固まった**。画面には何も出ないので、
      運用者からは「押しても反応しない端末」に見える。
    */
    // 「応答が届いたか」を持つ。`catch` は fetch の reject と、届いた後の例外の
    // **両方**を拾うので、綴りだけでは区別できない。
    let reached = false;
    try {
      const res = await fetch('/api/admin/signage', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenantId,
          siteId,
          enabled: config.enabled,
          defaultIntervalSeconds: config.defaultIntervalSeconds,
          items: config.items,
        }),
      });
      reached = true;
      /*
        🔴 **門は「画面へ書き込む行」だけに掛ける。**

        それまでは応答の直後で `return` していたので、飛行中に拠点を切り替えると
        **成功も失敗も丸ごと飲み込まれた**（4xx / 5xx でも画面に何も出ない）。報告は
        データを書かないので、宛先ラベル付きで必ず出す。フォームに紐づく表示
        （`setConfig` / `setConfigScopeKey` / `setFieldErrors`）だけを門の内側に置く
        —— こちらは A の内容を B の画面へ書くことになる（独立レビュー 2 周目 MAJOR-C）。
      */
      if (res.ok) {
        // 🔴 **確かめられた 200 だけを成功と呼ぶ**（#973 増分 02 の規則を広げる。#1004）。
        const applied = asSignageConfig(await res.json().catch(() => null));
        if (applied === null) {
          failure(saveFailureMessage('unreadable', startedFor));
          return;
        }
        // 🔴 **書き込みの直前で評価し直す。** `await res.json()` を跨ぐので、パース中に
        // 切り替わると A の内容が B の state へ入る（独立レビュー 3 周目 MINOR-4）。
        if (isCurrentScope(startedWith)) {
          // 載せるスコープも同時に更新する（「載っているデータのスコープ」を嘘にしない）。
          setConfigScopeKey(startedWith);
          setConfig(applied);
        }
        success(`${startedFor}: 保存しました（${new Date().toLocaleTimeString()}）`);
      } else {
        const data = (await res.json().catch(() => ({}))) as {
          message?: string;
          fields?: FieldError[];
        };
        // 🔴 サーバの `message` が空・空白だけなら**画面に何も出ない**（`role="alert"` の
        // 空の段落は報告していないのと同じ）。`saveFailureMessage` は `about` の空白を
        // 弾いているのに、こちらは素通しだった。
        const detail = data.message?.trim() ?? '';
        failure(detail === '' ? saveFailureMessage('rejected', startedFor) : `${startedFor}: ${detail}`);
        if (isCurrentScope(startedWith)) setFieldErrors(data.fields ?? []);
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
  }, [config, tenantId, siteId, sites, scopeKey, isCurrentScope, success, failure, clear, gate.canMutate]);

  const errorFor = useCallback(
    (field: string) => fieldErrors.find((e) => e.field === field)?.message,
    [fieldErrors],
  );

  return (
    <Section
      headingLevel="h1"
      title="待機中サイネージ"
      description="受付待機中に表示するコンテンツ（時計 / 案内文 / 画像 / スライド）を設定します。来訪者の個人情報は表示しません。画像・スライドの外部 URL は信頼できるオリジンのみを使用し、素材のライセンスを確認してください。"
      actions={
        /*
         * 保存ボタンは `Section` の右肩（`<form>` の外）に置いている。移動すると見た目が
         * 変わるので、HTML の `form` 属性で下の `<Form id="signage-form">` へ結ぶ。
         */
        <Button
          variant="primary"
          type="submit"
          form="signage-form"
          data-testid="signage-save"
          disabled={!gate.canMutate || !config}
        >
          保存
        </Button>
      }
    >
      <Form id="signage-form" onSubmit={() => void save()}>
        <FormRow>
          <SiteScopeSelect
            sites={sites}
            siteId={siteId}
            onSelect={selectSite}
            onRetry={reloadSites}
            disabled={sitePending || busy}
            testId="signage-site-select"
            status={listStatus}
          />
        </FormRow>

        {error ? (
          <p data-testid="signage-error" style={{ color: color.danger }}>
            {error}
          </p>
        ) : null}
        <SaveFeedback feedback={feedback} successTestId="signage-saved" errorTestId="signage-save-error" />

        {config ? (
          <>
            <FormRow>
              <Field label="サイネージモード" htmlFor="signage-enabled">
                <label style={{ display: 'flex', gap: space.xs, alignItems: 'center' }}>
                  <input
                    id="signage-enabled"
                    data-testid="signage-enabled"
                    type="checkbox"
                    checked={config.enabled}
                    onChange={(e) => update({ enabled: e.target.checked })}
                  />
                  <span>有効にする</span>
                </label>
              </Field>
              <Field
                label="既定の表示間隔（秒）"
                htmlFor="signage-interval"
                error={errorFor('defaultIntervalSeconds')}
              >
                <input
                  id="signage-interval"
                  data-testid="signage-interval"
                  type="number"
                  min={3}
                  max={600}
                  value={config.defaultIntervalSeconds}
                  onChange={(e) => update({ defaultIntervalSeconds: Number(e.target.value) })}
                  style={inputStyle}
                />
              </Field>
            </FormRow>

            {errorFor('items') ? (
              <p data-testid="signage-items-error" style={{ color: color.danger }}>
                {errorFor('items')}
              </p>
            ) : null}

            <div style={{ display: 'flex', flexDirection: 'column', gap: space.md, marginTop: space.md }}>
              {config.items.map((item, index) => (
                <SignageItemEditor
                  key={item.id}
                  item={item}
                  index={index}
                  onChange={(patch) => updateItem(item.id, patch)}
                  onRemove={() => removeItem(item.id)}
                  errorFor={errorFor}
                />
              ))}
            </div>

            <div style={{ marginTop: space.md }}>
              <Button data-testid="signage-add-item" onClick={addItem}>
                ＋ コンテンツを追加
              </Button>
            </div>
          </>
        ) : (
          // **理由で出し分ける。** 失敗を「読み込み中…」と出すと運用者は終わらない待ちに入る
          // （他 3 画面は出し分けているのにここだけ写し忘れていた。レビュー M4）。
          <div style={{ display: 'flex', alignItems: 'center', gap: space.sm }}>
            <p data-testid="signage-unavailable" style={{ margin: 0, color: color.muted }}>
              {gate.unavailable === 'site-list-error'
                ? '拠点を確認できないため、サイネージ設定を表示できません。'
                : gate.unavailable === 'no-site'
                  ? 'このテナントにはまだ拠点がありません。拠点を登録すると設定できます。'
                  : gate.unavailable === 'load-failed'
                    ? 'サイネージ設定を取得できませんでした。'
                    : '読み込み中…'}
            </p>
            {gate.unavailable === 'load-failed' ? (
              <Button
                variant="secondary"
                onClick={() => void load()}
                disabled={!gate.canRefresh}
                data-testid="signage-retry"
              >
                再試行
              </Button>
            ) : null}
          </div>
        )}
      </Form>
    </Section>
  );
}

function SignageItemEditor({
  item,
  index,
  onChange,
  onRemove,
  errorFor,
}: {
  item: SignageItem;
  index: number;
  onChange: (patch: Partial<SignageItem>) => void;
  onRemove: () => void;
  errorFor: (field: string) => string | undefined;
}) {
  const at = (f: string) => `items[${index}].${f}`;
  return (
    <div
      data-testid="signage-item"
      style={{
        border: `1px solid ${color.borderStrong}`,
        borderRadius: radius.md,
        padding: space.md,
        display: 'flex',
        flexDirection: 'column',
        gap: space.sm,
      }}
    >
      <FormRow>
        <Field label="種別" htmlFor={`${item.id}-type`}>
          <select
            id={`${item.id}-type`}
            data-testid="signage-item-type"
            value={item.type}
            onChange={(e) => onChange({ type: e.target.value as SignageContentType })}
            style={inputStyle}
          >
            {SIGNAGE_CONTENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="有効" htmlFor={`${item.id}-enabled`}>
          <input
            id={`${item.id}-enabled`}
            data-testid="signage-item-enabled"
            type="checkbox"
            checked={item.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
          />
        </Field>
        <Field label="表示秒数（任意・空で既定）" htmlFor={`${item.id}-duration`} error={errorFor(at('durationSeconds'))}>
          <input
            id={`${item.id}-duration`}
            type="number"
            min={3}
            max={600}
            value={item.durationSeconds ?? ''}
            onChange={(e) =>
              onChange({ durationSeconds: e.target.value === '' ? undefined : Number(e.target.value) })
            }
            style={inputStyle}
          />
        </Field>
      </FormRow>

      {item.type === 'message' ? (
        <>
          <Field label="見出し（任意）" htmlFor={`${item.id}-title`}>
            <input
              id={`${item.id}-title`}
              value={item.title ?? ''}
              onChange={(e) => onChange({ title: e.target.value })}
              style={inputStyle}
            />
          </Field>
          <Field label="本文" htmlFor={`${item.id}-message`} error={errorFor(at('message'))}>
            <textarea
              id={`${item.id}-message`}
              data-testid="signage-item-message"
              value={item.message ?? ''}
              onChange={(e) => onChange({ message: e.target.value })}
              rows={3}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </Field>
        </>
      ) : null}

      {item.type === 'image' ? (
        <>
          <Field label="画像 URL（http/https）" htmlFor={`${item.id}-imageUrl`} error={errorFor(at('imageUrl'))}>
            <input
              id={`${item.id}-imageUrl`}
              data-testid="signage-item-image-url"
              value={item.imageUrl ?? ''}
              onChange={(e) => onChange({ imageUrl: e.target.value })}
              style={inputStyle}
            />
          </Field>
          <Field label="代替テキスト（任意）" htmlFor={`${item.id}-imageAlt`}>
            <input
              id={`${item.id}-imageAlt`}
              value={item.imageAlt ?? ''}
              onChange={(e) => onChange({ imageAlt: e.target.value })}
              style={inputStyle}
            />
          </Field>
        </>
      ) : null}

      {item.type === 'slides' ? (
        <Field
          label="スライド URL（1 行に 1 つ・http/https）"
          htmlFor={`${item.id}-slides`}
          error={errorFor(at('slideUrls'))}
        >
          <textarea
            id={`${item.id}-slides`}
            data-testid="signage-item-slides"
            value={(item.slideUrls ?? []).join('\n')}
            onChange={(e) =>
              onChange({
                slideUrls: e.target.value
                  .split('\n')
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0),
              })
            }
            rows={3}
            style={{ ...inputStyle, resize: 'vertical' }}
          />
        </Field>
      ) : null}

      <div>
        <Button variant="danger" data-testid="signage-item-remove" onClick={onRemove}>
          削除
        </Button>
      </div>
    </div>
  );
}



const inputStyle: React.CSSProperties = {
  minHeight: 40,
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--color-surface-2)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  width: '100%',
};
