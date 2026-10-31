# ドキュメント索引

Daily Chat の設計・運用・検証に関するドキュメントです。
作品の概要とクイックスタートは [README.md](../README.md) を参照してください。

## はじめに読むもの

| ドキュメント | 内容 |
| --- | --- |
| [README.md](../README.md) | 作品概要、主な機能、技術構成、クイックスタート |
| [DEVELOPMENT.md](../DEVELOPMENT.md) | 開発環境の起動、二者での手動確認、自動テスト、トラブル対処 |
| [CONTEXT.md](../CONTEXT.md) | Friend / Chat / Chat Growth / Streak / Send Target などの用語定義 |
| [SUBMISSION.md](../SUBMISSION.md) | 大会提出用の作品説明、起動方法、メインコードの解説 |

## 運用

| ドキュメント | 内容 |
| --- | --- |
| [operations/home-chat.md](operations/home-chat.md) | 日次ジョブ、サービス認証、予約適用、障害復旧 |
| [operations/sns-identity.md](operations/sns-identity.md) | Chat Growth / Streak Appearance の移行・運用 |
| [operations/app-foundation-friends-ui.md](operations/app-foundation-friends-ui.md) | 認証、友達管理、招待、通知の運用手順 |
| [operations/iphone-local-oauth.md](operations/iphone-local-oauth.md) | 実機 iPhone からローカル OAuth を使うためのトンネル |

## 検証記録

| ドキュメント | 内容 |
| --- | --- |
| [testing/home-chat.md](testing/home-chat.md) | ホーム・チャットの手動確認と自動テストの記録 |
| [testing/sns-identity.md](testing/sns-identity.md) | 成長する見た目・アクセシビリティ・性能の検証記録 |
| [testing/app-foundation-friends-ui.md](testing/app-foundation-friends-ui.md) | 認証・友達管理・通知の検証記録 |
| [testing/screenshots/](testing/screenshots/) | iOS / Android の画面キャプチャ |

検証記録には、開発時点の実測値・未確認範囲・端末条件が含まれます。現在の動作を保証するものではないため、日付と条件を確認して参照してください。

## 設計

| ドキュメント | 内容 |
| --- | --- |
| [sdd/specs/](sdd/specs/) | アーキテクチャ、データモデル、順序保証、UI 仕様 |
| [sdd/plans/](sdd/plans/) | 設計を実装へ落とすためのタスク計画 |
| [sdd/spikes/](sdd/spikes/) | 見た目・操作の比較試作 |

設計仕様は Markdown を正本とし、同名の HTML は閲覧用の派生物です。実装と仕様が食い違う場合は、実装・テスト・検証記録を確認したうえで差分を記録してください。

## リポジトリの構成

```text
docs/
├── README.md        本ファイル（ドキュメント索引）
├── operations/      運用手順
├── testing/         検証記録とスクリーンショット
└── sdd/
    ├── specs/       設計仕様
    ├── plans/       実装計画
    └── spikes/      比較試作
```
