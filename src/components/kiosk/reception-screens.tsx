'use client';

/**
 * Reception screen router for No Typing + Minimum-Turn Natural Conversation (#1057/#1077).
 *
 * 既存screen実装は `reception-screens-legacy.tsx` に保持したまま、
 * - selectingTargetだけ NoTypingTargetView
 * - 全通常受付screenのdispatch/確定発話だけ NaturalConversationCoordinator
 * を通す。
 *
 * state machineの真実源は変えない。Coordinatorは既存actionを必要に応じて
 * `APPLY_CONVERSATION` へ束ね、中間stateを来訪者へ描画しないだけ。
 */
import { NoTypingTargetView } from './NoTypingTargetView';
import { NaturalConversationCoordinator } from './NaturalConversationCoordinator';
import { renderScreen as renderLegacyScreen } from './reception-screens-legacy';

// Preserve the public surface used by KioskFlow, CheckinFlow and focused tests.
export * from './reception-screens-legacy';

type ReceptionScreenProps = Parameters<typeof renderLegacyScreen>[0];

function RoutedReceptionScreen(props: ReceptionScreenProps) {
  return (
    <NaturalConversationCoordinator
      data={props.data}
      dispatch={props.dispatch}
      directory={props.directory}
      sttEnabled={props.sttEnabled}
    >
      {(conversationDispatch) => {
        if (props.data.state !== 'selectingTarget') {
          return renderLegacyScreen({ ...props, dispatch: conversationDispatch });
        }

        return (
          <NoTypingTargetView
            directory={props.directory}
            sttEnabled={props.sttEnabled}
            sttAdapterFactory={props.sttAdapterFactory}
            onSelect={(target) => conversationDispatch({ type: 'SELECT_TARGET', target })}
            onVoiceUse={props.onVoiceUse}
            onSearchResult={props.onSearchQuery}
            tab={props.targetTab}
            onTabChange={props.onTargetTabChange}
            openGroupId={props.openStaffGroupId}
            onOpenGroupChange={props.onOpenStaffGroupChange}
            locale={props.locale}
          />
        );
      }}
    </NaturalConversationCoordinator>
  );
}

export function renderScreen(props: ReceptionScreenProps) {
  return <RoutedReceptionScreen {...props} />;
}
