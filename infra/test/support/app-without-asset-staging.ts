import * as cdk from 'aws-cdk-lib';
import * as cxapi from 'aws-cdk-lib/cx-api';

/**
 * asset を outdir へコピーしない App (#1146)。WebStack を synth するテストはこれを使う。
 *
 * `aws:cdk:disable-asset-staging` は**コピーだけ**を止め、asset hash は同じ指紋から
 * 計算する。テンプレートが staging ありの App と同じであることは
 * `asset-staging.test.ts` が縛っている。
 */
export const appWithoutAssetStaging = (props: cdk.AppProps = {}): cdk.App =>
  new cdk.App({
    ...props,
    context: { ...props.context, [cxapi.DISABLE_ASSET_STAGING_CONTEXT]: true },
  });
