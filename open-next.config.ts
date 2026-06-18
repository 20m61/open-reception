import type { OpenNextConfig } from '@opennextjs/aws/types/open-next.js';

/**
 * OpenNext (AWS) ビルド設定。
 * Next.js 16 アプリを AWS Lambda + CloudFront + S3 へデプロイ可能な成果物
 * (`.open-next/`) に変換する。インフラは `infra/`（CDK）の WebStack が
 * この成果物を取り込んでデプロイする。
 *
 * - 本アプリは ISR / revalidateTag を使わないため、リバリデーション用の
 *   キュー・タグキャッシュは OpenNext 既定のままで十分。
 * - サーバ処理は単一の server function（Lambda, Node.js）に集約し、
 *   CloudFront から Lambda Function URL を single origin として参照する。
 * - Lambda の memory/arch などランタイム設定は CDK(WebStack) 側で指定する。
 */
const config = {
  default: {
    override: {
      wrapper: 'aws-lambda',
      converter: 'aws-cloudfront',
      // ISR/On-demand Revalidation を使わないため、リバリデーション基盤
      // (SQS / DynamoDB tag cache / S3 incremental cache) を無効化する。
      // これにより WebStack は S3 + server/image Lambda + CloudFront のみで完結する。
      queue: 'dummy',
      incrementalCache: 'dummy',
      tagCache: 'dummy',
    },
  },
} satisfies OpenNextConfig;

export default config;
