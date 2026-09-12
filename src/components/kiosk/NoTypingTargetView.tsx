'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { htmlLangFor, makeT, type Locale } from '@/lib/i18n';
import { screenTitleFor } from './conversation-turn';
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
 * #1057: 来訪者に文字入力を要求しない担当者/部署選択。
 *
 * 入力は次だけに限定する。
 * - 部署/担当者カードのタップ
 * - 音声認識 -> 実在する担当者候補（最大4件） -> 明示タップ確定
 *
 * STT の transcript は担当者として自動確定しない。`voiceTargetCandidatesFor` で
 * directory 上の在席担当者へ解決し、来訪者が候補カードを押した時だけ `onSelect` する。
 * `<input>` / `<textarea>` / contenteditable は描画しない。
 *
 * #776 / #787 の品質契約も維持する。
 * - 担当者/部署は同時に並べずタブで切替
 * - 担当者は部署群 -> 担当者の段階開示
 * - 群を開閉した時にフォーカスを追従
 * - 不在者は非ボタン + バッジ/文言で表現
 * - live region を変化前から常設
 */
export function NoTypingTargetView({
  directory,
  sttEnabled,
  sttAdapterFactory,
  onSelect,
  onVoiceUse,
  onSearchResult,
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
  /** 音声候補が採用されたことをメトリクスへ通知する。 */
  onVoiceUse?: () => void;
  /** 音声検索のヒット有無だけを通知する。transcript は渡さない。 */
  onSearchResult?: (hasHit: boolean) => void;
  /**
   * STT 不能/解決不能時の有人支援。状態機械との接続は呼び出し側が所有する。
   * 未注入なら CTA は出さず、タッチ経路/再発話だけを残す。
   */
  onRequestAssistance?: () => void;
  tab: TargetTab;
  onTabChange: (next: TargetTab) => void;
  openGroupId: string | null;
  onOpenGroupChange: (next: string | null) => void;
  locale: Locale;
}) {
  const tr = makeT(locale);
  const title = screenTitleFor('selectingTarget', locale);
  const [sttListening, setSttListening] = useState(false);
  const [sttTranscripts, setSttTranscripts] = useState<string[]>([]);
  const [voiceAttempted, setVoiceAttempted] = useState(false);
  const [voiceFailed, setVoiceFailed] = useState(false);
  const [groupAnnouncement, setGroupAnnouncement] = useState('');

  const tabRefs = useRef<Partial<Record<TargetTab, HTMLButtonElement | null>>>({});
  const groupRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const firstStaffRef = useRef<HTMLButtonElement | HTMLDivElement | null>(null);
  const groupBackRef = useRef<HTMLButtonElement | null>(null);
  const pendingFocus = useRef<'staff' | string | null>(null);

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
    (openGroupId === null
      ? null
      : (staffGroups.find((group) => group.id === openGroupId) ?? null));
  const firstSelectableIndex = openGroup?.staff.findIndex((staff) => staff.available) ?? -1;

  const switchTab = useCallback(
    (next: TargetTab) => {
      onTabChange(next);
      tabRefs.current[next]?.focus();
    },
    [onTabChange],
  );

  const changeOpenGroup = useCallback(
    (next: string | null) => {
      onOpenGroupChange(next);
      pendingFocus.current = next === null ? (openGroupId ?? null) : 'staff';
    },
    [onOpenGroupChange, openGroupId],
  );

  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    if (target === 'staff') {
      (firstStaffRef.current ?? groupBackRef.current)?.focus();
      return;
    }
    groupRefs.current[target]?.focus();
  }, [openGroupId]);

  const resetVoiceAttempt = useCallback(() => {
    setSttTranscripts([]);
    setVoiceAttempted(false);
    setVoiceFailed(false);
  }, []);

  const listen = useCallback(async () => {
    if (sttListening) return;
    setSttListening(true);
    setVoiceAttempted(false);
    setVoiceFailed(false);
    setSttTranscripts([]);
    try {
      const phrases = directory.staff
        .filter((staff) => staff.available)
        .map((staff) => staff.kana ?? staff.displayName);
      const factory = sttAdapterFactory ?? defaultSttAdapterFactory;
      const transcripts = await factory(phrases).listen();
      const candidates = voiceTargetCandidatesFor(directory, transcripts);
      setSttTranscripts(transcripts);
      setVoiceAttempted(true);
      onSearchResult?.(candidates.length > 0);
    } catch {
      // provider unavailable / permission denied / recognition failure を UI 内で回復する。
      // software keyboard にはフォールバックしない。
      setVoiceFailed(true);
      setVoiceAttempted(true);
      onSearchResult?.(false);
    } finally {
      setSttListening(false);
    }
  }, [directory, onSearchResult, sttAdapterFactory, sttListening]);

  const voiceAnnouncement =
    voiceAttempted && (voiceFailed || voiceCandidates.length === 0)
      ? tr('reception.staffNotFound')
      : voiceAttempted && voiceCandidates.length > 0
        ? tr('reception.voiceHint')
        : '';

  const renderStaffCard = (
    staff: Directory['staff'][number],
    index: number,
  ) => {
    const isFocusTarget = index === firstSelectableIndex;
    if (staff.available) {
      return (
        <button
          key={staff.id}
          type="button"
          className="card"
          data-testid={`staff-${staff.id}`}
          ref={(element) => {
            if (isFocusTarget) firstStaffRef.current = element;
          }}
          onClick={() => onSelect(staffTargetFor(staff, directory.departments, tr))}
        >
          {staff.displayName}
          <span className="card__sub" data-testid={`staff-${staff.id}-affiliation`}>
            {staffAffiliationText(staff, directory.departments, tr)}
          </span>
        </button>
      );
    }
    return (
      <div
        key={staff.id}
        className="card card--unavailable"
        data-testid={`staff-${staff.id}`}
        data-unavailable="true"
        aria-disabled="true"
      >
        <span
          className="card__badge card__badge--unavailable"
          data-testid={`staff-${staff.id}-absent-badge`}
          lang={htmlLangFor(locale)}
        >
          {tr('reception.staffAbsentBadge')}
        </span>
        {staff.displayName}
        <span
          className="card__sub"
          data-testid={`staff-${staff.id}-absent`}
          lang={htmlLangFor(locale)}
        >
          {tr('reception.staffAbsent')}
        </span>
      </div>
    );
  };

  const recovery = (
    <div className="notice notice--warning" data-testid="target-recovery" lang={htmlLangFor(locale)}>
      <p style={{ margin: 0 }}>{tr('reception.staffNotFound')}</p>
      <div className="card-grid" style={{ marginTop: 'var(--space-md)' }}>
        {sttEnabled ? (
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="stt-retry"
            onClick={() => void listen()}
            disabled={sttListening}
          >
            {sttListening ? tr('reception.listening') : tr('reception.voiceSearch')}
          </button>
        ) : null}
        {directory.departments.length > 0 ? (
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="target-recovery-department-cta"
            onClick={() => switchTab('department')}
          >
            {tr('reception.byDepartment')}
          </button>
        ) : null}
        {onRequestAssistance ? (
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="target-recovery-assistance-cta"
            onClick={onRequestAssistance}
          >
            {tr('reception.toDesk')}
          </button>
        ) : null}
      </div>
    </div>
  );

  return (
    <>
      {title ? (
        <h1 className="screen__title" lang={htmlLangFor(locale)}>
          {title}
        </h1>
      ) : null}
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
              id={`target-tab-${id}`}
              ref={(element) => {
                tabRefs.current[id] = element;
              }}
              className="target-tabs__tab"
              data-testid={`target-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={tab === id ? `target-panel-${id}` : undefined}
              tabIndex={tab === id ? 0 : -1}
              onClick={() => {
                resetVoiceAttempt();
                switchTab(id);
              }}
              lang={htmlLangFor(locale)}
            >
              {tr(id === 'staff' ? 'reception.byStaff' : 'reception.byDepartment')}
            </button>
          ))}
        </div>

        {/* 変化前から存在する live region。後付け role では読み上げられない (#776)。 */}
        <p className="a11y-live" role="status" data-testid="target-live" lang={htmlLangFor(locale)}>
          {voiceAnnouncement || groupAnnouncement}
        </p>

        <div
          role="tabpanel"
          id={`target-panel-${tab}`}
          aria-labelledby={`target-tab-${tab}`}
          data-testid={`target-panel-${tab}`}
        >
          {tab === 'staff' ? (
            <>
              {sttEnabled ? (
                <div className="field" data-testid="stt-panel">
                  <div className="target-search__voice">
                    <button
                      type="button"
                      className="btn btn--primary"
                      data-testid="stt-listen"
                      onClick={() => void listen()}
                      disabled={sttListening}
                      aria-busy={sttListening}
                      lang={htmlLangFor(locale)}
                    >
                      {sttListening ? tr('reception.listening') : tr('reception.voiceSearch')}
                    </button>
                  </div>
                </div>
              ) : null}

              {voiceAttempted ? (
                voiceFailed || voiceCandidates.length === 0 ? (
                  recovery
                ) : (
                  <div className="field" data-testid="stt-candidates">
                    <p className="card__sub" data-testid="stt-hint" lang={htmlLangFor(locale)}>
                      {tr('reception.voiceHint')}
                    </p>
                    <div className="card-grid">
                      {voiceCandidates.map(({ staff, tier }, index) => (
                        <button
                          key={staff.id}
                          type="button"
                          className="card"
                          data-testid={`stt-candidate-${index}`}
                          data-staff-id={staff.id}
                          data-match-tier={tier}
                          onClick={() => {
                            onVoiceUse?.();
                            onSelect(staffTargetFor(staff, directory.departments, tr));
                          }}
                        >
                          {tier === 'fuzzy' ? (
                            <span className="card__badge" lang={htmlLangFor(locale)}>
                              {tr('reception.searchMaybeMatch')}
                            </span>
                          ) : null}
                          {staff.displayName}
                          <span className="card__sub">
                            {staffAffiliationText(staff, directory.departments, tr)}
                          </span>
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="btn btn--secondary"
                      data-testid="stt-retry"
                      onClick={() => void listen()}
                      disabled={sttListening}
                      style={{ marginTop: 'var(--space-sm)' }}
                    >
                      {sttListening ? tr('reception.listening') : tr('reception.voiceSearch')}
                    </button>
                  </div>
                )
              ) : staffGroups.length === 0 ? (
                recovery
              ) : openGroup === null ? (
                <div className="card-grid" data-testid="staff-groups">
                  {staffGroups.map((group) => {
                    const selectable = group.staff.filter((staff) => staff.available).length;
                    return (
                      <button
                        key={group.id}
                        type="button"
                        className="card"
                        data-testid={`staff-group-${group.id}`}
                        data-selectable={selectable}
                        ref={(element) => {
                          groupRefs.current[group.id] = element;
                        }}
                        onClick={() => {
                          changeOpenGroup(group.id);
                          setGroupAnnouncement(
                            tr('reception.staffGroupOpened', {
                              name: group.name ?? tr('reception.staffGroupOther'),
                              count: String(selectable),
                            }),
                          );
                        }}
                      >
                        {selectable === 0 ? (
                          <span
                            className="card__badge card__badge--unavailable"
                            data-testid={`staff-group-${group.id}-absent-badge`}
                            lang={htmlLangFor(locale)}
                          >
                            {tr('reception.staffAbsentBadge')}
                          </span>
                        ) : null}
                        {tr('reception.staffGroupLabel', {
                          name: group.name ?? tr('reception.staffGroupOther'),
                        })}
                        <span className="card__sub" data-testid={`staff-group-${group.id}-count`}>
                          {tr('reception.staffGroupCount', { count: String(selectable) })}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="card-grid" data-testid="staff-list">
                  {soleGroup === null ? (
                    <button
                      type="button"
                      className="card card--ghost"
                      data-testid="staff-group-back"
                      ref={groupBackRef}
                      aria-label={`${openGroup.name ?? tr('reception.staffGroupOther')} / ${tr('reception.staffGroupBack')}`}
                      onClick={() => {
                        changeOpenGroup(null);
                        setGroupAnnouncement('');
                      }}
                    >
                      {tr('reception.staffGroupBack')}
                    </button>
                  ) : null}
                  {openGroup.staff.map((staff, index) => renderStaffCard(staff, index))}
                </div>
              )}
            </>
          ) : directory.departments.length > 0 ? (
            <div className="card-grid" data-testid="departments">
              {directory.departments.map((department) => (
                <button
                  key={department.id}
                  type="button"
                  className="card"
                  data-testid={`dept-${department.id}`}
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
          ) : (
            recovery
          )}
        </div>
      </div>
    </>
  );
}
