/**
 * runbook が entry role へ勧める AWS CLI コマンドを、entry role の Allow と突き合わせる純関数。
 *
 * ## なぜ
 *
 * `docs/runbook-cloud-aws-deploy.md` ステップ 9b は、diff gate がブロックしたときの
 * 承認手順として **`aws cloudformation get-template` で現行と synth を突き合わせる**と
 * 書いていた。ところが `OpenReceptionClaudeDeploy-dev` は `cloudformation:GetTemplate` を
 * 持っていない（2026-09-06 実測。AccessDenied）。**クラウドから承認する運用なのに、
 * runbook が指定した検証手段が塞がっていた**。
 *
 * 直したうえで同じ型の再発を止める。散文は実測から遅れるので、
 * **runbook の手順に書いてあるコマンドが本当に実行できるか**を機械で縛る
 * （`tests/config/loop-round-skill.test.ts` と同じ狙い）。
 *
 * ここは I/O を持たない ―― ファイルの読み出しは呼び出し側（テスト）が行う。
 */

/** IAM ポリシー文（このモジュールが必要とする最小形）。 */
export type EntryPolicyStatement = {
  readonly Effect?: string;
  readonly Action?: string | readonly string[];
  readonly NotAction?: string | readonly string[];
};

export type EntryPolicyDocument = {
  readonly Statement?: readonly EntryPolicyStatement[];
};

function toList(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  return typeof value === 'string' ? [value] : value;
}

/**
 * AWS CLI のサブコマンド名を IAM action 名へ直す（`describe-change-set` → `DescribeChangeSet`）。
 *
 * CLI のサブコマンドは kebab-case、IAM action は PascalCase で、AWS はこの対応を
 * 機械的に保っている（`get-template` → `GetTemplate`、`list-change-sets` → `ListChangeSets`）。
 */
export function cliSubcommandToActionName(subcommand: string): string {
  return subcommand
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * ポリシーが Allow している action を、指定サービスぶんだけ小文字で返す。
 *
 * `Deny` 文は見ない。**「Allow に無い ＝ 実行できない」で十分**だからである
 * （IAM の既定は暗黙 Deny。Deny を数えると「明示 Deny が無いから通る」と読み違えうる）。
 * ワイルドカード（`cloudformation:*` / `*`）は「全部 Allow」として扱う。
 */
export function allowedActionsForService(
  policy: EntryPolicyDocument,
  service: string,
): { readonly wildcard: boolean; readonly actions: ReadonlySet<string> } {
  const prefix = `${service.toLowerCase()}:`;
  const actions = new Set<string>();
  let wildcard = false;
  for (const statement of policy.Statement ?? []) {
    if (statement.Effect !== 'Allow') continue;
    for (const raw of toList(statement.Action)) {
      const action = raw.toLowerCase();
      if (action === '*' || action === `${prefix}*`) {
        wildcard = true;
        continue;
      }
      if (action.startsWith(prefix)) actions.add(action);
    }
  }
  return { wildcard, actions };
}

/**
 * Markdown から、指定言語のコードフェンスの中身だけを取り出す。
 *
 * 🔴 **散文とコマンドを混ぜて判定しない。** runbook は「これは使えない」という**禁止の例**を
 * 散文に書く（`get-template` がまさにそれ）。散文ごと拾うと、禁止を明記したこと自体が
 * 検査違反になり、正しい文書が書けなくなる。**実行されるのはフェンスの中だけ**である。
 */
export function extractFencedBlocks(markdown: string, language: string): readonly string[] {
  const pattern = new RegExp(`^\`\`\`${language}\\s*$([\\s\\S]*?)^\`\`\`\\s*$`, 'gm');
  return [...markdown.matchAll(pattern)].map((match) => match[1] ?? '');
}

/**
 * 見出しから次の同レベル以上の見出しまでを切り出す（`## ` / `### ` のいずれでも使える）。
 * 見つからなければ空文字（呼び出し側が「切り出せなかった」を検出できるように）。
 *
 * 🔴 **コードフェンスの中を見出しと読まない。** bash ブロックの行コメント（`# 1. まず…`）は
 * 見出しの正規表現に一致する。素朴に `^#{1,N} ` を検索すると**節がコメント行で途切れ**、
 * その下のコマンドが検査対象から丸ごと消える ―― つまり**検査が空虚に通る**。
 * 実際にこの実装で一度踏んだ（下界のアサーションが拾った）。
 */
export function extractSection(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  if (start < 0) return '';
  const level = heading.match(/^#+/)?.[0].length ?? 2;
  const nextHeading = new RegExp(`^#{1,${level}} `);
  const lines = markdown.slice(start + heading.length).split('\n');
  const body: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    else if (!inFence && nextHeading.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

/** `aws <service> <subcommand>` の呼び出し 1 つ。 */
export type AwsCliInvocation = {
  readonly service: string;
  readonly subcommand: string;
  /** `service:Subcommand` 形式の IAM action 名。 */
  readonly action: string;
};

/**
 * テキストから `aws <service> <subcommand>` を全部拾う。
 *
 * 行継続（`\` + 改行）やオプションは無視してよい ―― 判定に要るのは先頭 2 語だけである。
 * 同じ呼び出しが複数回出てきても 1 つに畳む（呼び出し側は「使われている集合」を見たい）。
 */
export function extractAwsCliInvocations(text: string): readonly AwsCliInvocation[] {
  const seen = new Map<string, AwsCliInvocation>();
  const pattern = /\baws\s+([a-z0-9-]+)\s+([a-z0-9-]+)/g;
  for (const match of text.matchAll(pattern)) {
    const service = match[1] ?? '';
    const subcommand = match[2] ?? '';
    // `aws --version` のようにオプションが来る形は対象外。
    if (service === '' || subcommand === '' || service.startsWith('-') || subcommand.startsWith('-')) continue;
    const action = `${service}:${cliSubcommandToActionName(subcommand)}`;
    seen.set(action, { service, subcommand, action });
  }
  return [...seen.values()];
}

/**
 * entry role が実行できない呼び出しだけを返す。
 *
 * 対象サービスに Allow が 1 つも無い（＝そのサービスを一切触れない）場合も
 * **全部「実行できない」**として返す。判定不能を PASS へ倒さない。
 */
export function unexecutableInvocations(
  invocations: readonly AwsCliInvocation[],
  policy: EntryPolicyDocument,
): readonly AwsCliInvocation[] {
  return invocations.filter((invocation) => {
    const { wildcard, actions } = allowedActionsForService(policy, invocation.service);
    if (wildcard) return false;
    return !actions.has(invocation.action.toLowerCase());
  });
}
