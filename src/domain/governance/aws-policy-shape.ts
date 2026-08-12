/**
 * IAM ポリシー JSON の構造検証 (spec §11)。
 *
 * 副作用なし。**これは網であって証明ではない** — 「書き忘れ」と「明らかな穴」を
 * 機械で押さえるだけで、実際に DENY されるかは `SimulatePrincipalPolicy` が確かめる
 * （`scripts/aws-negative-tests.ts`）。両方揃って初めて spec §9 を満たす。
 */

export type PolicyStatement = {
  readonly Effect: 'Allow' | 'Deny';
  readonly Action?: string | ReadonlyArray<string>;
  readonly NotAction?: string | ReadonlyArray<string>;
  readonly Resource?: string | ReadonlyArray<string>;
  readonly Principal?: unknown;
  readonly Condition?: Record<string, Record<string, string | ReadonlyArray<string>>>;
};

export type PolicyDocument = {
  readonly Version: string;
  readonly Statement: ReadonlyArray<PolicyStatement>;
};

export type PolicyAudit = {
  /** Allow かつ Action:* かつ Resource:* を含むか。 */
  readonly grantsAdmin: boolean;
  /** PermissionsBoundary 条件の無い `iam:CreateRole` の Allow を含むか。 */
  readonly unboundedRoleCreation: boolean;
  readonly deniedActions: ReadonlyArray<string>;
  readonly deniedResourcePatterns: ReadonlyArray<string>;
  readonly allowedResourcePatterns: ReadonlyArray<string>;
};

const list = (v: string | ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
  v === undefined ? [] : typeof v === 'string' ? [v] : v;

/** `iam:PermissionsBoundary` 条件が付いているか。キー名は大小差を吸収する。 */
function hasBoundaryCondition(s: PolicyStatement): boolean {
  if (s.Condition === undefined) return false;
  for (const values of Object.values(s.Condition)) {
    for (const key of Object.keys(values)) {
      if (key.toLowerCase() === 'iam:permissionsboundary') return true;
    }
  }
  return false;
}

const matchesAction = (actions: ReadonlyArray<string>, wanted: string): boolean =>
  actions.some((a) => a === wanted || a === '*' || (a.endsWith(':*') && wanted.startsWith(a.slice(0, -1))));

export function auditPolicyDocument(doc: PolicyDocument): PolicyAudit {
  let grantsAdmin = false;
  let unboundedRoleCreation = false;
  const deniedActions: string[] = [];
  const deniedResourcePatterns: string[] = [];
  const allowedResourcePatterns: string[] = [];

  for (const s of doc.Statement) {
    const actions = list(s.Action);
    const resources = list(s.Resource);

    if (s.Effect === 'Deny') {
      deniedActions.push(...actions);
      deniedResourcePatterns.push(...resources);
      continue;
    }

    allowedResourcePatterns.push(...resources);
    if (actions.includes('*') && resources.includes('*')) grantsAdmin = true;
    if (matchesAction(actions, 'iam:CreateRole') && !hasBoundaryCondition(s)) {
      unboundedRoleCreation = true;
    }
  }

  return { grantsAdmin, unboundedRoleCreation, deniedActions, deniedResourcePatterns, allowedResourcePatterns };
}
