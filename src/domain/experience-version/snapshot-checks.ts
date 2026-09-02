/**
 * 公開前スナップショットの自動検証 (issue #420「公開前の schema・asset・call route 検証」)。
 *
 * `validateSnapshot`（`src/lib/experience-version/service.ts`）から呼ばれる**純関数**。
 * スナップショットは既に解決済みのセクション値なので、I/O 無しで検査できるものはここで閉じる。
 *
 * **error と warning の線引き**: 端末で**確実に壊れる**ものだけを error（公開を止める）にする。
 * 公開できなくなる代償は運用側で大きいため、「たぶん意図と違う」は warning に留めて記録だけ残す。
 *
 * 指摘メッセージに**値そのものを載せない**（キー名と分類だけ）。URL のパスに token 等が
 * 混じることがあり、検証結果は管理画面・監査へ出るため（`.claude/rules/pii-secret-minimization.md`）。
 *
 * **`call_route` の到達性はここでは検査できない。** 取次先・通知ルートはスナップショットに
 * 載らない（`integrations` は空を返すのが resolver の契約で、秘匿設定を端末構成へ入れないため）。
 * 検査するならルートストアを引く port を注入して非同期にする必要がある。設計を変える判断なので
 * 別 increment に分ける。
 */
import { MOTION_KEYS } from '@/domain/motion/types';
import type { ValidationFinding } from './types';

/** 端末へ配信できる URL か。https / 同一オリジン相対 / data URI のみ許可する。 */
function isDeliverableAssetUrl(value: string): boolean {
  if (value.startsWith('/')) return true;
  if (value.startsWith('data:')) return true;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function finding(
  check: ValidationFinding['check'],
  severity: ValidationFinding['severity'],
  message: string,
): ValidationFinding {
  return { check, severity, message };
}

/**
 * URL 値を検査する。**http: は error**: 端末画面は https で配信されるため、混在コンテンツとして
 * ブラウザにブロックされ、背景やアバターが黙って出なくなる（公開前に止める価値がある）。
 */
function checkUrlValue(
  check: ValidationFinding['check'],
  key: string,
  value: string,
): ValidationFinding | undefined {
  if (isDeliverableAssetUrl(value)) return undefined;
  return finding(
    check,
    'error',
    `${key} が端末へ配信できない URL です（https / 相対パス / data URI のみ）`,
  );
}

/** アセット（背景・VRM・fallback 画像）の配信可能性を検査する。 */
export function checkAssets(sections: Record<string, unknown>): ValidationFinding[] {
  if (!('avatar' in sections)) return [];
  const avatar = asRecord(sections.avatar);
  if (!avatar) {
    return [finding('asset', 'warning', 'avatar セクションの形式が不正です（既定値で配信されます）')];
  }

  const findings: ValidationFinding[] = [];
  for (const key of ['backgroundUrl', 'vrmUrl', 'fallbackImageUrl']) {
    const value = nonEmptyString(avatar[key]);
    if (!value) continue;
    const urlFinding = checkUrlValue('asset', key, value);
    if (urlFinding) {
      findings.push(urlFinding);
      continue;
    }
    // 拡張子は「読めない可能性」の示唆に留める（URL に拡張子が無い配信もあるため断定しない）。
    if (key === 'vrmUrl' && !value.split('?')[0]?.toLowerCase().endsWith('.vrm')) {
      findings.push(
        finding('asset', 'warning', 'vrmUrl の拡張子が .vrm ではありません（読み込めない可能性）'),
      );
    }
  }
  return findings;
}

/** 状態別モーションの割り当てを検査する。 */
export function checkMotionMapping(sections: Record<string, unknown>): ValidationFinding[] {
  if (!('motions' in sections)) return [];
  const section = asRecord(sections.motions);
  if (!section) {
    return [
      finding('motion_mapping', 'warning', 'motions セクションの形式が不正です（モーション無しで配信されます）'),
    ];
  }

  const findings: ValidationFinding[] = [];
  const mapping = asRecord(section.motions) ?? {};
  const known = new Set<string>(MOTION_KEYS);

  for (const [key, value] of Object.entries(mapping)) {
    if (!known.has(key)) {
      findings.push(
        finding('motion_mapping', 'warning', `未知のモーションキー ${key} は端末で無視されます`),
      );
      continue;
    }
    const url = nonEmptyString(value);
    if (!url) continue;
    const urlFinding = checkUrlValue('motion_mapping', `motions.${key}`, url);
    if (urlFinding) findings.push(urlFinding);
  }

  const defaultUrl = nonEmptyString(section.defaultUrl);
  // **アバターを使う拠点でだけ**指摘する。アバター機能が無効な拠点ではローダが常に空集合を返すため、
  // 無条件に警告すると毎回の下書き保存で必ず鳴り、警告そのものが読まれなくなる。
  const avatarConfigured = nonEmptyString(asRecord(sections.avatar)?.vrmUrl) !== undefined;
  if (avatarConfigured && Object.keys(mapping).length === 0 && !defaultUrl) {
    findings.push(
      finding('motion_mapping', 'warning', 'アバターが設定されていますがモーションの割り当てがありません（静止します）'),
    );
  }
  if (defaultUrl) {
    const urlFinding = checkUrlValue('motion_mapping', 'defaultUrl', defaultUrl);
    if (urlFinding) findings.push(urlFinding);
  }
  return findings;
}

/**
 * 表示言語の選択肢と既定 locale の整合を検査する。
 *
 * **すべて warning。** `sanitizeLanguageSettings`（`src/lib/i18n/language-settings.ts`）が
 * 実行時に「空集合 → 既定のみ」「既定が選択肢外 → 先頭」へ必ず補正するため、どの不整合でも
 * 端末は壊れない。壊れないものを error にして公開を止めると、運用が理由なく止まる。
 * 指摘の意味は「運用者の意図どおりには配信されない」。
 */
export function checkLanguageFallback(sections: Record<string, unknown>): ValidationFinding[] {
  const languages = asRecord(sections.languages);
  if (!languages) {
    return [
      finding('language_fallback', 'warning', 'languages セクションが無いため既定の言語で配信されます'),
    ];
  }

  const enabled = Array.isArray(languages.enabledLocales) ? languages.enabledLocales : [];
  if (enabled.length === 0) {
    return [
      finding(
        'language_fallback',
        'warning',
        '有効な表示言語がありません（既定の言語のみで配信されます）',
      ),
    ];
  }

  const defaultLocale = nonEmptyString(languages.defaultLocale);
  if (defaultLocale && !enabled.includes(defaultLocale)) {
    return [
      finding(
        'language_fallback',
        'warning',
        `既定の表示言語 ${defaultLocale} が有効な言語に含まれていません（先頭の言語が既定になります）`,
      ),
    ];
  }
  return [];
}

/** スナップショットに対する全チェックをまとめて実行する。 */
export function runSnapshotChecks(sections: Record<string, unknown>): ValidationFinding[] {
  return [
    ...checkAssets(sections),
    ...checkMotionMapping(sections),
    ...checkLanguageFallback(sections),
  ];
}
