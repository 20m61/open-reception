'use client';

/**
 * 端末の有効性・セッション保持・疎通の監視を `KioskFlow` から分離したフック
 * (issue #422 increment 2 / #30 / #239)。
 *
 * #422 の実装範囲「`KioskFlow` から（…）環境監視（…）を分離」に対応する。
 * heartbeat を定期的に叩き、次の 4 つを保持する:
 *
 *   - `active`   … 端末が有効か。null=取得前/取得失敗（**既定で表示継続**）、false=失効。
 *   - `authorized` … kiosk セッションを保持しているか。null=取得前（楽観的に表示継続）。
 *   - `pinRequired` … 未保持時に PIN 自己許可へ誘導するか、未エンロール案内かの分岐 (#23)。
 *   - `online`   … heartbeat の疎通。失敗で false、復帰で true (#30)。
 *
 * **取得失敗を「失効」と解釈しない**（null のまま表示を続ける）のが要点。通信の一時断で
 * 受付画面を落とすと、実際には有効な端末が使えなくなる。失効を能動的に伝えるのはサーバの
 * `active=false` だけで、そのとき呼び出し側は受付中の個人情報を破棄して待機へ戻す
 * （`onRevoked`）。
 *
 * 構成の反映報告 (#420): この heartbeat に**いま読み込んでいる版**を相乗りさせる。専用の
 * 周期を足さないのは、報告が運用情報であって受付の可用性に関わらないため（30 秒周期で十分で、
 * 失敗しても次周期が実質リトライになる）。報告内容の決定は
 * `src/domain/kiosk/configuration-report.ts`（純関数）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  configurationReportParams,
  type KioskConfigurationReport,
} from '@/domain/kiosk/configuration-report';

/** 端末有効性・設定変更を検知する heartbeat 間隔 (issue #30)。 */
export const HEARTBEAT_INTERVAL_MS = 30000;

export type KioskDeviceStatus = {
  active: boolean | null;
  authorized: boolean | null;
  pinRequired: boolean;
  online: boolean;
  /** PIN 自己許可・エンロール完了直後に、heartbeat を待たず保持済みへ倒す。 */
  markAuthorized: () => void;
};

export function useKioskDeviceStatus(options: {
  kioskId: string;
  /** サーバが失効（`active=false`）を返したときの後始末（受付の破棄・待機復帰）。 */
  onRevoked: () => void;
  /** heartbeat に相乗りさせる構成の反映報告 (#420)。省略時は報告しない。 */
  report?: KioskConfigurationReport;
}): KioskDeviceStatus {
  const { kioskId, onRevoked, report } = options;
  const [active, setActive] = useState<boolean | null>(null);
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [pinRequired, setPinRequired] = useState(false);
  const [online, setOnline] = useState(true);

  // 最新の `onRevoked` を effect の再起動なしに呼べるようにする（呼び出し側がインラインの
  // クロージャを渡しても heartbeat の間隔が刻み直されない）。ref の更新は描画中ではなく
  // effect で行う（react-hooks ルール準拠。`useStaffResponse` と同じ流儀）。
  const revokedRef = useRef(onRevoked);
  useEffect(() => {
    revokedRef.current = onRevoked;
  }, [onRevoked]);

  // 報告内容も同様に ref 経由で読む。構成が届いたタイミングで heartbeat の周期を
  // 刻み直すと、端末ごとに送信時刻がばらつくだけで得が無い（次周期で報告されれば足りる）。
  const reportRef = useRef(report);
  useEffect(() => {
    reportRef.current = report;
  }, [report]);

  const refresh = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        kioskId,
        ...(reportRef.current ? configurationReportParams(reportRef.current) : {}),
      });
      const res = await fetch(`/api/kiosk/heartbeat?${params.toString()}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        setOnline(false);
        return;
      }
      const hb = (await res.json()) as {
        active: boolean;
        pinRequired: boolean;
        authorized: boolean;
      };
      setOnline(true);
      setActive(hb.active);
      setAuthorized(hb.authorized);
      setPinRequired(hb.pinRequired);
      // 失効/緊急停止を検知したら、受付中の個人情報を破棄して待機へ戻す (issue #30)。
      if (!hb.active) revokedRef.current();
    } catch {
      setOnline(false);
    }
  }, [kioskId]);

  // 起動時に確認し、以降は定期 heartbeat で長期表示中の変化を検知する (issue #30)。
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const markAuthorized = useCallback(() => setAuthorized(true), []);

  return { active, authorized, pinRequired, online, markAuthorized };
}
