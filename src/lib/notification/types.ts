/**
 * 通知ルート設定型の app 側エントリ (#275)。
 *
 * 定義は src/domain/notification/call-route.ts に単一化した。本ファイルは
 * 既存 import パス（components / app routes）を保つ再輸出のみ（参照同一性は
 * src/domain/notification/schema-consistency.test.ts で担保）。
 */
export * from '@/domain/notification/call-route';
