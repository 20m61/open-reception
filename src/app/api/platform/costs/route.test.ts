import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const authorizePlatform = vi.fn();
const getAwsCostSummary = vi.fn();

vi.mock('@/lib/platform/request', () => ({
  authorizePlatform: () => authorizePlatform(),
}));
vi.mock('@/lib/platform/aws-cost-explorer', () => ({
  getAwsCostSummary: (...args: unknown[]) => getAwsCostSummary(...args),
}));

import { GET } from './route';

function request(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/platform/costs${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  authorizePlatform.mockResolvedValue({ ok: true });
  getAwsCostSummary.mockResolvedValue({
    status: 'available',
    currency: 'USD',
    filters: { project: 'open-reception', environment: 'prod', component: 'all' },
    period: {
      monthStart: '2026-07-01',
      actualEndExclusive: '2026-07-19',
      forecastStart: '2026-07-19',
      monthEndExclusive: '2026-08-01',
    },
    actualToDate: 10,
    forecastRemaining: 5,
    monthEndEstimate: 15,
    breakdownBy: 'Component',
    breakdown: [],
    updatedAt: '2026-07-19T00:00:00.000Z',
    forecastAvailable: true,
  });
});

describe('GET /api/platform/costs (#377)', () => {
  it('requires developer authorization', async () => {
    authorizePlatform.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    });
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(getAwsCostSummary).not.toHaveBeenCalled();
  });

  it('rejects arbitrary environment values', async () => {
    const response = await GET(request('?environment=customer-prod'));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_environment_filter' });
    expect(getAwsCostSummary).not.toHaveBeenCalled();
  });

  it('rejects arbitrary component values', async () => {
    const response = await GET(request('?component=../../billing'));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_component_filter' });
    expect(getAwsCostSummary).not.toHaveBeenCalled();
  });

  it('passes only allow-listed tag values to the Cost Explorer adapter', async () => {
    const response = await GET(request('?environment=prod&component=web'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, max-age=300');
    expect(getAwsCostSummary).toHaveBeenCalledWith({ environment: 'prod', component: 'web' });
  });

  it('uses server-side defaults when filters are omitted', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(getAwsCostSummary).toHaveBeenCalledWith({ environment: undefined, component: undefined });
  });
});
