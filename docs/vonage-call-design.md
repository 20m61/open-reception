# Vonage 通話・遠隔応対 設計（実装は後続） (issue #4)

実通話の実装は本番認証情報が前提のため、本書では **server-side トークン発行 / セッション /
通話 UI / 状態遷移 / secret 管理 / fallback** の設計とインターフェースを先行整備する。
実装は認証情報が用意でき次第、`CallAdapter`（#20）の本番実装と通知サブシステム（DESIGN #34）で行う。

## 1. 方針

- 受付セッション（#16）ごとに通話用 Vonage セッションを作成する。
- **Vonage token はサーバ側で短命発行**し、クライアントには短命トークンのみ渡す。
- **secret / private key はクライアントに置かない**（server-only env / Secrets Manager、#6）。
- 担当者への**通知**と**通話開始**を分離する。
- 応答 / 拒否 / 未応答 / 切断 / 失敗 / タイムアウトを状態として扱う（既存の状態遷移 #10 と整合）。
- 通話不可時は通知 / 電話 / メッセージへ fallback する（受付フローを止めない）。

## 2. コンポーネントと責務

| 要素 | 責務 |
| --- | --- |
| `CallAdapter`（#20） | 呼び出しの抽象境界。Mock / Vonage を差し替え（基盤実装済み #4） |
| `VonageCallAdapter`（scaffold 済み） | Vonage 経由の呼び出し。session 作成・token 発行をサーバで行う |
| Token 発行 API（server-only） | 受付セッションに紐づく Vonage session と短命 token を発行 |
| 担当者応答 UI / URL | 通知から通話へ入る担当者側エントリ |
| iPad 通話 UI | 受付端末側の通話画面（接続中 / 通話中 / 終了 / 再呼び出し） |
| 監査ログ（#19） | 通話イベント（開始 / 応答 / 失敗 / 切断）を記録（PII 非保持） |

## 3. シーケンス（設計）

```
iPad(受付) --confirm--> /api/kiosk/receptions/:id/call (server)
  server: CallAdapter=Vonage の場合
    1) Vonage session 作成（sessionId）
    2) 受付セッションに sessionId を紐づけ
    3) 担当者へ通知（通知サブシステム / 通知先 #26）
    4) iPad へ短命 publisher token を返す（secret は返さない）
  iPad: token で接続 → 状態 calling
担当者: 通知 → 応答 URL → 短命 subscriber token 取得 → 接続
  応答     → connected（通話中）
  未応答    → timeout → fallback
  拒否/失敗  → failed  → fallback
  切断     → completed / 再呼び出し
```

## 4. インターフェース（先行整備）

`src/adapters/call/vonage-session.ts` に型 / インターフェースを定義する（実装は後続）。

- `VonageSessionRef = { sessionId: string }`
- `ShortLivedToken = { token: string; role: 'publisher' | 'subscriber'; expiresAt: string }`
- `interface VonageSessionService`
  - `createSession(receptionId): Promise<VonageSessionRef>`
  - `issueToken(session, role): Promise<ShortLivedToken>`（短命・サーバ発行）

`CallResult`（#20）の `connected / timeout / failed` を受付状態（#10）へマッピングする既存ロジックを再利用する。

## 5. secret 管理（#6 と整合）

- `VONAGE_APPLICATION_ID / API_KEY / API_SECRET / PRIVATE_KEY` は **server-only**（`NEXT_PUBLIC_` 不使用）。
- 本番は AWS Secrets Manager（DESIGN #34）。
- クライアントへは**短命 token のみ**。secret / private key を bundle に含めない（secret scan #6）。

## 6. 状態遷移（既存 #10 を利用）

`calling → connected | timeout | failed | cancelled`、`connected → completed`、
`timeout/failed → fallback → idle`。Vonage の実イベントをこの遷移へ写像する。

## 7. fallback

通話不可 / 失敗 / 未応答時は、代替担当者（#26）・代表窓口・通知（メール/Slack/電話）へ誘導する。
受付端末は通話 UI が使えなくてもタッチ操作で受付を完了できる。

## 8. テスト方針

- 状態分岐（connected/timeout/failed/cancelled）は **MockCallAdapter**（#20）で e2e 済み。
- 本番 Vonage は adapter 差し替えで接続し、token がクライアント bundle に含まれないことを検査（#6）。
- 通話イベントの監査記録（#19）を確認する。

## 9. 実装時タスク（認証情報が用意でき次第）

- [ ] `VonageSessionService` の実装（session 作成・短命 token 発行）
- [ ] `VonageCallAdapter.call` の実装（scaffold を置換）
- [ ] 担当者応答 UI / URL
- [ ] iPad 通話 UI（接続中 / 通話中 / 終了 / 再呼び出し）
- [ ] 通話イベントの監査ログ保存（#19）
- [ ] secret がフロント bundle に含まれないことの検査（#6）
