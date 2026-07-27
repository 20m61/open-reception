'use client';

/**
 * 実効キオスク構成の一括取得フック (issue #422 increment 1 / #419)。
 *
 * `KioskFlow` は起動時に個別設定 API を **7 本**叩き（directory / voice / assets / branding /
 * motions / flow / signage）、応答をそれぞれローカル state へ積み上げていた。そのため
 * 「いま端末に適用されている構成」を 1 箇所で確認できず、版（#420）との対応も取れなかった。
 * 本モジュールは `GET /api/configuration/effective` の 1 回取得へ寄せる（#422 AC
 * 「kiosk runtime が EffectiveKioskConfiguration を一括取得する」）。
 *
 * 設計の要点:
 *   - **スコープを送らない。** 端末実行では tenant/site/kiosk はサーバがセッション束縛から
 *     権威的に解決する（`src/domain/product-context/context.ts`）。クライアントが query で
 *     指定できてしまうと越境の入口になるため、ここでは一切付けない。
 *   - **フェッチと写像を分ける。** `selectKioskConfiguration` は純関数で、node 環境の unit test
 *     で全セクションの写像を固定できる。フックは状態保持だけを担う薄い層。
 *   - **失敗は「取得できなかった」で表現する。** 握り潰して既定値を「取得成功」に見せない。
 *     呼び出し側（`KioskFlow`）は error のとき従来の個別 API 経路へ自動フォールバックする
 *     （可用性優先。ロールバックは移行フラグ `?effectiveConfig=0` で明示的に行える）。
 *   - 各セクションの値は `unknown` で届く（`EffectiveKioskConfiguration` の型どおり）。
 *     セクション単位で形を確かめ、**中身の検証は旧経路と同じ信頼度**（サーバ生成物として扱う）に
 *     揃える。壊れた/欠落したセクションはそのセクションだけ未取得（undefined）にし、
 *     構成全体を落とさない。
 */
import { useEffect, useState } from 'react';
import { resolveConfigurationSyncInterval } from '@/domain/kiosk/configuration-sync';
import {
  sanitizeA11yEnabledModes,
  type A11yEnabledModes,
} from '@/domain/kiosk/a11y-modes';
import type { CallingStageThresholds } from '@/domain/reception/calling-experience';
import type { BrandingSettings } from '@/domain/branding/types';
import type { MotionKey } from '@/domain/motion/types';
import type { ConfigurationSectionName, ConfigurationSource } from '@/domain/product-context/types';
import type { SpeakSettings } from './speech';
import type { KioskFlow as KioskCustomFlow } from './custom-flow/types';

/** 受付端末が使うディレクトリ（部署・担当者の最小情報）。 */
export type DirDepartment = { id: string; name: string };
export type DirStaff = {
  id: string;
  displayName: string;
  kana?: string;
  aliases: string[];
  departmentId: string;
  available: boolean;
};
export type Directory = { departments: DirDepartment[]; staff: DirStaff[] };

/** 待機画面リード・音声・呼び出し中ケア・a11y の各設定を、画面が使う形へ正規化したもの。 */
export type KioskVoiceConfiguration = {
  /** 未設定なら undefined（画面の既定文言を維持する）。 */
  guidanceIdle?: string;
  privacyNotice?: string;
  sttEnabled: boolean;
  speak: SpeakSettings;
  /** テナント設定によるしきい値上書き（未設定キーは既定へ落ちる）。 */
  callingStageThresholds: Partial<CallingStageThresholds>;
  callingStageText: { waiting?: string; notice?: string };
  feedbackEnabled: boolean;
  a11yEnabledModes: A11yEnabledModes;
};

export type KioskAvatarAssets = {
  backgroundUrl?: string;
  vrmUrl?: string;
  fallbackImageUrl?: string;
};

export type KioskMotionConfiguration = {
  motions: Partial<Record<MotionKey, string>>;
  defaultUrl?: string;
};

/**
 * 画面が消費する形に写した実効構成。**取得できなかったセクションは undefined** にして、
 * 呼び出し側がそのセクションだけ既定値を維持できるようにする。
 */
export type KioskConfigurationSections = {
  directory?: Directory;
  voice?: KioskVoiceConfiguration;
  avatar?: KioskAvatarAssets;
  branding?: BrandingSettings;
  motions?: KioskMotionConfiguration;
  /** 有効なカスタム受付フロー。空配列 = 既定フローを使う（未取得の undefined とは区別する）。 */
  flows?: readonly KioskCustomFlow[];
  /** 再生可能なサイネージ項目数（待機表示の判定に使う）。 */
  signageCount?: number;
};

/** 版・指紋・由来。反映状況の報告（#420）とデバッグ出力（#419 AC）で使う。 */
export type KioskConfigurationMeta = {
  versionId?: string;
  revision?: number;
  /** 版が固定した内容の指紋（`computeSectionsHash`）。端末はこれを heartbeat で報告する。 */
  contentHash?: string;
  /** context を含む応答の指紋。端末ごとに異なるため反映状況の期待値には使えない。 */
  configHash?: string;
  provenance?: Partial<Record<ConfigurationSectionName, ConfigurationSource>>;
};

export type EffectiveConfigurationResult =
  | { status: 'ready'; sections: KioskConfigurationSections; meta: KioskConfigurationMeta }
  | { status: 'error'; httpStatus?: number };

/** 移行フラグ無効時は 'disabled'（要求そのものを出さない）。 */
export type EffectiveConfigurationState =
  | { status: 'disabled' }
  | { status: 'loading' }
  | { status: 'ready'; sections: KioskConfigurationSections; meta: KioskConfigurationMeta }
  | { status: 'error'; httpStatus?: number };

export const EFFECTIVE_CONFIGURATION_PATH = '/api/configuration/effective';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function selectDirectory(value: unknown): Directory | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const { departments, staff } = record;
  if (!Array.isArray(departments) || !Array.isArray(staff)) return undefined;
  return { departments, staff } as Directory;
}

function selectVoice(value: unknown): KioskVoiceConfiguration | undefined {
  const voice = asRecord(value);
  if (!voice) return undefined;
  return {
    guidanceIdle: asString(voice.guidanceIdle),
    // 上書きが無ければ undefined（i18n 既定文言を使う。旧経路と同じ意味）。
    privacyNotice: asString(voice.privacyNotice),
    sttEnabled: voice.sttEnabled === true,
    speak: {
      ttsEnabled: voice.ttsEnabled === true,
      rate: asNumber(voice.rate) ?? 1,
      volume: asNumber(voice.volume) ?? 1,
      language: asString(voice.language) ?? 'ja-JP',
    },
    callingStageThresholds: {
      waitingAfterMs: asNumber(voice.callingStageWaitingAfterMs),
      noticeAfterMs: asNumber(voice.callingStageNoticeAfterMs),
    },
    callingStageText: {
      waiting: asString(voice.guidanceCallingWaiting),
      notice: asString(voice.guidanceCallingNotice),
    },
    // 未設定は収集する（既定 true, #320）。
    feedbackEnabled: voice.feedbackEnabled !== false,
    a11yEnabledModes: sanitizeA11yEnabledModes(voice.a11yModesEnabled),
  };
}

function selectAvatar(value: unknown): KioskAvatarAssets | undefined {
  const assets = asRecord(value);
  if (!assets) return undefined;
  return {
    backgroundUrl: asString(assets.backgroundUrl),
    vrmUrl: asString(assets.vrmUrl),
    fallbackImageUrl: asString(assets.fallbackImageUrl),
  };
}

function selectBranding(value: unknown): BrandingSettings | undefined {
  const branding = asRecord(value);
  if (!branding) return undefined;
  return {
    companyName: asString(branding.companyName),
    accentColor: asString(branding.accentColor),
    logoUrl: asString(branding.logoUrl),
  };
}

function selectMotions(value: unknown): KioskMotionConfiguration | undefined {
  const motions = asRecord(value);
  if (!motions) return undefined;
  // フラグ無効時は `{ motions: {} }`（defaultUrl 無し）で届く。旧経路と同じく空集合で継続する。
  return {
    motions: asRecord(motions.motions) ?? {},
    defaultUrl: asString(motions.defaultUrl),
  };
}

function selectFlows(value: unknown): readonly KioskCustomFlow[] | undefined {
  const receptionFlow = asRecord(value);
  if (!receptionFlow) return undefined;
  return Array.isArray(receptionFlow.flows) ? (receptionFlow.flows as KioskCustomFlow[]) : [];
}

function selectSignageCount(value: unknown): number | undefined {
  const signage = asRecord(value);
  if (!signage) return undefined;
  return Array.isArray(signage.items) ? signage.items.length : 0;
}

function selectMeta(payload: Record<string, unknown>): KioskConfigurationMeta {
  const version = asRecord(payload.version);
  const provenance = asRecord(payload.provenance);
  return {
    versionId: version ? asString(version.id) : undefined,
    revision: version ? asNumber(version.revision) : undefined,
    contentHash: version ? asString(version.contentHash) : undefined,
    configHash: asString(payload.configHash),
    provenance: provenance as KioskConfigurationMeta['provenance'],
  };
}

/**
 * `EffectiveKioskConfiguration` を画面が使う形へ写す純関数。
 * payload 自体が object でなければ null（＝取得失敗として扱う）。
 */
export function selectKioskConfiguration(
  payload: unknown,
): { sections: KioskConfigurationSections; meta: KioskConfigurationMeta } | null {
  const record = asRecord(payload);
  if (!record) return null;
  return {
    sections: {
      directory: selectDirectory(record.directory),
      voice: selectVoice(record.voice),
      avatar: selectAvatar(record.avatar),
      branding: selectBranding(record.branding),
      motions: selectMotions(record.motions),
      flows: selectFlows(record.receptionFlow),
      signageCount: selectSignageCount(record.signage),
    },
    meta: selectMeta(record),
  };
}

/**
 * 実効構成を 1 回取得する。スコープ query は付けない（サーバがセッション束縛から解決する）。
 * 失敗は例外にせず `status: 'error'` で返し、呼び出し側が旧経路へ倒せるようにする。
 */
export async function loadEffectiveConfiguration(
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<EffectiveConfigurationResult> {
  try {
    const res = await fetchImpl(EFFECTIVE_CONFIGURATION_PATH, { cache: 'no-store', signal });
    if (!res.ok) return { status: 'error', httpStatus: res.status };
    const selected = selectKioskConfiguration(await res.json());
    if (!selected) return { status: 'error', httpStatus: res.status };
    return { status: 'ready', sections: selected.sections, meta: selected.meta };
  } catch {
    return { status: 'error' };
  }
}

/**
 * 実効構成を取得するフック。`enabled=false`（移行フラグ無効）の間は要求を出さない。
 *
 * 起動時に 1 回取得し、以降は一定間隔で再取得する（#420「公開 → キオスク取得」。
 * 間隔と可視性の扱いは営業状態ポーリング `src/lib/kiosk/use-operating-status.ts` に揃える:
 * `document.hidden` の間は取得しない・再表示で即時 1 回取得する）。
 *
 * **取得するだけで、いつ適用するかは呼び出し側が決める**（受付進行中の差し替えを防ぐ判定は
 * `src/domain/kiosk/configuration-sync.ts`）。取得失敗は直前の成功を捨てない
 * （`status: 'error'` を返すのは初回取得に失敗したときだけ）。
 */
export function useEffectiveConfiguration(enabled: boolean): EffectiveConfigurationState {
  const [state, setState] = useState<EffectiveConfigurationState>(
    enabled ? { status: 'loading' } : { status: 'disabled' },
  );

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'disabled' });
      return;
    }
    const intervalMs = resolveConfigurationSyncInterval(
      typeof window === 'undefined' ? '' : window.location.search,
    );
    let controller: AbortController | null = null;
    let stopped = false;

    const load = async () => {
      if (stopped) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      // 可視性トグル連打などで前回取得が残っていれば畳む（オーバーラップ防止）。
      controller?.abort();
      const local = new AbortController();
      controller = local;
      const result = await loadEffectiveConfiguration(fetch, local.signal);
      if (stopped || local.signal.aborted) return;
      setState((prev) =>
        // 再取得の失敗で、いま適用できている構成を「取得失敗」に落とさない
        // （端末は last-known-good で動き続ける。ロールバック playbook の前提）。
        result.status === 'error' && prev.status === 'ready' ? prev : result,
      );
    };

    setState({ status: 'loading' });
    void load();
    const timer = setInterval(() => void load(), intervalMs);
    const onVisibility = () => {
      if (!document.hidden) void load();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }

    return () => {
      stopped = true;
      clearInterval(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      controller?.abort();
    };
  }, [enabled]);

  return state;
}
