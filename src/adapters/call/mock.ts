/**
 * 呼び出しの mock adapter (issue #20)。
 * 本番 Vonage 連携前に、成功・未応答・失敗・タイムアウトを決定的に再現する。
 *
 * 結果は担当者の `mockCallOutcome` から導出し、部署や未設定時は success 扱い。
 * これにより E2E が分岐を安定して検証できる (issue #21)。
 */
import type { MockCallOutcome, Staff } from '@/domain/staff/types';
import type { CallAdapter, CallRequest, CallResult } from './types';

function outcomeToResult(outcome: MockCallOutcome): CallResult {
  switch (outcome) {
    case 'success':
      return { status: 'connected' };
    case 'no_answer':
      return { status: 'timeout', reason: 'no_answer' };
    case 'timeout':
      return { status: 'timeout', reason: 'timeout' };
    case 'failure':
      return { status: 'failed', reason: 'call_failed' };
  }
}

export class MockCallAdapter implements CallAdapter {
  constructor(private readonly staff: ReadonlyArray<Staff>) {}

  async call(request: CallRequest): Promise<CallResult> {
    if (request.targetType === 'staff') {
      const target = this.staff.find((s) => s.id === request.targetId);
      if (!target) {
        return { status: 'failed', reason: 'target_not_found' };
      }
      return outcomeToResult(target.mockCallOutcome ?? 'success');
    }
    // 部署呼び出しは MVP では常に成功とみなす。
    return { status: 'connected' };
  }
}
