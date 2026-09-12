'use client';

/**
 * Reception screen router for the No Typing migration (#1057).
 *
 * The existing screen implementation is preserved byte-for-byte in
 * `reception-screens-legacy.tsx`. Only the selectingTarget turn is routed to
 * `NoTypingTargetView`; every other ReceptionState delegates to the existing
 * renderer. This keeps the runtime change intentionally narrow while #1057 is
 * migrated incrementally.
 */
import { NoTypingTargetView } from './NoTypingTargetView';
import { renderScreen as renderLegacyScreen } from './reception-screens-legacy';

// Preserve the public surface used by KioskFlow, CheckinFlow and focused tests.
export * from './reception-screens-legacy';

type ReceptionScreenProps = Parameters<typeof renderLegacyScreen>[0];

export function renderScreen(props: ReceptionScreenProps) {
  if (props.data.state !== 'selectingTarget') {
    return renderLegacyScreen(props);
  }

  return (
    <NoTypingTargetView
      directory={props.directory}
      sttEnabled={props.sttEnabled}
      sttAdapterFactory={props.sttAdapterFactory}
      onSelect={(target) => props.dispatch({ type: 'SELECT_TARGET', target })}
      onVoiceUse={props.onVoiceUse}
      onSearchResult={props.onSearchQuery}
      tab={props.targetTab}
      onTabChange={props.onTargetTabChange}
      openGroupId={props.openStaffGroupId}
      onOpenGroupChange={props.onOpenStaffGroupChange}
      locale={props.locale}
    />
  );
}
