'use client';

import type { MotionQaGateId } from '@/domain/motion/qa';

const GATES: readonly { id: MotionQaGateId; label: string; description: string }[] = [
  { id: 'duration', label: '尺', description: '台本で想定した時間内に収まっているか。' },
  { id: 'neutral-start', label: '開始姿勢', description: '開始フレームが基準姿勢から大きく外れていないか。' },
  { id: 'neutral-end', label: '終了姿勢', description: '終了時に次の状態へ自然につながる姿勢へ戻っているか。' },
  { id: 'loop-seam', label: 'ループ継ぎ目', description: 'ループ素材の先頭と末尾に目立つ姿勢差がないか。' },
  { id: 'motion-range', label: '可動域', description: '肩・肘・首などに過剰な関節角度がないか。' },
  { id: 'jerk', label: '急加速', description: 'モーキャプノイズや急激な方向転換が残っていないか。' },
  { id: 'stillness', label: '静止率', description: '受付用途として十分な「動かない時間」があるか。' },
  { id: 'framing', label: '4:3フレーミング', description: 'iPad構図で頭・手先が画面外へ出ないか。' },
  { id: 'gaze-conflict', label: '視線競合', description: 'VRMAが頭・首を占有しすぎてruntime gazeを妨げないか。' },
];

export function MotionLabManager() {
  return (
    <section>
      <h1 style={{ marginTop: 0 }}>Motion Lab</h1>
      <p style={{ opacity: 0.8, maxWidth: 760 }}>
        収録したモーションを「自然に見えるか」だけでなく、受付用途の共通基準で検査・レビューするための品質管理画面です。
        rawモーションは保持したまま、解析・補正・VRMA化・人間レビューを段階的に行います。
      </p>

      <div style={flow} aria-label="Motion Lab workflow">
        {['収録', '自動解析', '補正', 'VRM確認', 'AIレビュー', '人間承認', '標準ライブラリ'].map((label, index) => (
          <span key={label} style={step}>
            {index > 0 ? '→ ' : ''}{label}
          </span>
        ))}
      </div>

      <h2>自動QAゲート</h2>
      <div style={grid} data-testid="motion-lab-gates">
        {GATES.map((gate) => (
          <article key={gate.id} style={card}>
            <strong>{gate.label}</strong>
            <code style={{ display: 'block', opacity: 0.6, marginTop: 4 }}>{gate.id}</code>
            <p style={{ marginBottom: 0, opacity: 0.8 }}>{gate.description}</p>
          </article>
        ))}
      </div>

      <h2>判定ルール</h2>
      <p style={{ opacity: 0.8 }}>
        自動判定は PASS / NEEDS_TUNING / REJECT の候補を出しますが、標準モーションへの採用は人間レビューで確定します。
        次の増分でBVH解析結果とプレビューをこの画面へ接続します。
      </p>
    </section>
  );
}

const flow: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  margin: '20px 0 28px',
};

const step: React.CSSProperties = {
  padding: '8px 10px',
  borderRadius: 8,
  background: 'var(--color-surface)',
  border: '1px solid var(--color-surface-2)',
};

const grid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 12,
};

const card: React.CSSProperties = {
  padding: 16,
  borderRadius: 12,
  border: '1px solid var(--color-surface-2)',
  background: 'var(--color-surface)',
};
