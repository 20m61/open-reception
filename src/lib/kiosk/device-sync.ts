/**
 * kiosk → Device の逆方向同期ヘルパ (issue #284 inc1)。
 *
 * /admin/kiosks の作成・setEnabled（失効/再有効化）成功時に Device レジストリへ即時写像する。
 * #283 までは「次の heartbeat 到達時の adoptKiosk」でのみ収束していた片方向を、管理操作起点で
 * 補完する（read 時 union があるため表示は従来から正しいが、Device 単体の状態も即時に揃える）。
 *
 * best-effort: Device 側の失敗で kiosk 管理操作（本体は kiosk レジストリ更新 + 監査済み）を
 * 壊さない。失敗しても read 時 union が表示を担保し、作成分は次の heartbeat の adoptKiosk が
 * 収束させる。呼び出し側は認可済み（requireActor + assertCanWrite）の管理ルートに限る。
 */
import type { Kiosk } from '@/domain/kiosk/types';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';
import { getDeviceService } from '@/lib/tenant/store';

export async function syncKioskToDevice(kiosk: Kiosk): Promise<void> {
  try {
    await getDeviceService().syncKioskState(
      {
        id: kiosk.id,
        displayName: kiosk.displayName,
        ...(kiosk.location !== undefined ? { location: kiosk.location } : {}),
        enabled: kiosk.enabled,
      },
      // kiosk レジストリはテナントレスのため既定スコープへ帰属（#283 と同じ既知の制約）。
      resolveDefaultScope(),
    );
  } catch {
    // Device 統合は補助的な写像。失敗しても kiosk 管理操作は成功のまま返す。
  }
}
