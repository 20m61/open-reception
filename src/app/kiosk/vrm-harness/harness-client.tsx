'use client';

/**
 * ハーネスの操作面（#930 / #932 / #933）。
 *
 * **`VrmAvatarViewer` をマウントしたまま** `vrmUrl` / `motionUrl` を差し替える。
 * 入力を反映するのは「適用」を押したときだけで、打鍵の途中の値を読ませない
 * （1 文字ごとに読込を撃つと、検査が何を見ているのか分からなくなる）。
 */
import { useState } from 'react';
import { VrmAvatarViewer } from '@/components/kiosk/VrmAvatarViewer';

export function VrmHarnessClient() {
  const [vrmDraft, setVrmDraft] = useState('');
  const [motionDraft, setMotionDraft] = useState('');
  const [vrmUrl, setVrmUrl] = useState<string | undefined>(undefined);
  const [motionUrl, setMotionUrl] = useState<string | undefined>(undefined);

  return (
    <main style={{ display: 'grid', gridTemplateRows: 'auto 1fr', height: '100vh', gap: 8, padding: 8 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          data-testid="harness-vrm-url"
          aria-label="vrm url"
          value={vrmDraft}
          onChange={(e) => setVrmDraft(e.target.value)}
        />
        <input
          data-testid="harness-motion-url"
          aria-label="motion url"
          value={motionDraft}
          onChange={(e) => setMotionDraft(e.target.value)}
        />
        <button
          type="button"
          data-testid="harness-apply"
          onClick={() => {
            setVrmUrl(vrmDraft === '' ? undefined : vrmDraft);
            setMotionUrl(motionDraft === '' ? undefined : motionDraft);
          }}
        >
          apply
        </button>
      </div>
      <div data-testid="harness-stage" style={{ minHeight: 0 }}>
        <VrmAvatarViewer vrmUrl={vrmUrl} motionUrl={motionUrl} />
      </div>
    </main>
  );
}
