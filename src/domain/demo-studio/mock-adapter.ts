/**
 * デモ用 Mock Adapter (issue #363 Increment 1)。
 *
 * 本番 Kiosk コンポーネント（`src/components/kiosk/KioskFlow` ほか。**編集禁止**・import して再利用）は
 * すべてのバックエンド通信を `window.fetch` 経由で `/api/kiosk/*` に対して行う。ここが唯一の注入点。
 * `createDemoKioskFetch(scenario)` は `fetch` 互換関数を返し、Demo Harness の iframe がその
 * `window.fetch` を差し替えることで、本番 Kiosk を**無改変のまま**シナリオ駆動で動かす。
 *
 * 安全設計（issue #363 最重要 AC）:
 *   - `assertDemoRequestAllowed`（`./sandbox.ts`）で **既定拒否**。`/api/kiosk/*` 以外・クロス
 *     オリジン（Vonage 等）・本番集計（`/api/admin/*`）は `DemoSandboxViolation` を throw する。
 *   - 本モジュールは**グローバル fetch を一切呼ばない**。よって実 API・Vonage 発信・本番集計
 *     （受付作成→利用量/コスト集計）へ到達する経路が存在しない。受付作成は合成 id を返すだけで
 *     実レコードを作らない。
 *
 * 契約整合: `simulatedResults.call` は #374 `RouteResult` の部分集合語彙のまま扱い、Kiosk が期待する
 * 受付状態（`ReceptionState`）へ写像する（独自契約を発明しない）。
 *
 * Inc1 の再現範囲（注入点不足による制約）:
 *   - `/call` は**同期 Mock 通話**として終端状態（connected/timeout/failed）を直接返す。Vonage 非同期
 *     （calling→ビデオビュー）経路は使わない。複数手の取次（代理→部門代表）は個別アニメーションせず
 *     **最終結果**を来訪者に見せる（KioskFlow は単発の `/call` しか叩かないため）。
 *   - STT エンジン失敗（`stt:'error'`）はクライアント側（Web Speech / MockStt）挙動で、fetch からは
 *     強制できない。Mock は STT を「有効化」するのみ。
 *   - QR は `/checkin/resolve`・`/confirm` の**結果**を返せるが、QR ペイロードの**検知**はカメラ入力
 *     が要る（CheckinFlow のスキャナ）。営業時間外は KioskFlow に配線が無く視覚再現できない。
 *   これらの必要注入点はハンドオフ報告に列挙する（kiosk は編集しない）。
 */
import type { ReceptionState } from '@/domain/reception/state';
import type { DemoCallResult, DemoScenario } from './scenario';
import { assertDemoRequestAllowed } from './sandbox';

/** 記録した 1 リクエスト（method + 正規化 path）。検証用（機微値・body は残さない）。 */
export type DemoRecordedCall = { method: string; path: string };

/** fetch 互換関数 ＋ 呼び出し記録。KioskFlow の `window.fetch` に差し込む。 */
export type DemoKioskFetch = typeof fetch & { readonly calls: ReadonlyArray<DemoRecordedCall> };

export type CreateDemoKioskFetchOptions = {
  /** iframe（デモページ）のオリジン。省略時は location.origin、無ければプレースホルダ。 */
  origin?: string;
};

/** #374 RouteResult 部分集合 → Kiosk が期待する受付状態への写像。 */
const CALL_RESULT_TO_STATE: Record<DemoCallResult, Extract<ReceptionState, 'connected' | 'timeout' | 'failed'>> = {
  answered: 'connected',
  no_answer: 'timeout',
  declined: 'failed',
  failed: 'failed',
};

/** 呼び出し列の「来訪者から見た最終結果」を state へ写像する（列が空/未指定なら no_answer 相当）。 */
function terminalCallState(scenario: DemoScenario): ReceptionState {
  const call = scenario.simulatedResults.call;
  const last = call && call.length > 0 ? call[call.length - 1] : undefined;
  return CALL_RESULT_TO_STATE[last ?? 'no_answer'];
}

/** QR 失敗理由 → 非 ok の HTTP ステータス（503=通信断とは区別する）。 */
const QR_FAILURE_STATUS: Record<'expired' | 'used' | 'revoked', number> = {
  expired: 410,
  used: 409,
  revoked: 409,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 選択画面が空にならないための合成ディレクトリ（PII なしの擬似担当者）。 */
function demoDirectory() {
  return {
    departments: [
      { id: 'dept-reception', name: '受付' },
      { id: 'dept-sales', name: '営業部' },
    ],
    staff: [
      { id: 'staff-sato', displayName: 'デモ 佐藤', aliases: [], departmentId: 'dept-reception', available: true },
      { id: 'staff-suzuki', displayName: 'デモ 鈴木', aliases: ['スズキ'], departmentId: 'dept-sales', available: true },
      { id: 'staff-tanaka', displayName: 'デモ 田中', aliases: [], departmentId: 'dept-sales', available: true },
    ],
  };
}

/** QR 有効時の確認サマリ（合成・最小限。実 token/PII なし）。 */
function demoCheckinSummary() {
  return {
    visitorName: 'デモ 来訪者',
    companyName: 'デモ商事',
    visitAt: new Date().toISOString(),
    targetType: 'staff' as const,
    targetId: 'staff-sato',
    usagePolicy: 'single_use' as const,
  };
}

function extractUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function extractMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input === 'object' && input !== null && 'method' in input && typeof input.method === 'string') {
    return input.method.toUpperCase();
  }
  return 'GET';
}

/**
 * シナリオ駆動の fetch 互換関数を生成する。KioskFlow を無改変で動かすための Mock Adapter。
 * 返り値の `window.fetch` への差し替えは Demo Harness の iframe（`/admin/demo/preview`）が行う。
 */
export function createDemoKioskFetch(
  scenario: DemoScenario,
  options?: CreateDemoKioskFetchOptions,
): DemoKioskFetch {
  const origin =
    options?.origin ??
    (typeof location !== 'undefined' && location?.origin ? location.origin : 'http://demo.local');

  const calls: DemoRecordedCall[] = [];
  let receptionSeq = 0;

  const handler = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const rawUrl = extractUrl(input);
    const method = extractMethod(input, init);
    // 既定拒否: 本番 API・Vonage・集計は DemoSandboxViolation で遮断（実ネットワークへ出さない）。
    const path = assertDemoRequestAllowed(rawUrl, origin);
    const pathname = path.split('?')[0] ?? path;
    calls.push({ method, path: pathname });

    // --- 端末稼働状態（runtime） ---
    if (pathname === '/api/kiosk/heartbeat') {
      const runtime = scenario.simulatedResults.runtime;
      if (runtime === 'degraded') return jsonResponse({ error: 'degraded' }, 503);
      const active = runtime !== 'stopped';
      return jsonResponse({ active, pinRequired: false, authorized: true });
    }

    // --- ディレクトリ・設定系（GET） ---
    if (pathname === '/api/kiosk/directory') return jsonResponse(demoDirectory());
    if (pathname === '/api/kiosk/voice') {
      return jsonResponse({
        guidanceIdle: 'デモ受付です。タッチ操作だけで受付できます。',
        ttsEnabled: false,
        // STT は「有効化」のみ（エンジン失敗は client 側挙動で fetch から強制不能, 上部 NOTE 参照）。
        sttEnabled: scenario.simulatedResults.stt !== undefined,
        feedbackEnabled: true,
      });
    }
    if (pathname === '/api/kiosk/assets') return jsonResponse({});
    if (pathname === '/api/kiosk/branding') return jsonResponse({ companyName: 'デモ株式会社' });
    if (pathname === '/api/kiosk/motions') return jsonResponse({ motions: {} });
    if (pathname === '/api/kiosk/flow') return jsonResponse({ flows: [] });
    if (pathname === '/api/kiosk/signage') {
      const showSignage = scenario.initialMode === 'signage' || scenario.initialMode === 'attract';
      return jsonResponse({
        items: showSignage
          ? [{ id: 'demo-signage-1', type: 'text', text: 'ようこそ（デモ）' }]
          : [],
      });
    }

    // --- 受付作成（合成 id・実レコードも本番集計も作らない） ---
    if (pathname === '/api/kiosk/receptions' && method === 'POST') {
      receptionSeq += 1;
      return jsonResponse({ id: `demo-${scenario.id}-${receptionSeq}` });
    }

    // --- 呼び出し（同期 Mock 通話・終端状態を直接返す） ---
    if (/^\/api\/kiosk\/receptions\/[^/]+\/call$/.test(pathname) && method === 'POST') {
      return jsonResponse({ state: terminalCallState(scenario) });
    }
    // 担当者応答ポーリング: デモでは応答イベント無し（フローは既存の /call 結果で完結）。
    if (/^\/api\/kiosk\/receptions\/[^/]+\/status$/.test(pathname)) {
      return jsonResponse({});
    }

    // --- QR 受付 ---
    if (pathname === '/api/kiosk/checkin/resolve' && method === 'POST') {
      const qr = scenario.simulatedResults.qr ?? 'valid';
      if (qr === 'valid') return jsonResponse({ summary: demoCheckinSummary() });
      return jsonResponse({ error: qr }, QR_FAILURE_STATUS[qr]);
    }
    if (pathname === '/api/kiosk/checkin/confirm' && method === 'POST') {
      const qr = scenario.simulatedResults.qr ?? 'valid';
      return qr === 'valid' ? jsonResponse({ ok: true }) : jsonResponse({ error: qr }, 409);
    }

    // --- 退館クレデンシャル（完了画面用・合成値） ---
    if (pathname === '/api/kiosk/stay' && method === 'POST') {
      return jsonResponse({ stayId: 'demo-stay' });
    }
    if (pathname === '/api/kiosk/checkout/issue' && method === 'POST') {
      return jsonResponse({
        token: 'demo-checkout-token',
        code: '000000',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
    }

    // --- 冪等な副作用系（完了/代替導線/評価/認可）: 記録せず ok を返す ---
    if (method === 'POST') return jsonResponse({ ok: true });

    // 未知の GET は 200 空オブジェクトで壊さない（KioskFlow は非 ok も許容するが安全側に倒す）。
    return jsonResponse({});
  };

  // `window.fetch` へ代入するため、記録配列を関数に添付して返す。
  return Object.assign(handler as unknown as typeof fetch, { calls }) as DemoKioskFetch;
}
