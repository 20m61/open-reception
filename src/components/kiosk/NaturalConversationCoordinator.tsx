'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type ReactNode,
} from 'react';
import {
  materializationActionsForDraft,
  mergeConversationDraft,
  type ConversationDraft,
} from '@/domain/reception/conversation-draft';
import type { CommittedVoiceUtterance } from '@/lib/voice-session/kiosk-binding';
import {
  coalescedExplicitAction,
  resolveNaturalConversationTurn,
  seedConversationDraftFromFlowData,
} from './natural-conversation-runtime';
import {
  createHeuristicReceptionUtteranceExtractor,
  looksLikeMultiSlotReceptionUtterance,
} from './heuristic-reception-extractor';
import { subscribeCommittedUtterance } from './natural-conversation-bus';
import { kioskDirectoryToEntityDirectory } from './voice-directory';
import { reducer, type Action, type FlowData } from './flow-state';
import type { Directory } from './useEffectiveConfiguration';

const NATURAL_CONVERSATION_STATES = new Set<FlowData['state']>([
  'selectingPurpose',
  'selectingTarget',
  'inputVisitorInfo',
]);

type ConversationRuntimeSession = {
  draft: ConversationDraft;
  sequence: number;
};

/**
 * `renderScreen` は `screen-anim key={data.state}` の中で再マウントされる。
 * draftをcomponent-local stateに置くと state 遷移のたびに文脈が消えるため、KioskFlowの
 * useReducer `dispatch`（受付フローの寿命中は安定参照）をキーにする。
 *
 * WeakMapなのでKioskFlow自体が破棄されればGC可能。idleへ戻る時点でも明示的にPIIを消す。
 * 列挙APIを持たず、別kiosk instanceのdraftを参照できない。
 */
const runtimeSessions = new WeakMap<Dispatch<Action>, ConversationRuntimeSession>();

function runtimeSessionFor(dispatch: Dispatch<Action>): ConversationRuntimeSession {
  const current = runtimeSessions.get(dispatch);
  if (current) return current;
  const created: ConversationRuntimeSession = { draft: {}, sequence: 0 };
  runtimeSessions.set(dispatch, created);
  return created;
}

function shouldClaimUtterance(
  data: FlowData,
  utterance: CommittedVoiceUtterance,
): boolean {
  if (!NATURAL_CONVERSATION_STATES.has(data.state)) return false;

  if (data.state === 'inputVisitorInfo') return utterance.text.trim() !== '';

  if (data.state === 'selectingTarget') {
    // targetだけなら既存の候補/readback UIの方が完成しているので、そちらへ残す。
    return looksLikeMultiSlotReceptionUtterance(utterance.text);
  }

  // purpose画面ではtarget-only legacy dispatchは不正遷移になる。先に話された情報をdraftへ保持する。
  return utterance.text.trim() !== '';
}

export function NaturalConversationCoordinator({
  data,
  dispatch,
  directory,
  sttEnabled,
  children,
}: {
  data: FlowData;
  dispatch: Dispatch<Action>;
  directory: Directory;
  sttEnabled: boolean;
  children: (dispatch: Dispatch<Action>) => ReactNode;
}) {
  const session = runtimeSessionFor(dispatch);

  const dataRef = useRef(data);
  dataRef.current = data;

  const directoryRef = useRef(directory);
  directoryRef.current = directory;

  const mountedRef = useRef(true);

  const extractor = useMemo(
    () => createHeuristicReceptionUtteranceExtractor(directory),
    [directory],
  );
  const extractorRef = useRef(extractor);
  extractorRef.current = extractor;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // このscreen instanceで走っていた解析を無効化する。draft自体は次stateへ引き継ぐ。
      session.sequence += 1;
    };
  }, [session]);

  // 新しい来訪者へPII draftを持ち越さない。自動RESETもここで拾える。
  useEffect(() => {
    if (data.state !== 'idle') return;
    session.draft = {};
    session.sequence += 1;
  }, [data.state, session]);

  const conversationDispatch = useCallback<Dispatch<Action>>(
    (action) => {
      const current = dataRef.current;
      const planned = coalescedExplicitAction(current, session.draft, action);
      session.draft = planned.draft;

      // async発話が待っている間に明示操作されたら、古い発話結果を後から被せない。
      session.sequence += 1;
      dataRef.current = reducer(current, planned.action);
      dispatch(planned.action);
    },
    [dispatch, session],
  );

  useEffect(() => {
    return subscribeCommittedUtterance((utterance) => {
      const current = dataRef.current;
      if (!sttEnabled || !shouldClaimUtterance(current, utterance)) return false;

      const sequence = ++session.sequence;
      const baseDraft = seedConversationDraftFromFlowData(session.draft, current);
      // busは同期でclaimだけ返し、解析は非同期。bus自身はutteranceを保存しない。
      void resolveNaturalConversationTurn({
        data: current,
        draft: baseDraft,
        utterance,
        extractor: extractorRef.current,
        directory: kioskDirectoryToEntityDirectory(directoryRef.current),
        voiceAvailable: true,
        assistanceAvailable: false,
      })
        .then((result) => {
          if (!mountedRef.current || sequence !== session.sequence) return;

          // 解析中にタッチ確定された値があれば confirmed を優先し、voice/highで上書きしない。
          const latestData = dataRef.current;
          const latestDraft = seedConversationDraftFromFlowData(session.draft, latestData);
          const merged = mergeConversationDraft(latestDraft, result.draft);
          session.draft = merged;

          // stale snapshotのactionsではなく、現在のstateから正規イベントを再計画する。
          const actions = materializationActionsForDraft(latestData.state, merged);
          if (actions.length === 0) return;

          const batch: Action = { type: 'APPLY_CONVERSATION', actions };
          dataRef.current = reducer(latestData, batch);
          dispatch(batch);
        })
        .catch(() => {
          // 解析失敗で受付全体を落とさない。PII/transcriptをconsoleへ出さない。
        });

      return true;
    });
  }, [dispatch, session, sttEnabled]);

  return <>{children(conversationDispatch)}</>;
}

/** テスト専用: dispatchに紐づくdraftの存在値ではなく、外から注入したstateだけを消す。 */
export function clearNaturalConversationSessionForTest(dispatch: Dispatch<Action>): void {
  runtimeSessions.delete(dispatch);
}
