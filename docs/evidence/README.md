# evidence/

**機械が出した出力を、そのまま置く場所。** 人が書き直さない。

ここのファイルは「文書の表が実測と一致していること」を機械で確かめるための**突き合わせ相手**
である（#1113）。手で編集した時点で、検査は「人が書いた 2 箇所の一致」に退化し、
#1113 が直そうとしている型そのものへ戻る。

| ファイル | 出どころ | 読む側 |
| --- | --- | --- |
| `emulator-capability.<runtime>.json` | `npm run aws:local:capability -- --json` | `tests/config/capability-doc-sync.test.ts` |

## 取り直し方（エミュレータが要る）

```bash
npm run aws:local:up
npm run --silent aws:local:capability -- --json > docs/evidence/emulator-capability.ministack.json

AWS_RUNTIME=moto npm run aws:local:up
AWS_RUNTIME=moto npm run --silent aws:local:capability -- --json > docs/evidence/emulator-capability.moto.json
```

🔴 **probe は素通りがあれば非 0 で終わる**（現に Cognito が `permissive` なので exit 1 になる）。
`set -e` のスクリプトから呼ぶと記録が取れないので、終了コードを潰さずに**リダイレクトだけ**する。

🔴 **突き合わせ自体はエミュレータを要求しない。** 記録済み JSON との比較なので、既定の品質
ゲート（`--fast`）の中で走る。probe をゲートで実行するのは #1113 の非目標である（#1103 条件 5）。
