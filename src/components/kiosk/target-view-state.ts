/**
 * 相手選択画面の表示分岐 (#776)。
 *
 * ここが持つのは **画面ローカルの表示モードだけ**。ReceptionState / Directory / 検索
 * スコアリングの契約には触らない（#776 非目標）。ドメインの真実源を増やさない。
 *
 * 分岐をコンポーネントから出した理由は、この画面が SSR 越しのテストしか持てない
 * （vitest の environment は node で、jsdom は依存に無い）ため。コンポーネント越しでは
 * 「タブを切り替えたら何が消えるか」を直接縛れず、分岐を壊す変異が素通りする。
 */
import type { MessageKey } from '@/lib/i18n';

/** 「誰を呼ぶか」の探し方。ドメイン状態ではなく view-local な表示モード。 */
export type TargetTab = 'staff' | 'department';

/** タブの提示順。先頭が既定タブ。 */
export const TARGET_TABS: readonly TargetTab[] = ['staff', 'department'];

export const DEFAULT_TARGET_TAB: TargetTab = TARGET_TABS[0]!;

/**
 * 待機画面の入口カード「部署から選ぶ」の id（`ui-contract.ts` の `IDLE_ENTRY_ANSWERS`）。
 * この入口で入った来訪者を担当者タブへ着地させると、押した導線と着いた画面が食い違う。
 * id が改名されたら `target-view-state.test.ts` が契約と突き合わせて落ちる。
 */
export const DEPARTMENT_ENTRY_ID = 'department';

export function initialTargetTabFor(entryId: string | undefined): TargetTab {
  return entryId === DEPARTMENT_ENTRY_ID ? 'department' : DEFAULT_TARGET_TAB;
}

/**
 * tablist のキーボード操作 (WAI-ARIA APG)。`role="tab"` を名乗る以上、左右キーでの移動は
 * 契約。該当キーでなければ null（呼び出し側は既定動作を妨げない）。
 */
export function nextTabFor(current: TargetTab, key: string): TargetTab | null {
  const at = TARGET_TABS.indexOf(current);
  if (at < 0) return null;
  const last = TARGET_TABS.length - 1;
  switch (key) {
    case 'ArrowRight':
      return TARGET_TABS[at === last ? 0 : at + 1]!;
    case 'ArrowLeft':
      return TARGET_TABS[at === 0 ? last : at - 1]!;
    case 'Home':
      return TARGET_TABS[0]!;
    case 'End':
      return TARGET_TABS[last]!;
    default:
      return null;
  }
}

/** 0 件 recovery が出す次の一手。配列の順序がそのまま提示の優先順位。 */
export type TargetRecoveryAction = 'staff' | 'department' | 'chat';

/**
 * 画面本体に出すもの。**同時に 2 つ出せない**ことを型で表す（0 件警告と 0 件案内を
 * 重ねて出していた退行を、条件式ではなく構造で防ぐ）。
 */
export type TargetPanel =
  | { readonly kind: 'staff-results' }
  | { readonly kind: 'departments' }
  | {
      readonly kind: 'recovery';
      readonly messageKey: MessageKey;
      readonly actions: readonly TargetRecoveryAction[];
    };

type TargetPanelInput = {
  readonly tab: TargetTab;
  /** 現在の検索条件で**カードが出る**担当者の数（不在の担当者も含む）。 */
  readonly staffResultCount: number;
  /**
   * そのうち**実際に呼べる**担当者の数。カードは出るが全員不在ということが有り、
   * 「担当者から選ぶ」を押した先が押せないカードだけになるのを防ぐ。
   */
  readonly selectableStaffCount: number;
  /** 来訪者に出せる部署・窓口の数。取得前・取得失敗・未登録テナントでは 0。 */
  readonly departmentCount: number;
  /** 検索欄に入力が有るか。0 件の意味（該当なし / 名簿が空）が変わる。 */
  readonly searching: boolean;
  /** チャット相談を提示できるか（`onRequestChat` が注入されているか）。 */
  readonly chatAvailable: boolean;
};

export function targetPanelFor(input: TargetPanelInput): TargetPanel {
  // 部署タブは担当者側の 0 件判定より先。部署を選びに来た来訪者に
  // 「担当者が見つかりません」と言わない。
  if (input.tab === 'department' && input.departmentCount > 0) return { kind: 'departments' };
  if (input.tab === 'staff' && input.staffResultCount > 0) return { kind: 'staff-results' };
  const actions = recoveryActionsFor(input);
  return { kind: 'recovery', messageKey: recoveryMessageKeyFor(input, actions), actions };
}

/**
 * 次の一手は「押した先に実際に中身がある」ものだけを出す。空の部署一覧へ送るボタンは、
 * 来訪者から見れば行き止まりへの案内でしかない。
 */
function recoveryActionsFor(input: TargetPanelInput): readonly TargetRecoveryAction[] {
  const actions: TargetRecoveryAction[] = [];
  if (input.tab === 'department') {
    if (input.selectableStaffCount > 0) actions.push('staff');
  } else if (input.departmentCount > 0) {
    actions.push('department');
  }
  if (input.chatAvailable) actions.push('chat');
  return actions;
}

function recoveryMessageKeyFor(
  input: TargetPanelInput,
  actions: readonly TargetRecoveryAction[],
): MessageKey {
  // 次の一手が 1 つも無いなら、画面の中で解決できることは何も無い。
  // 「下からお選びください」と書いて選択肢を出さないより、有人へ振る方が正確。
  if (actions.length === 0) return 'reception.fallbackBody';
  if (input.tab === 'department') return 'reception.departmentNotFound';
  // 名簿が空のときに「別の名前で」は助けにならない。
  if (input.searching) return 'reception.searchNoResultsGuidance';
  // `staffNotFound` は「部署または代表窓口をお選びください」と言う。次の一手から部署を
  // 外したのにこの文言を出すと、消したはずの行き止まりへ言葉で案内することになる。
  return actions.includes('department') ? 'reception.staffNotFound' : 'reception.fallbackBody';
}
