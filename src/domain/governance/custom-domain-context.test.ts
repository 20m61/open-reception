import { describe, expect, it } from 'vitest';
import { resolveCustomDomainContext } from './custom-domain-context';

const CERT = 'arn:aws:acm:us-east-1:822063948773:certificate/11111111-2222-3333-4444-555555555555';
const VALID = JSON.stringify({
  domainName: 'open-reception.cinc.click',
  certificateArn: CERT,
});

/** ok のときだけ args を取り出す。ok=false で呼ぶとテストが落ちる（分岐の取り違え防止）。 */
function argsOf(raw: string | undefined): readonly string[] {
  const result = resolveCustomDomainContext(raw);
  if (!result.ok) throw new Error(`期待に反して ok=false: ${result.message}`);
  return result.args;
}

describe('resolveCustomDomainContext — 任意であること', () => {
  // 🔴 下界。必須 4 変数と違い、これは**未指定が正常**（CDK 生成ドメインのみ）。
  //    ここを必須として扱うと、独自ドメインを使わない環境の deploy を全部止めてしまう。
  it('未指定・空・空白のみは「使わない」として通り、args を足さない', () => {
    for (const raw of [undefined, '', '   ', '\n']) {
      expect(argsOf(raw), `raw=${JSON.stringify(raw)}`).toEqual([]);
    }
  });

  it('enabled:false は無効化として尊重し、args を足さない', () => {
    const raw = JSON.stringify({
      enabled: false,
      domainName: 'open-reception.cinc.click',
      certificateArn: CERT,
    });
    expect(argsOf(raw)).toEqual([]);
  });

  it('妥当な指定は -c customDomain=<json> の 2 要素になる', () => {
    const args = argsOf(VALID);
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('-c');
    expect(args[1]?.startsWith('customDomain=')).toBe(true);
  });

  // 🔴 上界。通ったと報告された入力は、実際に CDK が読む形へ復元できなければならない。
  //    「通ったが中身が壊れている」は synth まで気づけない。
  it('通った場合、出力の JSON は domainName と certificateArn を保存している', () => {
    const args = argsOf(VALID);
    const json = args[1]!.slice('customDomain='.length);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.domainName).toBe('open-reception.cinc.click');
    expect(parsed.certificateArn).toBe(CERT);
  });
});

describe('resolveCustomDomainContext — 落とすべきもの', () => {
  it('JSON として読めなければ落とす', () => {
    const result = resolveCustomDomainContext('open-reception.cinc.click');
    expect(result.ok).toBe(false);
  });

  it('domainName / certificateArn が欠けていれば落とす', () => {
    expect(resolveCustomDomainContext(JSON.stringify({ certificateArn: CERT })).ok).toBe(false);
    expect(
      resolveCustomDomainContext(JSON.stringify({ domainName: 'open-reception.cinc.click' })).ok,
    ).toBe(false);
  });

  // 🔴 **これが #995 と同じ型。** docs/deploy-aws.md の例は
  //    `arn:aws:acm:us-east-1:<acct>:certificate/<id>` というプレースホルダ付きで、
  //    そのまま貼れる形をしている。4 回目のデプロイは runbook の散文を貼った値で
  //    deploy 直前まで進んだ ―― 同じ穴を開けたままにしない。
  it('山括弧つきのプレースホルダを落とす', () => {
    const raw = JSON.stringify({
      domainName: 'open-reception.cinc.click',
      certificateArn: 'arn:aws:acm:us-east-1:<acct>:certificate/<id>',
    });
    const result = resolveCustomDomainContext(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/プレースホルダ/);
  });

  // 🔴 CloudFront は us-east-1 の証明書しか受け付けない。ap-northeast-1 の ARN は
  //    **synth を通ってデプロイで落ちる**ので、窓を食う前にここで落とす。
  it('us-east-1 以外の証明書 ARN を落とす', () => {
    const raw = JSON.stringify({
      domainName: 'open-reception.cinc.click',
      certificateArn: CERT.replace('us-east-1', 'ap-northeast-1'),
    });
    const result = resolveCustomDomainContext(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/us-east-1/);
  });

  it('ACM の証明書 ARN でないものを落とす', () => {
    for (const arn of [
      'arn:aws:iam::822063948773:server-certificate/foo',
      'arn:aws:acm:us-east-1:822063948773:key/abc',
      'not-an-arn',
    ]) {
      const raw = JSON.stringify({ domainName: 'open-reception.cinc.click', certificateArn: arn });
      expect(resolveCustomDomainContext(raw).ok, `arn=${arn}`).toBe(false);
    }
  });

  /**
   * 🔴 **本命。** このデプロイ経路は `route53:*` が明示 Deny
   * （`claude-boundary.json` の `DenySharedDnsAndCertificates` /
   * `claude-cfn-exec.json` の `DenyDnsAndPrincipals`）。`createDnsRecord: true` を通すと
   * **synth の HostedZone.fromLookup か deploy の途中**で AccessDenied になり、
   * 原因が DNS 権限だと読み取れないまま窓を消費する。ここで理由ごと落とす。
   */
  it('createDnsRecord:true を、理由を示して落とす', () => {
    const raw = JSON.stringify({
      domainName: 'open-reception.cinc.click',
      certificateArn: CERT,
      hostedZoneDomainName: 'cinc.click',
      createDnsRecord: true,
    });
    const result = resolveCustomDomainContext(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/route53/i);
      expect(result.message).toMatch(/createDnsRecord/);
    }
  });

  it('createDnsRecord:false と未指定はどちらも通る', () => {
    const withFalse = JSON.stringify({
      domainName: 'open-reception.cinc.click',
      certificateArn: CERT,
      createDnsRecord: false,
    });
    expect(resolveCustomDomainContext(withFalse).ok).toBe(true);
    expect(resolveCustomDomainContext(VALID).ok).toBe(true);
  });

  it('domainName が FQDN の形をしていなければ落とす', () => {
    for (const domainName of ['open-reception', 'https://open-reception.cinc.click', 'a b.com']) {
      const raw = JSON.stringify({ domainName, certificateArn: CERT });
      expect(resolveCustomDomainContext(raw).ok, `domainName=${domainName}`).toBe(false);
    }
  });

  // 🔴 診断に証明書 ARN 以外の値を載せないことより先に、**落ちた理由が読めること**を縛る。
  //    「不正です」だけでは、窓を開けた人がどこを直せばよいか分からない。
  it('落ちたときは必ず理由の本文を持つ', () => {
    const result = resolveCustomDomainContext('{}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
  });
});
