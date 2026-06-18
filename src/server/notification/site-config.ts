/**
 * 拠点設定の取得 (DESIGN #34 §5-2)。
 * 通知先・音声設定を SSM Parameter Store から取得する。
 * 失効拠点（enabled=false）は通知を受け付けない（kiosk 失効 #18 と整合）。
 *
 * SSM_ENABLED!=true のときは in-memory のローカル設定を使い、ローカル/テストで
 * 外部依存なく動作する。
 */
import type { SiteConfig } from './types';

const DEFAULT_VOICE = { voiceId: 'Mizuki', languageCode: 'ja-JP', engine: 'neural' as const };

export interface SiteConfigLoader {
  load(siteId: string): Promise<SiteConfig | null>;
}

/**
 * ローカル/テスト用。SSM を使わずメモリ上の拠点設定を返す。
 * - 拠点マップを明示指定した場合: 未登録 siteId は null（拒否）を返す。
 * - 引数なし（空マップ）の場合: 任意の siteId を有効拠点として扱う（ゼロ設定のローカル開発用）。
 */
export class InMemorySiteConfigLoader implements SiteConfigLoader {
  private readonly explicit: boolean;
  constructor(private readonly sites: Record<string, SiteConfig> = {}) {
    this.explicit = Object.keys(sites).length > 0;
  }

  async load(siteId: string): Promise<SiteConfig | null> {
    if (this.sites[siteId]) return this.sites[siteId];
    if (this.explicit) return null;
    return { siteId, enabled: true, voice: DEFAULT_VOICE };
  }
}

/**
 * SSM Parameter Store から拠点設定 JSON を取得する。
 * パラメータ名は `${prefix}/${siteId}` （例: /open-reception/prod/sites/site-001）。
 */
export class SsmSiteConfigLoader implements SiteConfigLoader {
  constructor(
    private readonly region: string,
    private readonly parameterPrefix: string,
  ) {}

  async load(siteId: string): Promise<SiteConfig | null> {
    const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
    const client = new SSMClient({ region: this.region });
    const name = `${this.parameterPrefix}/${siteId}`;
    try {
      const res = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
      const raw = res.Parameter?.Value;
      if (!raw) return null;
      return normalizeSiteConfig(siteId, JSON.parse(raw) as Partial<SiteConfig>);
    } catch (err) {
      // ParameterNotFound は「未登録拠点」= 認可しないため null を返す。
      if (err instanceof Error && err.name === 'ParameterNotFound') return null;
      throw err;
    }
  }
}

/** 取得した raw 設定を既定で補完して正規化する。 */
export function normalizeSiteConfig(siteId: string, raw: Partial<SiteConfig>): SiteConfig {
  return {
    siteId,
    enabled: raw.enabled ?? false,
    defaultTarget: raw.defaultTarget,
    voice: {
      voiceId: raw.voice?.voiceId ?? DEFAULT_VOICE.voiceId,
      languageCode: raw.voice?.languageCode ?? DEFAULT_VOICE.languageCode,
      engine: raw.voice?.engine ?? DEFAULT_VOICE.engine,
    },
  };
}

export function createSiteConfigLoader(
  env: Record<string, string | undefined> = process.env,
): SiteConfigLoader {
  if (env.SSM_ENABLED === 'true') {
    return new SsmSiteConfigLoader(
      env.AWS_REGION ?? 'ap-northeast-1',
      env.SITE_CONFIG_PREFIX ?? '/open-reception/sites',
    );
  }
  return new InMemorySiteConfigLoader();
}
