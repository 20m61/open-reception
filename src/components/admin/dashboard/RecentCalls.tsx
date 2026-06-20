import type { CallOutcome } from '@/domain/reception/session';
import type { RecentCall } from '@/domain/reception/dashboard-summary';

/**
 * 直近の呼び出し履歴 (issue #86, increment 1)。
 * 来訪者の氏名等 PII は含めず、呼び出し対象名・成否・所要時間のみ。
 * 空状態では自然な案内を出す。
 */
const OUTCOME_META: Record<CallOutcome, { label: string; color: string }> = {
  connected: { label: '応答', color: 'var(--color-success)' },
  timeout: { label: '未応答', color: 'var(--color-warning)' },
  failed: { label: '失敗', color: 'var(--color-danger)' },
  cancelled: { label: 'キャンセル', color: 'var(--color-text)' },
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}秒`;
  return `${Math.floor(sec / 60)}分${sec % 60}秒`;
}

export function RecentCalls({ calls }: { calls: readonly RecentCall[] }) {
  if (calls.length === 0) {
    return (
      <p data-testid="recent-calls-empty" style={{ opacity: 0.7, margin: 0 }}>
        まだ受付履歴がありません。
      </p>
    );
  }

  return (
    <table data-testid="recent-calls-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.2)' }}>
          <th style={cell}>時刻</th>
          <th style={cell}>呼び出し先</th>
          <th style={cell}>結果</th>
          <th style={cell}>所要</th>
        </tr>
      </thead>
      <tbody>
        {calls.map((c) => {
          const meta = OUTCOME_META[c.outcome];
          return (
            <tr key={c.id} data-testid="recent-call-row" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <td style={cell}>{formatTime(c.startedAt)}</td>
              <td style={cell}>{c.targetLabel ?? '-'}</td>
              <td style={{ ...cell, color: meta.color }}>
                {meta.label}
                {c.fallbackUsed ? <span style={{ opacity: 0.6, fontSize: '0.8rem' }}>（代替導線）</span> : null}
              </td>
              <td style={cell}>{formatDuration(c.durationMs)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const cell: React.CSSProperties = { padding: '8px 12px' };
