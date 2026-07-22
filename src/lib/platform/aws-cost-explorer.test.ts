import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAwsCostCacheForTests,
  buildCostFilter,
  buildCostPeriods,
  getAwsCostSummary,
} from './aws-cost-explorer';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetAwsCostCacheForTests();
});

function enableCostExplorerEnv(environment = 'prod') {
  vi.stubEnv('AWS_COST_EXPLORER_ENABLED', 'true');
  vi.stubEnv('AWS_COST_PROJECT_TAG_VALUE', 'open-reception');
  vi.stubEnv('AWS_COST_ENVIRONMENT_TAG_VALUE', environment);
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDEXAMPLE');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret-example');
  vi.stubEnv('AWS_SESSION_TOKEN', 'session-example');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('AWS Cost Explorer adapter (#377)', () => {
  it('fixes Project and adds only selected Environment / Component tag filters', () => {
    expect(
      buildCostFilter({ project: 'open-reception', environment: 'prod', component: 'web' }),
    ).toEqual({
      And: [
        {
          Tags: {
            Key: 'Project',
            Values: ['open-reception'],
            MatchOptions: ['EQUALS', 'CASE_SENSITIVE'],
          },
        },
        {
          Tags: {
            Key: 'Environment',
            Values: ['prod'],
            MatchOptions: ['EQUALS', 'CASE_SENSITIVE'],
          },
        },
        {
          Tags: {
            Key: 'Component',
            Values: ['web'],
            MatchOptions: ['EQUALS', 'CASE_SENSITIVE'],
          },
        },
      ],
    });
  });

  it('uses elapsed month for actual and today-to-next-month for forecast', () => {
    expect(buildCostPeriods(new Date('2026-07-19T08:00:00.000Z'))).toEqual({
      monthStart: '2026-07-01',
      actualEndExclusive: '2026-07-19',
      forecastStart: '2026-07-19',
      monthEndExclusive: '2026-08-01',
    });
  });

  it('aggregates tagged actual cost and remaining forecast with SigV4 headers', async () => {
    vi.stubEnv('AWS_COST_EXPLORER_ENABLED', 'true');
    vi.stubEnv('AWS_COST_PROJECT_TAG_VALUE', 'open-reception');
    vi.stubEnv('AWS_COST_ENVIRONMENT_TAG_VALUE', 'prod');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDEXAMPLE');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret-example');
    vi.stubEnv('AWS_SESSION_TOKEN', 'session-example');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ResultsByTime: [
              {
                Groups: [
                  {
                    Keys: ['Component$web'],
                    Metrics: { UnblendedCost: { Amount: '12.50', Unit: 'USD' } },
                  },
                  {
                    Keys: ['Component$monitoring'],
                    Metrics: { UnblendedCost: { Amount: '2.50', Unit: 'USD' } },
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ Total: { Amount: '8.25', Unit: 'USD' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const summary = await getAwsCostSummary({
      environment: 'prod',
      component: 'all',
      now: new Date('2026-07-19T08:00:00.000Z'),
    });

    expect(summary).toMatchObject({
      status: 'available',
      currency: 'USD',
      actualToDate: 15,
      forecastRemaining: 8.25,
      monthEndEstimate: 23.25,
      breakdownBy: 'Component',
      breakdown: [
        { key: 'web', amount: 12.5 },
        { key: 'monitoring', amount: 2.5 },
      ],
      forecastAvailable: true,
      forecastUnavailableReason: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://ce.us-east-1.amazonaws.com/');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-amz-target']).toBe('AWSInsightsIndexService.GetCostAndUsage');
    // 同一 payload/date/credentials を botocore SigV4Auth で署名した値と完全一致させる。
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260719/us-east-1/ce/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, ' +
        'Signature=24cc4d3958100adea1bf4cb6c61287fe413f554e7c9c69dc1e50e7e0c25f5814',
    );
    expect(headers['x-amz-security-token']).toBe('session-example');

    const requestBody = JSON.parse(init.body as string);
    expect(requestBody.GroupBy).toEqual([{ Type: 'TAG', Key: 'Component' }]);
    expect(requestBody.Filter).toEqual(
      expect.objectContaining({
        And: expect.arrayContaining([
          expect.objectContaining({ Tags: expect.objectContaining({ Key: 'Project' }) }),
          expect.objectContaining({ Tags: expect.objectContaining({ Key: 'Environment' }) }),
        ]),
      }),
    );
  });

  it('degrades without calling AWS when the integration is disabled', async () => {
    vi.stubEnv('AWS_COST_EXPLORER_ENABLED', 'false');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(getAwsCostSummary({ environment: 'prod' })).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'disabled',
      filters: { project: 'open-reception', environment: 'prod', component: 'all' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports credentials_unavailable when the execution role has no AWS credentials', async () => {
    vi.stubEnv('AWS_COST_EXPLORER_ENABLED', 'true');
    vi.stubEnv('AWS_ACCESS_KEY_ID', '');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getAwsCostSummary({ environment: 'dev', component: 'monitoring' }),
    ).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'credentials_unavailable',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports request_failed (not disguised as "no history") on AWS 4xx/5xx and never leaks the AWS error body', async () => {
    enableCostExplorerEnv('staging');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { __type: 'AccessDeniedException', Message: 'super-secret-internal-arn-12345' },
          403,
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const summary = await getAwsCostSummary({
      environment: 'staging',
      component: 'web',
      now: new Date('2026-07-19T08:00:00.000Z'),
    });

    expect(summary).toMatchObject({ status: 'unavailable', reason: 'request_failed' });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('super-secret-internal-arn-12345');
    expect(serialized).not.toContain('AccessDeniedException');
  });

  it('distinguishes forecast no_history (DataUnavailableException) from other forecast failures', async () => {
    enableCostExplorerEnv('staging');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ResultsByTime: [{ Total: { UnblendedCost: { Amount: '1.00', Unit: 'USD' } } }] }))
      .mockResolvedValueOnce(jsonResponse({ __type: 'DataUnavailableException' }, 400));
    vi.stubGlobal('fetch', fetchMock);

    const summary = await getAwsCostSummary({
      environment: 'staging',
      component: 'notification',
      now: new Date('2026-07-19T08:00:00.000Z'),
    });

    expect(summary).toMatchObject({
      status: 'available',
      forecastAvailable: false,
      forecastRemaining: null,
      monthEndEstimate: null,
      forecastUnavailableReason: 'no_history',
    });
  });

  it('reports forecast request_failed (not no_history) for non-DataUnavailableException forecast errors', async () => {
    enableCostExplorerEnv('staging');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ResultsByTime: [{ Total: { UnblendedCost: { Amount: '1.00', Unit: 'USD' } } }] }))
      .mockResolvedValueOnce(jsonResponse({ __type: 'AccessDeniedException' }, 403));
    vi.stubGlobal('fetch', fetchMock);

    const summary = await getAwsCostSummary({
      environment: 'staging',
      component: 'cloudfront-monitoring',
      now: new Date('2026-07-19T08:00:00.000Z'),
    });

    expect(summary).toMatchObject({
      status: 'available',
      forecastAvailable: false,
      forecastUnavailableReason: 'request_failed',
    });
  });

  it('throws once GetCostAndUsage pagination exceeds the MAX_PAGES safety limit (surfaced as request_failed)', async () => {
    enableCostExplorerEnv('staging');
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          ResultsByTime: [{ Total: { UnblendedCost: { Amount: '1.00', Unit: 'USD' } } }],
          NextPageToken: 'always-more',
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const summary = await getAwsCostSummary({
      environment: 'staging',
      component: 'web-monitoring',
      now: new Date('2026-07-19T08:00:00.000Z'),
    });

    expect(summary).toMatchObject({ status: 'unavailable', reason: 'request_failed' });
    // MAX_PAGES=20 で必ず打ち切る（無限にページングして CE 課金が青天井にならないこと）。
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it('caches a summary per filter combination within the TTL, avoiding repeat Cost Explorer requests', async () => {
    enableCostExplorerEnv('staging');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ResultsByTime: [{ Total: { UnblendedCost: { Amount: '3.00', Unit: 'USD' } } }] }))
      .mockResolvedValueOnce(jsonResponse({ Total: { Amount: '1.00', Unit: 'USD' } }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await getAwsCostSummary({
      environment: 'staging',
      component: 'web',
      now: new Date('2026-07-19T08:00:00.000Z'),
    });
    // 2 分後の再取得（TTL 5 分以内）は Cost Explorer を再度呼ばず、同じ結果をキャッシュから返す。
    const second = await getAwsCostSummary({
      environment: 'staging',
      component: 'web',
      now: new Date('2026-07-19T08:02:00.000Z'),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second).toEqual(first);
  });

  it('re-fetches from Cost Explorer once the cache TTL has elapsed', async () => {
    enableCostExplorerEnv('staging');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ResultsByTime: [{ Total: { UnblendedCost: { Amount: '3.00', Unit: 'USD' } } }] }))
      .mockResolvedValueOnce(jsonResponse({ Total: { Amount: '1.00', Unit: 'USD' } }))
      .mockResolvedValueOnce(jsonResponse({ ResultsByTime: [{ Total: { UnblendedCost: { Amount: '9.00', Unit: 'USD' } } }] }))
      .mockResolvedValueOnce(jsonResponse({ Total: { Amount: '2.00', Unit: 'USD' } }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await getAwsCostSummary({
      environment: 'staging',
      component: 'monitoring',
      now: new Date('2026-07-19T08:00:00.000Z'),
    });
    // 6 分後（TTL 5 分超過）は再度 Cost Explorer を呼ぶ。
    const second = await getAwsCostSummary({
      environment: 'staging',
      component: 'monitoring',
      now: new Date('2026-07-19T08:06:00.000Z'),
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(first).toMatchObject({ actualToDate: 3 });
    expect(second).toMatchObject({ actualToDate: 9 });
  });

  it('does not mix cached summaries across different filter combinations', async () => {
    enableCostExplorerEnv('staging');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ResultsByTime: [{ Total: { UnblendedCost: { Amount: '3.00', Unit: 'USD' } } }] }))
      .mockResolvedValueOnce(jsonResponse({ Total: { Amount: '1.00', Unit: 'USD' } }))
      .mockResolvedValueOnce(jsonResponse({ ResultsByTime: [{ Total: { UnblendedCost: { Amount: '7.00', Unit: 'USD' } } }] }))
      .mockResolvedValueOnce(jsonResponse({ Total: { Amount: '2.00', Unit: 'USD' } }));
    vi.stubGlobal('fetch', fetchMock);

    const web = await getAwsCostSummary({
      environment: 'staging',
      component: 'web',
      now: new Date('2026-07-19T08:00:00.000Z'),
    });
    const notification = await getAwsCostSummary({
      environment: 'staging',
      component: 'notification',
      now: new Date('2026-07-19T08:00:30.000Z'),
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(web).toMatchObject({ actualToDate: 3 });
    expect(notification).toMatchObject({ actualToDate: 7 });
  });
});

describe('buildCostFilter single-expression branch (#379)', () => {
  it('omits the And wrapper when environment=all and component=all (only the fixed Project tag)', () => {
    expect(
      buildCostFilter({ project: 'open-reception', environment: 'all', component: 'all' }),
    ).toEqual({
      Tags: {
        Key: 'Project',
        Values: ['open-reception'],
        MatchOptions: ['EQUALS', 'CASE_SENSITIVE'],
      },
    });
  });
});
