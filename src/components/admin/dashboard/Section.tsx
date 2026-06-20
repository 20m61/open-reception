/**
 * ダッシュボードのセクション見出し + グリッド枠 (issue #86 / #92 increment 2)。
 *
 * #92 increment 2: 重複していた Section / CardGrid を共有 `ui/` プリミティブへ集約し、
 * 本ファイルは互換のための re-export シムにした（dashboard 配下の import パスを維持）。
 */
export { Section, CardGrid } from '@/components/admin/ui';
