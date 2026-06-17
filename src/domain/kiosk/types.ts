/**
 * 受付端末（kiosk）のドメイン型 (issue #18)。
 * 端末を識別し、設置場所・利用可否を管理する。失効した端末は受付を開始できない。
 */
export type Kiosk = {
  id: string;
  displayName: string;
  location?: string;
  /** false の場合は失効（受付停止）。 */
  enabled: boolean;
};

/** 受付端末が取得する最小設定。秘匿情報は含めない。 */
export type KioskConfig = {
  kioskId: string;
  displayName?: string;
  /** 受付を開始できるか（端末が有効か）。 */
  active: boolean;
};
