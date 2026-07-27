/**
 * 実効構成の指紋 (issue #419)。
 *
 * AC「同一 version に対しプレビューと本番 resolver の構成ハッシュが一致する」を成立させるため、
 * ハッシュ入力を**構成の内容だけ**に限定する:
 *   - 含める: 端末スコープ（tenant/site/kiosk）・版の同定（id/status/revision）・各セクションの値。
 *   - 含めない: 生成時刻・呼び出し元の area/actor・`publishedAt`（配信時刻であって内容ではない）。
 *
 * オブジェクトのキー順は正規化する（ストアやローダの実装差でハッシュが揺れないため）。
 * 配列の順序は保持する（表示順・優先順位が意味を持つ）。
 */
import { createHash } from 'node:crypto';
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type { ConfigurationSectionName, ExperienceVersionRef } from './types';

export type ConfigHashInput = {
  context: { tenantId: TenantId; siteId: SiteId; kioskId: string };
  version: Pick<ExperienceVersionRef, 'id' | 'status' | 'revision'> & { publishedAt?: string };
  sections: Partial<Record<ConfigurationSectionName, unknown>>;
};

/**
 * キー順に依存しない JSON 文字列表現。`undefined` のキーは JSON.stringify と同じく落とし、
 * `null` は残す（「明示的に無効」と「未設定」を区別する）。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const child = source[key];
    if (child === undefined) continue;
    out[key] = canonicalize(child);
  }
  return out;
}

/**
 * **内容だけ**の指紋（`sha256:<hex>`）。context も version も含めない。
 *
 * `computeConfigHash` との使い分け:
 *   - `computeConfigHash` … 「その端末にその版で配られた構成」の指紋。context/version を含むので、
 *     端末が違えば違う値になる。API 応答の `configHash` はこちら。
 *   - `computeSectionsHash` … 「構成の中身」の指紋。版のスナップショット（#420）が持ち、
 *     版どうしの内容比較・live ストアとのドリフト検出に使う。
 */
export function computeSectionsHash(
  sections: Partial<Record<ConfigurationSectionName, unknown>>,
): string {
  const material = canonicalJson(sections);
  return `sha256:${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

/** 構成内容の指紋（`sha256:<hex>`）。 */
export function computeConfigHash(input: ConfigHashInput): string {
  const material = canonicalJson({
    context: input.context,
    version: {
      id: input.version.id,
      status: input.version.status,
      revision: input.version.revision,
    },
    sections: input.sections,
  });
  return `sha256:${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}
