'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { htmlLangFor, makeT, type Locale } from '@/lib/i18n';
import type { Target } from './flow-state';
import type { Directory } from './useEffectiveConfiguration';
import { staffAffiliationText } from './staff-affiliation-text';
import { staffGroupsFor } from './staff-grouping';
import { staffTargetFor } from './staff-target';
import {
  TARGET_TABS,
  nextTabFor,
  type TargetTab,
} from './target-view-state';
import {
  defaultSttAdapterFactory,
  type SttAdapterFactory,
} from './stt-adapter';
import { voiceTargetCandidatesFor } from './voice-target-candidates';

/**
 * #1057 の No Typing 方針を Target 選択だけに閉じて先行実装したビュー。
 *
 * 既存 TargetView の state machine 契約は変えず、来訪者の入力を次だけに限定する。
 * - 部署/担当者カードのタップ
 * - 音声認識 → 2〜4 件の候補カード → 明示タップ確定
 *
 * `<input>` / `<textarea>` / contenteditable は描画しない。
 * STT が使えない場合も software keyboard へ戻さず、部署/担当者カードまたは有人支援へ逃がす。
 *
 * このコンポーネントは #1057 の段階移行用。既存 TargetView と同じ props 語彙をできるだけ保ち、
 * wiring 時に ReceptionState / SELECT_TARGET を変更しなくて済むようにしている。
 */
export function NoTypingTargetView({
  directory,
  sttEnabled,
  sttAdapterFactory,
  onSelect,
  onVoiceUse,
  onRequestAssistance,
  tab,
  onTabChange,
  openGroupId,
  onOpenGroupChange,
  locale,
}: {
  directory: Directory;
  sttEnabled: boolean;
  sttAdapterFactory?: SttAdapterFactory;
  onSelect: (target: Target) => void;
  onVoiceUse?: () => void;
  /** STT が使えない/解決できないときの有人支援。未注入なら CTA 自体を出さない。 */
  onRequestAssistance?: () => void;
  tab: TargetTab;
  onTabChange: (next: TargetTab) => void;
  openGroupId: string | null;
  onOpenGroupChange: (next: string | null) => void;
  locale: Locale;
}) {
  const tr = makeT(locale);
  const [sttListening, setSttListening] = useState(false);
  const [sttTranscripts, setSttTranscripts] = useState<string[]>([]);
  const tabRefs = useRef<Partial<Record<TargetTab, HTMLButtonElement | null>>>({});

  const voiceCandidates = useMemo(
    () => voiceTargetCandidatesFor(directory, sttTranscripts),
    [directory, sttTranscripts],
  );
  const staffGroups = useMemo(
    () => staffGroupsFor(directory.staff, directory.departments),
    [directory.staff, directory.departments],
  );
  const soleGroup = staffGroups.length === 1 ? (staffGroups[0] ?? null) : null;
  const openGroup =
    soleGroup ??
    (openGroupId === null ? null : (staffGroups.find((group) => group.id === openGroupId) ?? null));

  const switchTab = useCallback(
    (next: TargetTab) => {
      onTabChange(next);
      tabRefs.current[next]?.focus();
    },
    [onTabChange],
  );

  const listen = useCallback(async () => {
    if (sttListening) return;
    setSttListening(true);
    setSttTranscripts([]);
    try {
      const phrases = directory.staff
        .filter((staff) => staff.available)
        .map((staff) => staff.kana ?? staff.displayName);
      const factory = sttAdapterFactory ?? defaultSttAdapterFactory;
      const transcripts = await factory(phrases).listen();
      setSttTranscripts(transcripts);
    } finally {
      setSttListening(false);
    }
  }, [directory.staff, sttAdapterFactory, sttListening]);

  const renderStaffCard = (staff: Directory['staff'][number], testIdPrefix = 'staff') =>
    staff.available ? (
      <button
        key={staff.id}
        type="button"
        className="card"
        data-testid={`${testIdPrefix}-${staff.id}`}
        onClick={() => onSelect(staffTargetFor(staff, directory.departments, tr))}
      >
        {staff.displayName}
        <span className="card__sub">
          {staffAffiliationText(staff, directory.departments, tr)}
        </span>
      </button>
    ) : (
      <div
        key={staff.id}
        className="card card--unavailable"
        data-testid={`${testIdPrefix}-${staff.id}`}
        data-unavailable="true"
        aria-disabled="true"
      >
        <span className="card__badge card__badge--unavailable" lang={htmlLangFor(locale)}>
          {tr('reception.staffAbsentBadge')}
        </span>
        {staff.displayName}
        <span className="card__sub" lang={htmlLangFor(locale)}>
          {tr('reception.staffAbsent')}
        </span>
      </div>
    );

  return (
    <>
      <h1 className="screen__title" lang={htmlLangFor(locale)}>
        {tr('reception.targetPrompt')}
      </h1>
      <div className="screen__body" data-testid="no-typing-target-view">
        <div
          className="target-tabs"
          role="tablist"
          aria-label={tr('reception.targetTabsLabel')}
          onKeyDown={(event) => {
            const next = nextTabFor(tab, event.key);
            if (next === null) return;
            event.preventDefault();
            switchTab(next);
          }}
        >
          {TARGET_TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`no-typing-target-tab-${id}`}
              ref={(element) => {
                tabRefs.current[id] = element;
              }}
              className="target-tabs__tab"
              data-testid={`no-typing-target-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={tab === id ? `no-typing-target-panel-${id}` : undefined}
              tabIndex={tab === id ? 0 : -1}
              onClick={() => switchTab(id)}
              lang={htmlLangFor(locale)}
            >
              {tr(id === 'staff' ? 'reception.byStaff' : 'reception.byDepartment')}
            </button>
          ))}
        </div>

        <div
          role="tabpanel"
          id={`no-typing-target-panel-${tab}`}
          aria-labelledby={`no-typing-target-tab-${tab}`}
          data-testid={`no-typing-target-panel-${tab}`}
        >
          {tab === 'staff' ? (
            <div className="field">
              {sttEnabled ? (
                <div className="target-search__voice" data-testid="no-typing-stt-panel">
                  <button
                    type="button"
                    className="btn btn--primary"
                    data-testid="no-typing-stt-listen"
                    onClick={() => void listen()}
                    disabled={sttListening}
                    aria-busy={sttListening}
                    lang={htmlLangFor(locale)}
                  >
                    {sttListening ? tr('reception.listening') : tr('reception.voiceSearch')}
                  </button>
                </div>
              ) : onRequestAssistance ? (
                <div className="notice notice--warning" data-testid="no-typing-stt-unavailable">
                  <button
                    type="button"
                    className="btn btn--secondary"
                    data-testid="no-typing-assistance"
                    onClick={onRequestAssistance}
                    lang={htmlLangFor(locale)}
                  >
                    {tr('reception.toDesk')}
                  </button>
                </div>
              ) : null}

              {sttEnabled && sttTranscripts.length > 0 ? (
                voiceCandidates.length > 0 ? (
                  <div className="field" data-testid="no-typing-voice-candidates">
                    <p className="card__sub" lang={htmlLangFor(locale)}>
                      {tr('reception.voiceHint')}
                    </p>
                    <div className="card-grid">
                      {voiceCandidates.map(({ staff, tier }) => (
                        <button
                          key={staff.id}
                          type="button"
                          className="card"
                          data-testid={`no-typing-voice-candidate-${staff.id}`}
                          data-match-tier={tier}
                          onClick={() => {
                            onVoiceUse?.();
                            onSelect(staffTargetFor(staff, directory.departments, tr));
                          }}
                        >
                          {staff.displayName}
                          <span className="card__sub">
                            {staffAffiliationText(staff, directory.departments, tr)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div
                    className="notice notice--warning"
                    data-testid="no-typing-voice-no-match"
                    lang={htmlLangFor(locale)}
                  >
                    <p>{tr('reception.staffNotFound')}</p>
                    <div className="card-grid">
                      <button
                        type="button"
                        className="btn btn--secondary"
                        data-testid="no-typing-stt-retry"
                        onClick={() => void listen()}
                      >
                        {tr('reception.voiceSearch')}
                      </button>
                      {onRequestAssistance ? (
                        <button
                          type="button"
                          className="btn btn--secondary"
                          data-testid="no-typing-assistance"
                          onClick={onRequestAssistance}
                        >
                          {tr('reception.toDesk')}
                        </button>
                      ) : null}
                    </div>
                  </div>
                )
              ) : openGroup === null ? (
                <div className="card-grid" data-testid="no-typing-staff-groups">
                  {staffGroups.map((group) => {
                    const selectable = group.staff.filter((staff) => staff.available).length;
                    return (
                      <button
                        key={group.id}
                        type="button"
                        className="card"
                        data-testid={`no-typing-staff-group-${group.id}`}
                        onClick={() => onOpenGroupChange(group.id)}
                      >
                        {tr('reception.staffGroupLabel', {
                          name: group.name ?? tr('reception.staffGroupOther'),
                        })}
                        <span className="card__sub">
                          {tr('reception.staffGroupCount', { count: String(selectable) })}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="card-grid" data-testid="no-typing-staff-list">
                  {soleGroup === null ? (
                    <button
                      type="button"
                      className="card card--ghost"
                      data-testid="no-typing-staff-group-back"
                      onClick={() => onOpenGroupChange(null)}
                    >
                      {tr('reception.staffGroupBack')}
                    </button>
                  ) : null}
                  {openGroup.staff.map((staff) => renderStaffCard(staff, 'no-typing-staff'))}
                </div>
              )}
            </div>
          ) : (
            <div className="card-grid" data-testid="no-typing-departments">
              {directory.departments.map((department) => (
                <button
                  key={department.id}
                  type="button"
                  className="card"
                  data-testid={`no-typing-dept-${department.id}`}
                  onClick={() =>
                    onSelect({
                      type: 'department',
                      id: department.id,
                      label: department.name,
                    })
                  }
                >
                  {department.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
