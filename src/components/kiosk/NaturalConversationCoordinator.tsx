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

function shouldClaimUtterance(
  data: FlowData,
  utterance: CommittedVoiceUtterance,
): boolean {
  if (!NATURAL_CONVERSATION_STATES.has(data.state)) return false;

  // 氏名を聞いている局面は、単語だけの返答（「張」）も自然会話側で扱う。
  if (data.state === 'inputVisitorInfo') return utterance.text.trim() !== '';

  // selectingTargetの単純な「鈴木さん」だけは既存のtarget-only STTに任せる。
  // 用件/自己紹介まで含むときだけmulti-slot側がclaimする。
  if (data.state === 'selectingTarget') {
    return looksLikeMultiSlotReceptionUtterance(utterance.text);
  }

  // purpose画面ではtarget-only legacy dispatchは不正遷移になるため、発話はdraftへ保持する。
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
  const dataRef = useRef(data);
  dataRef.current = data;

  const directoryRef = useRef(directory);
  directoryRef.current = directory;

  const draftRef = useRef<ConversationDraft>({});
  const sequenceRef = useRef(0);
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
      // outstanding async extractionを無効化する。transcript/draftのbus履歴はそもそも無い。
      sequenceRef.current += 1;
    };
  }, []);

  // 新しい来訪者へPII draftを持ち越さない。自動RESETもここで拾える。
  useEffect(() => {
    if (data.state !== 'idle') return;
    draftRef.current = {};
    sequenceRef.current += 1;
  }, [data.state]);

  const conversationDispatch = useCallback<Dispatch<Action>>(
    (action) => {
      const current = dataRef.current;
      const planned = coalescedExplicitAction(current, draftRef.current, action);
      draftRef.current = planned.draft;

      // async発話が待っている間に来訪者が明示操作したら、その古い発話結果を後から被せない。
      sequenceRef.current += 1;
      dataRef.current = reducer(current, planned.action);
      dispatch(planned.action);
    },
    [dispatch],
  );

  useEffect(() => {
    return subscribeCommittedUtterance((utterance) => {
      const current = dataRef.current;
      if (!sttEnabled || !shouldClaimUtterance(current, utterance)) return false;

      const sequence = ++sequenceRef.current;
      const baseDraft = seedConversationDraftFromFlowData(draftRef.current, current);
      // busは同期でclaimだけ返し、解析は非同期。utterance自体はこのclosureだけが保持する。
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
          if (!mountedRef.current || sequence !== sequenceRef.current) return;

          // 解析中に別経路で確定済みslotが増えていても、confirmedをvoice/highで上書きしない。
          const latestData = dataRef.current;
          const latestDraft = seedConversationDraftFromFlowData(draftRef.current, latestData);
          const merged = mergeConversationDraft(latestDraft, result.draft);
          draftRef.current = merged;

          // stale snapshotのactionsは使わず、**現在のstate**から正規イベントを再計画する。
          const actions = materializationActionsForDraft(latestData.state, merged);
          if (actions.length === 0) return;

          const batch: Action = { type: 'APPLY_CONVERSATION', actions };
          dataRef.current = reducer(latestData, batch);
          dispatch(batch);
        })
        .catch(() => {
          // 自然会話の解析失敗で受付全体を落とさない。現画面のタッチ/既存音声導線を残す。
          // transcript/氏名をエラーへ載せない。
        });

      return true;
    });
  }, [dispatch, sttEnabled]);

  return <>{children(conversationDispatch)}</>;
}
