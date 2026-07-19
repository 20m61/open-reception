import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCostFilter,
  buildCostPeriods,
  getAwsCostSummary,
} from './aws-cost-explorer';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
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
});
