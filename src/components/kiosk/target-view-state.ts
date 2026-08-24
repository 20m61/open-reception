/**
 * 相手選択画面の表示分岐 (#776)。
 *
 * ここが持つのは **画面ローカルの表示モードだけ**。ReceptionState / Directory / 検索
 * スコアリング / fuzzy 仕様には触らない（#776 非目標）。ドメインの真実源を増やさない。
 *
 * 分岐をコンポーネントから出した理由は、この画面が SSR 越しのテストしか持てない
 * （vitest の environment は node）ため。コンポーネント越しでは「タブを切り替えたら
 * 何が消えるか」を直接縛れず、分岐を壊す変異が素通りする。
 */
import type { MessageKey } from '@/lib/i18n';

/** 「誰を呼ぶか」の探し方。ドメイン状態ではなく view-local な表示モード。 */
export type TargetTab = 'staff' | 'department';

/** タブの提示順。先頭が初期タブ。 */
export const TARGET_TABS: readonly TargetTab[] = ['staff', 'department'];

export const DEFAULT_TARGET_TAB: TargetTab = TARGET_TABS[0]!;

/** 0 件 recovery が出す次の一手。配列の順序がそのまま提示の優先順位。 */
export type TargetRecoveryAction = 'department' | 'chat';

/**
 * 画面本体に出すもの。**同時に 2 つ出せない**ことを型で表す（0 件警告と 0 件案内を
 * 重ねて出していた退行を、条件式ではなく構造で防ぐ）。
 */
export type TargetPanel =
  | { readonly kind: 'staff-results' }
  | {
      readonly kind: 'staff-recovery';
      readonly messageKey: MessageKey;
      readonly actions: readonly TargetRecoveryAction[];
    }
  | { readonly kind: 'departments' };

export function targetPanelFor(input: {
  readonly tab: TargetTab;
  readonly staffResultCount: number;
  /** 検索欄に入力が有るか。0 件の意味（該当なし / 名簿が空）が変わる。 */
  readonly searching: boolean;
  /** チャット相談を提示できるか（`onRequestChat` が注入されているか）。 */
  readonly chatAvailable: boolean;
}): TargetPanel {
  // 部署タブは担当者側の 0 件判定より先。部署を選びに来た来訪者に
  // 「担当者が見つかりません」と言わない。
  if (input.tab === 'department') return { kind: 'departments' };
  if (input.staffResultCount > 0) return { kind: 'staff-results' };
  return {
    kind: 'staff-recovery',
    messageKey: recoveryMessageKeyFor(input.searching, input.chatAvailable),
    actions: input.chatAvailable ? ['department', 'chat'] : ['department'],
  };
}

function recoveryMessageKeyFor(searching: boolean, chatAvailable: boolean): MessageKey {
  // 「チャットで受付係に相談できます」と書いた案内は、チャットを出せない構成では
  // 果たせない約束になる。名簿が空のときも「別の名前で」は助けにならない。
  if (searching && chatAvailable) return 'reception.searchNoResultsGuidance';
  return 'reception.staffNotFound';
}
