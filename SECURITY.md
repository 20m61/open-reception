# セキュリティポリシー / Security Policy

## 脆弱性の報告

open-reception に脆弱性を見つけた場合は、**公開の Issue・Pull Request・Discussion には
書かず**、GitHub の Private Vulnerability Reporting で非公開に報告してください。

- 報告窓口: <https://github.com/20m61/open-reception/security/advisories/new>
  （リポジトリの **Security** タブ → **Report a vulnerability**）

報告には、分かる範囲で次を含めてください。

- 影響を受けるコンポーネント（例: 受付端末 `/kiosk`、管理画面 `/admin`、API route、
  インフラ定義）とコミットまたはバージョン
- 再現手順、または概念実証（PoC）
- 想定される影響（認証・認可の回避、情報漏えい、来訪者の個人情報への影響 等）

検証のために、実在の個人情報や第三者が運用している環境を使わないでください。
ローカル起動（`README.md` の「ローカル起動手順」）で再現できる形が望ましいです。

## 対象範囲

対象:

- このリポジトリのコード・設定・インフラ定義（CDK 等）・ドキュメント

対象外:

- このリポジトリを元に第三者が運用している環境そのもの（その運用者へ報告してください）
- 外部サービス（Vonage、AWS 等）自体の脆弱性（各提供元へ報告してください）
- このリポジトリから到達できない、依存パッケージ単体の既知の脆弱性
  （このリポジトリでの利用によって悪用可能になる場合は対象です）

## 報告後の対応

本プロジェクトは小規模な体制で運用しており、対応期限（SLA）は約束していません。
次の方針で対応するよう努めます。

- 報告を受け取ったら、Private Vulnerability Reporting のスレッド上で受領を伝える
- 内容を確認し、影響と対応方針をスレッド上で共有する
- 修正の進み具合を、同じスレッド上で報告者と共有する

## 調整された公開（Coordinated Disclosure）

- 修正が利用可能になるまで、脆弱性の詳細は非公開のまま扱います。報告者にも、
  修正の公開まで詳細を公表しないようお願いします
- 修正後、報告者と公開の時期・内容を調整したうえで、GitHub Security Advisory として
  公開する方針です（必要に応じて CVE を申請します）
- 報告者の希望があれば、Advisory に謝辞として名前を記載する方針です

---

## Reporting a vulnerability (English summary)

Please **do not** report security vulnerabilities through public Issues, Pull Requests,
or Discussions. Use GitHub Private Vulnerability Reporting instead:
<https://github.com/20m61/open-reception/security/advisories/new>
(**Security** tab → **Report a vulnerability**).

Include the affected component and commit/version, reproduction steps or a PoC, and the
expected impact. Do not use real personal data or environments operated by third parties.

**Scope:** the code, configuration, infrastructure definitions and documentation in this
repository. Deployments run by third parties and vulnerabilities in external services
(e.g. Vonage, AWS) are out of scope — please report those to their operators/vendors.

**Response:** this is a small project and offers no response-time SLA. We intend to
acknowledge reports, share our assessment, and keep you updated in the private report
thread.

**Coordinated disclosure:** details stay private until a fix is available. After the fix,
we coordinate timing and content with the reporter, and we intend to publish a GitHub Security Advisory
(requesting a CVE when appropriate), crediting the reporter if they wish.
