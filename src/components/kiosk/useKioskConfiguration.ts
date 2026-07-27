'use client';

/**
 * 受付端末に適用する構成の取得・保持を `KioskFlow` から分離したフック (issue #422 increment 2)。
 *
 * #422 の実装範囲「`KioskFlow` から設定取得（…）を分離」に対応する。`KioskFlow` は
 * 「受付の状態機械と画面」に専念し、**構成がどこから来るか**は本モジュールだけが知る。
 *
 * 経路は 2 つあり、移行フラグ（`src/domain/kiosk/experience-flags.ts` / ADR 0004）で選ぶ:
 *
 *   - **新経路**: `GET /api/configuration/effective` の 1 回取得（#419）。
 *   - **旧経路**: 個別設定 API 7 本（`/api/kiosk/directory` ほか）。既定。
 *
 * 新経路が失敗した端末は旧経路へ自動フォールバックする（可用性優先。端末を無設定で
 * 放置しない）。恒久的な切り戻しはフラグ側で行う。撤去条件は
 * `docs/product-integration-plan.md` §7 / §9 B-03。
 *
 * **セクション単位の失敗はそのセクションだけ既定へ倒す**（構成全体を落とさない）のが両経路
 * 共通の契約。受付導線は構成が空でも成立する（担当者ゼロでも受付開始ボタンは出る、など）。
 */
import { useEffect, useState } from 'react';
import {
  sanitizeA11yEnabledModes,
  type A11yEnabledModes,
} from '@/domain/kiosk/a11y-modes';
import { resolveKioskExperienceFlags } from '@/domain/kiosk/experience-flags';
import type { CallingStageThresholds } from '@/domain/reception/calling-experience';
import type { BrandingSettings } from '@/domain/branding/types';
import type { SpeakSettings } from './speech';
import type { KioskFlow as KioskCustomFlow } from './custom-flow/types';
import {
  useEffectiveConfiguration,
  type Directory,
  type KioskConfigurationMeta,
  type KioskMotionConfiguration,
} from './useEffectiveConfiguration';

export type KioskConfiguration = {
  directory: Directory;
  /**
   * 待機画面リードの文言の**上書き**(#28)。未設定なら undefined で、既定文言は呼び出し側が持つ
   * （既定文言は ja のハードコードで、i18n 移行は #327 の対象。ここへ移すと未移行の生 CJK が
   * 新規ファイルへ広がるため、`KioskFlow` 側に残す）。
   */
  guidanceIdle?: string;
  /** 来訪者向けプライバシー通知の要約文言の上書き (#28 / #314)。未設定なら i18n 既定。 */
  privacyNoticeOverride?: string;
  speakSettings: SpeakSettings;
  sttEnabled: boolean;
  backgroundUrl?: string;
  /** テナントのブランド設定（ロゴ/アクセント色/社名）(#88)。 */
  branding: BrandingSettings;
  vrmUrl?: string;
  avatarFallbackUrl?: string;
  /** 状態別モーション URL (#31)。default URL に fallback して VRM レンダラへ渡す。 */
  motions: KioskMotionConfiguration;
  /** カスタム受付フロー (#100)。null=取得前/失敗、[]=無効（既定フローへフォールバック）。 */
  customFlows: KioskCustomFlow[] | null;
  /** 待機サイネージの再生可能項目数 (#101)。 */
  signageCount: number;
  /** ワンタップ満足度フィードバック収集の有効/無効 (#320)。未設定は収集する。 */
  feedbackEnabled: boolean;
  /** アクセシビリティ支援モードのテナント別 有効/無効 (#321)。 */
  a11yEnabledModes: A11yEnabledModes;
  /** 呼び出し中の段階的ケアのしきい値上書き (#323)。 */
  callingStageThresholdOverride: Partial<CallingStageThresholds>;
  callingStageTextOverride: { waiting?: string; notice?: string };
  /**
   * 版・指紋・由来（新経路でのみ得られる）。#420 の端末側の版報告と
   * 「各設定値の由来をデバッグ出力で確認できる」(#419 AC) の入力。
   */
  meta?: KioskConfigurationMeta;
};

/** 旧経路の `/api/kiosk/voice` 応答（#28 / #320 / #321 / #323 の設定を相乗り）。 */
type LegacyVoiceSettings = {
  guidanceIdle?: string;
  ttsEnabled?: boolean;
  sttEnabled?: boolean;
  rate?: number;
  volume?: number;
  language?: string;
  privacyNotice?: string;
  callingStageWaitingAfterMs?: number;
  callingStageNoticeAfterMs?: number;
  guidanceCallingWaiting?: string;
  guidanceCallingNotice?: string;
  feedbackEnabled?: boolean;
  a11yModesEnabled?: Partial<A11yEnabledModes>;
};

export function useKioskConfiguration(): KioskConfiguration {
  const [directory, setDirectory] = useState<Directory>({ departments: [], staff: [] });
  const [guidanceIdle, setGuidanceIdle] = useState<string | undefined>(undefined);
  const [privacyNoticeOverride, setPrivacyNoticeOverride] = useState<string | undefined>(undefined);
  const [speakSettings, setSpeakSettings] = useState<SpeakSettings>({
    ttsEnabled: false,
    rate: 1,
    volume: 1,
    language: 'ja-JP',
  });
  const [sttEnabled, setSttEnabled] = useState(false);
  const [backgroundUrl, setBackgroundUrl] = useState<string | undefined>(undefined);
  const [branding, setBranding] = useState<BrandingSettings>({});
  const [vrmUrl, setVrmUrl] = useState<string | undefined>(undefined);
  const [avatarFallbackUrl, setAvatarFallbackUrl] = useState<string | undefined>(undefined);
  const [motions, setMotions] = useState<KioskMotionConfiguration>({ motions: {} });
  const [customFlows, setCustomFlows] = useState<KioskCustomFlow[] | null>(null);
  const [signageCount, setSignageCount] = useState(0);
  const [feedbackEnabled, setFeedbackEnabled] = useState(true);
  const [a11yEnabledModes, setA11yEnabledModes] = useState<A11yEnabledModes>(
    sanitizeA11yEnabledModes(undefined),
  );
  const [callingStageThresholdOverride, setCallingStageThresholdOverride] = useState<
    Partial<CallingStageThresholds>
  >({});
  const [callingStageTextOverride, setCallingStageTextOverride] = useState<{
    waiting?: string;
    notice?: string;
  }>({});

  // 構成取得の新旧経路を選ぶ移行フラグ (ADR 0004 / 台帳 §7)。既定は旧経路。
  // `?effectiveConfig=1` で端末 1 台だけ新経路にでき、`=0` で戻せる。window はレンダー中に
  // 読まないよう lazy initializer で 1 度だけ読む（SSR では既定＝旧経路になり、初期マークアップは
  // どちらの経路でも同一なのでハイドレーション差分は生じない）。
  const [experienceFlags] = useState(() =>
    resolveKioskExperienceFlags({
      search: typeof window === 'undefined' ? '' : window.location.search,
      env: process.env.NEXT_PUBLIC_KIOSK_EFFECTIVE_CONFIG,
    }),
  );
  const effective = useEffectiveConfiguration(experienceFlags.effectiveConfiguration);
  // 新経路が失敗したら旧経路へ自動フォールバックする（可用性優先。端末を無設定で放置しない）。
  const legacyConfigFetch = effective.status === 'disabled' || effective.status === 'error';

  // 実効構成の一括取得（#419 `/api/configuration/effective`）を各 state へ反映する。
  // 取得できなかったセクションは触らない＝既定値を維持する（旧経路の「その API だけ失敗」と同じ挙動）。
  useEffect(() => {
    if (effective.status !== 'ready') return;
    const { directory: dir, voice, avatar, branding: brand, motions: motion, flows, signageCount: signage } =
      effective.sections;
    if (dir) setDirectory(dir);
    if (voice) {
      if (voice.guidanceIdle) setGuidanceIdle(voice.guidanceIdle);
      setPrivacyNoticeOverride(voice.privacyNotice);
      setSttEnabled(voice.sttEnabled);
      setSpeakSettings(voice.speak);
      setCallingStageThresholdOverride(voice.callingStageThresholds);
      setCallingStageTextOverride(voice.callingStageText);
      setFeedbackEnabled(voice.feedbackEnabled);
      setA11yEnabledModes(voice.a11yEnabledModes);
    }
    if (avatar) {
      setBackgroundUrl(avatar.backgroundUrl);
      setVrmUrl(avatar.vrmUrl);
      setAvatarFallbackUrl(avatar.fallbackImageUrl);
    }
    if (brand) setBranding(brand);
    if (motion) setMotions(motion);
    // フロー未取得は null のままにせず [] へ倒す（既定フローで受付を続ける, #100）。
    setCustomFlows(flows ? [...flows] : []);
    if (signage !== undefined) setSignageCount(signage);
  }, [effective]);

  // 部署・担当者を管理画面と共有のディレクトリ API から取得する (issue #3)。
  useEffect(() => {
    if (!legacyConfigFetch) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/kiosk/directory');
        if (!res.ok) return;
        const dir = (await res.json()) as Directory;
        if (!cancelled) setDirectory(dir);
      } catch {
        /* 取得失敗時は空のまま。受付開始ボタンは表示され、画面は壊れない */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [legacyConfigFetch]);

  // 音声設定の案内文言を受付画面へ反映する (issue #28)。
  useEffect(() => {
    if (!legacyConfigFetch) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/kiosk/voice');
        if (!res.ok) return;
        const voice = (await res.json()) as LegacyVoiceSettings;
        if (cancelled) return;
        if (voice.guidanceIdle) setGuidanceIdle(voice.guidanceIdle);
        setPrivacyNoticeOverride(voice.privacyNotice);
        setSttEnabled(voice.sttEnabled ?? false);
        setSpeakSettings({
          ttsEnabled: voice.ttsEnabled ?? false,
          rate: voice.rate ?? 1,
          volume: voice.volume ?? 1,
          language: voice.language ?? 'ja-JP',
        });
        // 呼び出し中の段階的ケア (issue #323)。テナント設定のしきい値・案内文言の上書き。
        setCallingStageThresholdOverride({
          waitingAfterMs: voice.callingStageWaitingAfterMs,
          noticeAfterMs: voice.callingStageNoticeAfterMs,
        });
        setCallingStageTextOverride({
          waiting: voice.guidanceCallingWaiting,
          notice: voice.guidanceCallingNotice,
        });
        // ワンタップ満足度フィードバック収集の有効/無効 (issue #320)。未設定は収集する（既定 true）。
        setFeedbackEnabled(voice.feedbackEnabled ?? true);
        // アクセシビリティ支援モードの有効/無効 (issue #321)。未設定は全モード有効扱い。
        setA11yEnabledModes(sanitizeA11yEnabledModes(voice.a11yModesEnabled));
      } catch {
        /* 取得失敗時は既定文言を使う */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [legacyConfigFetch]);

  // 適用中の背景アセットを反映する (issue #27)。読み込み失敗時は背景色で fallback。
  useEffect(() => {
    if (!legacyConfigFetch) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/kiosk/assets');
        if (!res.ok) return;
        const assets = (await res.json()) as {
          backgroundUrl?: string;
          vrmUrl?: string;
          fallbackImageUrl?: string;
        };
        if (cancelled) return;
        setBackgroundUrl(assets.backgroundUrl);
        setVrmUrl(assets.vrmUrl);
        setAvatarFallbackUrl(assets.fallbackImageUrl);
      } catch {
        /* 取得失敗時は既定背景 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [legacyConfigFetch]);

  // テナントのブランド設定を取得（#88）。失敗時は汎用テーマのまま。
  useEffect(() => {
    if (!legacyConfigFetch) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/kiosk/branding');
        if (!res.ok) return;
        const data = (await res.json()) as BrandingSettings;
        if (!cancelled) setBranding(data);
      } catch {
        /* 取得失敗時は汎用テーマ */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [legacyConfigFetch]);

  // 状態別モーション URL を取得する (issue #31)。未設定/失敗時は default または無効化で fallback。
  useEffect(() => {
    if (!legacyConfigFetch) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/kiosk/motions');
        if (!res.ok) return;
        const m = (await res.json()) as KioskMotionConfiguration;
        if (!cancelled) setMotions({ motions: m.motions ?? {}, defaultUrl: m.defaultUrl });
      } catch {
        /* 取得失敗時はモーション無し（アバターは静止/ fallback のまま） */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [legacyConfigFetch]);

  // 有効なカスタム受付フローを取得する (issue #100)。取得失敗/無効時は既定フローへフォールバック。
  useEffect(() => {
    if (!legacyConfigFetch) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/kiosk/flow', { cache: 'no-store' });
        if (!res.ok) {
          // 403（セッション未確立）/503（障害）等は既定フローで継続する。
          if (!cancelled) setCustomFlows([]);
          return;
        }
        const body = (await res.json()) as { flows?: KioskCustomFlow[] };
        if (!cancelled) setCustomFlows(body.flows ?? []);
      } catch {
        if (!cancelled) setCustomFlows([]); // 取得失敗＝既定フロー
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [legacyConfigFetch]);

  // 待機サイネージの再生可能項目数を取得する (issue #101)。失敗/無効時は 0（既定 IdleView）。
  useEffect(() => {
    if (!legacyConfigFetch) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/kiosk/signage');
        if (!res.ok) return;
        const sig = (await res.json()) as { items?: unknown[] };
        if (!cancelled) setSignageCount(Array.isArray(sig.items) ? sig.items.length : 0);
      } catch {
        /* 取得失敗時は 0 のまま（待機画面は既定の IdleView） */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [legacyConfigFetch]);

  return {
    directory,
    guidanceIdle,
    privacyNoticeOverride,
    speakSettings,
    sttEnabled,
    backgroundUrl,
    branding,
    vrmUrl,
    avatarFallbackUrl,
    motions,
    customFlows,
    signageCount,
    feedbackEnabled,
    a11yEnabledModes,
    callingStageThresholdOverride,
    callingStageTextOverride,
    meta: effective.status === 'ready' ? effective.meta : undefined,
  };
}
