/**
 * アプリ全体で参照する基本設定。
 * 秘匿値 (Vonage secret / 管理 secret) はここに置かず、server-only な
 * 環境変数経由で扱う (issue #4, #6)。
 */
export type AppConfig = {
  readonly name: string;
  /** 受付端末ルートの基底パス */
  readonly kioskBasePath: string;
  /** 管理画面ルートの基底パス */
  readonly adminBasePath: string;
};

export const appConfig: AppConfig = {
  name: 'open-reception',
  kioskBasePath: '/kiosk',
  adminBasePath: '/admin',
};
