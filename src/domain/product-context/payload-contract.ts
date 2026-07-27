/**
 * 実効構成のペイロード契約 (issue #419 AC「PII・secret・サーバ専用設定が構成レスポンスへ混入しない」)。
 *
 * 端末へ配る構成は個別 API から 1 か所へ集約されるため、これまで各 API が個別に守っていた
 * 「返してよい値」の境界が 1 か所に集まる。ここが漏れると全端末へ一括で漏れるので、
 * **規約ではなく実行時の検査**として resolver に組み込み、違反時は fail-closed で拒否する
 * （`.claude/rules/pii-secret-minimization.md` / #405 の write-only 方針と同じ扱い）。
 *
 * 判定はキー名の形（型ではない）と `SecretValue` ラッパの検出で行う。値そのものは一切見ない・
 * 一切出力しない（検査自体が漏洩経路にならないようにする）。
 */

export type ForbiddenValueKind = 'secret' | 'server_only' | 'visitor_pii';

export type ForbiddenValueFinding = {
  /** 例: `integrations.vonage.privateKey` / `signage.items[1].accessKeyId`。 */
  path: string;
  /** 元のキー名（正規化前）。 */
  key: string;
  kind: ForbiddenValueKind;
};

/**
 * キー名の**末尾の語**が一致したら違反とみなす語（正規化: 小文字化 + 英数字以外を除去）。
 * 単純な部分文字列一致にしないのは、`tokenEndpoint`（正当な公開 URL）や `warn` のような
 * 語を誤検出しないため。語の切り出しは camelCase / snake_case / kebab-case の境界で行う。
 */
const TERM_RULES: ReadonlyArray<{ term: string; kind: ForbiddenValueKind }> = [
  { term: 'secret', kind: 'secret' },
  { term: 'privatekey', kind: 'secret' },
  { term: 'apikey', kind: 'secret' },
  { term: 'accesskey', kind: 'secret' },
  { term: 'accesskeyid', kind: 'secret' },
  { term: 'signingkey', kind: 'secret' },
  { term: 'password', kind: 'secret' },
  { term: 'passphrase', kind: 'secret' },
  { term: 'credential', kind: 'secret' },
  { term: 'credentials', kind: 'secret' },
  { term: 'token', kind: 'secret' },
  { term: 'tokenhash', kind: 'secret' },
  { term: 'arn', kind: 'server_only' },
  { term: 'connectionstring', kind: 'server_only' },
  { term: 'visitorname', kind: 'visitor_pii' },
  { term: 'visitoremail', kind: 'visitor_pii' },
  { term: 'visitorphone', kind: 'visitor_pii' },
  { term: 'visitorcompany', kind: 'visitor_pii' },
  { term: 'email', kind: 'visitor_pii' },
  { term: 'emailaddress', kind: 'visitor_pii' },
  { term: 'phonenumber', kind: 'visitor_pii' },
];

/** camelCase / snake_case / kebab-case を語に分解し、小文字化する。 */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w !== '')
    .map((w) => w.toLowerCase());
}

/** キー末尾の 1〜n 語を連結した候補（`secretArn` → `arn`, `secretarn`）。 */
function trailingTerms(key: string): string[] {
  const words = keyWords(key);
  const terms: string[] = [];
  for (let take = 1; take <= words.length; take += 1) {
    terms.push(words.slice(words.length - take).join(''));
  }
  return terms;
}

function classifyKey(key: string): ForbiddenValueKind | null {
  const terms = new Set(trailingTerms(key));
  for (const rule of TERM_RULES) {
    if (terms.has(rule.term)) return rule.kind;
  }
  return null;
}

/** `SecretValue`（`src/domain/provider-config/secret.ts`）等の redact ラッパか。 */
function isSecretWrapper(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return (value as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag] === 'SecretValue';
}

/**
 * 構成ペイロードから禁止値を洗い出す。循環参照でも停止する。
 * 見つからなければ空配列（= 配信してよい）。
 */
export function findForbiddenConfigurationValues(
  value: unknown,
  basePath = '',
): ForbiddenValueFinding[] {
  const findings: ForbiddenValueFinding[] = [];
  const seen = new WeakSet<object>();

  const walk = (node: unknown, path: string): void => {
    if (typeof node !== 'object' || node === null) return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${path}[${index}]`));
      return;
    }

    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path === '' ? key : `${path}.${key}`;
      const kind = classifyKey(key);
      if (kind !== null) {
        findings.push({ path: childPath, key, kind });
        // キー名で既に違反。値の中身は辿らない（配下の値を出力に含めない）。
        continue;
      }
      if (isSecretWrapper(child)) {
        findings.push({ path: childPath, key, kind: 'secret' });
        continue;
      }
      walk(child, childPath);
    }
  };

  walk(value, basePath);
  return findings;
}

/**
 * 禁止値があれば投げる。メッセージにはパスと種別だけを載せ、**値は載せない**
 * （例外がログ・監視へ流れても漏洩しない）。
 */
export function assertNoForbiddenConfigurationValues(value: unknown, basePath = ''): void {
  const findings = findForbiddenConfigurationValues(value, basePath);
  if (findings.length === 0) return;
  const summary = findings.map((f) => `${f.path} (${f.kind})`).join(', ');
  throw new Error(`forbidden values in kiosk configuration: ${summary}`);
}
