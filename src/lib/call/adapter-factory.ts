/**
 * 呼び出し adapter の選択 (issue #4, #20)。
 * 既定は MockCallAdapter。Vonage が明示的に有効化され設定済みのときのみ本番 adapter を使う。
 */
import type { CallAdapter } from '@/adapters/call/types';
import type { Staff } from '@/domain/staff/types';
import { MockCallAdapter } from '@/adapters/call/mock';
import { VonageCallAdapter } from '@/adapters/call/vonage';
import { getVonageConfig, isVonageEnabled } from './vonage-config';

export function getCallAdapter(staff: ReadonlyArray<Staff>): CallAdapter {
  if (isVonageEnabled()) {
    const config = getVonageConfig();
    if (config) return new VonageCallAdapter(config);
  }
  return new MockCallAdapter(staff);
}
