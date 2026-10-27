/**
 * 端末証明の世代 (#1237)。純関数のみ。
 *
 * 証明は台帳の世代と一致するときだけ PIN 再認可に使える。世代は「エンロールの消費」と
 * 「登録状態（active/revoked）の切替」で上がる —— 再登録・失効のたびに、それ以前に
 * 発行した証明を通らなくするため。
 */
import type { Device, DeviceStatus } from './types';

/** 台帳の現在の世代。`credentialGeneration` を持たない旧レコードは 0。 */
export function credentialGenerationOf(device: Pick<Device, 'credentialGeneration'>): number {
  return device.credentialGeneration ?? 0;
}

/** 登録状態を切り替えたあとの世代。状態が変わらないなら据え置く（証明を巻き添えで失効させない）。 */
export function generationAfterStatusChange(
  device: Pick<Device, 'credentialGeneration' | 'status'>,
  nextStatus: DeviceStatus,
): number | undefined {
  if (device.status === nextStatus) return device.credentialGeneration;
  return credentialGenerationOf(device) + 1;
}
