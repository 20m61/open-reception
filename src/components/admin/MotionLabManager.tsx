'use client';

import { useState, type ChangeEvent } from 'react';
import { deriveBvhQaMetrics, parseBvh } from '@/domain/motion/bvh';
import { motionQaProfileFor } from '@/domain/motion/qa-profiles';
import { evaluateMotionQa, type MotionQaGateId, type MotionQaReport } from '@/domain/motion/qa';
import { MOTION_KEYS, type MotionKey } from '@/domain/motion/types';

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

const KEY_LABEL: Record<MotionKey, string> = {
  idle: '待機',
  greeting: '挨拶',
  listening: '傾聴',
  thinking: '確認待ち',
  selecting: '案内',
  calling: '呼び出し中',
  connected: '接続中',
  success: '受付完了',
  failed: 'お詫び',
  timeout: '未応答',
  fallback: '代替導線',
};

export function MotionLabManager() {
  const [motionKey, setMotionKey] = useState<MotionKey>('greeting');
  const [fileName, setFileName] = useState<string>();
  const [report, setReport] = useState<MotionQaReport>();
  const [error, setError] = useState<string>();
  const [summary, setSummary] = useState<{ frames: number; joints: number; durationSec: number }>();

  const analyze = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;

    setError(undefined);
    setReport(undefined);
    setSummary(undefined);
    setFileName(file.name);

    try {
      const source = await file.text();
      const parsed = parseBvh(source);
      const metrics = deriveBvhQaMetrics(parsed);
      const nextReport = evaluateMotionQa(metrics, motionQaProfileFor(motionKey));
      setSummary({
        frames: parsed.frames.length,
        joints: parsed.joints.length,
        durationSec: metrics.durationSec,
      });
      setReport(nextReport);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'BVHを解析できませんでした。');
    }
  };

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>Motion Lab</h1>
      <p style={{ opacity: 0.8, maxWidth: 760 }}>
        収録したモーションを「自然に見えるか」だけでなく、受付用途の共通基準で検査・レビューします。
        現在のBVH解析はブラウザ内だけで実行し、選択したファイルをサーバーへ送信しません。
      </p>

      <div style={flow} aria-label="Motion Lab workflow">
        {['収録', '自動解析', '補正', 'VRM確認', 'AIレビュー', '人間承認', '標準ライブラリ'].map((label, index) => (
          <span key={label} style={step}>{index > 0 ? '→ ' : ''}{label}</span>
        ))}
      </div>

      <section style={panel} aria-labelledby="motion-lab-input-title">
        <h2 id="motion-lab-input-title" style={{ marginTop: 0 }}>BVHを解析</h2>
        <div style={controls}>
          <label>
            <span style={fieldLabel}>想定モーション</span>
            <select
              aria-label="想定モーション"
              value={motionKey}
              onChange={(event) => {
                setMotionKey(event.target.value as MotionKey);
                setReport(undefined);
                setSummary(undefined);
                setFileName(undefined);
              }}
              style={inputStyle}
            >
              {MOTION_KEYS.map((key) => <option key={key} value={key}>{KEY_LABEL[key]} ({key})</option>)}
            </select>
          </label>
          <label>
            <span style={fieldLabel}>収録BVH</span>
            <input
              data-testid="motion-lab-bvh-input"
              type="file"
              accept=".bvh,text/plain"
              onChange={(event) => void analyze(event)}
              style={inputStyle}
            />
          </label>
        </div>
        <p style={{ marginBottom: 0, opacity: 0.7, fontSize: 14 }}>
          rawファイルは変更しません。neutral姿勢と4:3フレーミングは、calibration / VRMレンダリング実装前のため未計測として扱います。
        </p>
      </section>

      {error ? <p role="alert" data-testid="motion-lab-error" style={errorStyle}>{error}</p> : null}

      {report && summary ? (
        <section aria-labelledby="motion-lab-result-title">
          <h2 id="motion-lab-result-title">解析結果</h2>
          <div style={resultHeader}>
            <div><strong>{fileName}</strong><br /><span style={{ opacity: 0.7 }}>{summary.joints} joints / {summary.frames} frames / {summary.durationSec.toFixed(2)}s</span></div>
            <strong data-testid="motion-lab-decision" style={decisionStyle}>{report.automatedDecision.toUpperCase()}</strong>
          </div>
          <div style={grid} data-testid="motion-lab-results">
            {report.gates.map((result) => {
              const gate = GATES.find((candidate) => candidate.id === result.id)!;
              return (
                <article key={result.id} style={card} data-status={result.status}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <strong>{gate.label}</strong>
                    <span>{result.status}</span>
                  </div>
                  <code style={{ display: 'block', opacity: 0.6, marginTop: 4 }}>{result.id}</code>
                  <p style={{ marginBottom: 0, opacity: 0.8 }}>{result.message}</p>
                </article>
              );
            })}
          </div>
        </section>
      ) : (
        <>
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
        </>
      )}

      <h2>判定ルール</h2>
      <p style={{ opacity: 0.8 }}>
        自動判定は PASS / NEEDS_TUNING / REJECT の候補です。標準モーションへの採用は、VRMでの見た目確認と人間レビューで確定します。
      </p>
    </section>
  );
}

const flow: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, margin: '20px 0 28px' };
const step: React.CSSProperties = { padding: '8px 10px', borderRadius: 8, background: 'var(--color-surface)', border: '1px solid var(--color-surface-2)' };
const panel: React.CSSProperties = { padding: 16, borderRadius: 12, border: '1px solid var(--color-surface-2)', background: 'var(--color-surface)', marginBottom: 24 };
const controls: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'end' };
const fieldLabel: React.CSSProperties = { display: 'block', fontWeight: 600, marginBottom: 6 };
const inputStyle: React.CSSProperties = { minHeight: 40, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--color-surface-2)', background: 'var(--color-surface)', color: 'var(--color-text)' };
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 };
const card: React.CSSProperties = { padding: 16, borderRadius: 12, border: '1px solid var(--color-surface-2)', background: 'var(--color-surface)' };
const resultHeader: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 };
const decisionStyle: React.CSSProperties = { padding: '8px 12px', borderRadius: 8, border: '1px solid var(--color-surface-2)' };
const errorStyle: React.CSSProperties = { padding: 12, borderRadius: 8, border: '1px solid currentColor' };
