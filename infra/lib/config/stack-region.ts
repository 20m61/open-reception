/**
 * Pinned stack regions (#1220 broker, #1221 app).
 *
 * The CDK CLI always exports `CDK_DEFAULT_REGION` to the app (from `AWS_REGION` / the profile, falling
 * back to `us-east-1`), so `process.env.CDK_DEFAULT_REGION ?? '<region>'` is never the fallback it looks
 * like: a profile in another region silently moves the stack there, and an offline synth without a
 * configured region produces a `us-east-1` stack. A stack that lives in exactly one region therefore
 * pins it, and refuses a different configured region rather than silently overriding it: the operator's
 * other commands in the same shell (`aws cloudformation …`) would otherwise target a different region
 * from the stack, and the mismatch must surface before a deploy.
 */

/**
 * Returns `pinned`, or throws when `CDK_DEFAULT_REGION` is set to anything else (including `''`).
 * `subject` names the stack(s) in the error, e.g. `The dev deploy broker stack`.
 */
export function pinnedStackRegion(
  env: Readonly<Record<string, string | undefined>>,
  pinned: string,
  subject: string,
): string {
  const configured = env.CDK_DEFAULT_REGION;
  if (configured !== undefined && configured !== pinned) {
    throw new Error(
      `${subject} must be synthesized for ${pinned}, but CDK_DEFAULT_REGION is ${JSON.stringify(configured)}. ` +
        `Set AWS_REGION=${pinned} instead of relying on the profile's region.`,
    );
  }
  return pinned;
}

/**
 * The region of the app stacks built by `bin/open-reception.ts` (Web / WebMonitoring / Notification /
 * Monitoring / RealtimeRuntime). `OpenReception-CfMon-*` is deliberately **not** covered: it is placed in
 * `us-east-1` explicitly, because CloudFront metrics are published only there.
 *
 * The deploy paths already target this region: `scripts/aws-cloud-deploy.sh` (`AWS_REGION` defaulting
 * to ap-northeast-1, issued as ap-northeast-1 by `scripts/aws-issue-credentials.sh`) and the broker's
 * Validation synth (`CDK_DEFAULT_REGION=$OR_BROKER_TARGET_REGION`, the broker stack's own region, itself
 * pinned to ap-northeast-1).
 */
export const APP_STACK_REGION = 'ap-northeast-1';

export function appStackRegion(env: Readonly<Record<string, string | undefined>>): string {
  return pinnedStackRegion(env, APP_STACK_REGION, 'The open-reception app stacks');
}
