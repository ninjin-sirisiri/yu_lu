# App Foundation / Friends UI — 実機検証結果 (living document)

このドキュメントは docs/sdd/plans/2026-09-25-app-foundation-friends-ui.md の実行計画に対する
実データ・実機検証の記録です。タスクごとに「コマンド・期待・実測」を追記していきます。
モックのみを成功の証拠にしないことがルールです。

---

## Task 8: アカウント別SQLiteと永続下書き (2026-09-26 JST)

### 環境

| 項目 | 値 |
| --- | --- |
| Mac / Xcode | Xcode 27.0 (Build 27A266a), macOS 27 |
| シミュレータ | iPhone 18 Pro, iOS 27.0 (UDID 7072095A-DB48-48F5-96E7-605290D56FB8) |
| ネイティブビルド | `npx expo run:ios --no-bundler` (Debug 構成, dev client) |
| JS バンドル | Metro (localhost:8081) からロード、`iOS Bundled 2496ms index.ts (1328 modules)` |
| bundle ID | `com.anonymous.app` — `npx expo prebuild` が自動生成した Expo 標準の暫定値。実運用の iOS bundle ID は未提供の外部入力であり、配布前に実値へ差し替えること。 |
| expo / RN | expo 57.0.25, react-native 0.86.3 |

### 実行した検証 (書込み → プロセス終了 → 再起動 → 復元)

手順 (すべて実機シミュレータ上の実 SQLite。検証用コードは `app/src/storage/persistenceProbe.ts`、
`Documents/storage-probe.enabled` フラグファイルが存在する場合だけ起動時に動作する):
1. フラグを配置し、`xcrun simctl launch <udid> com.anonymous.app --initialUrl "exp+app://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"` でプロセス #1 を起動。
   アカウント別下書き (`drafts` テーブル) へランダムな `token` を書込み、`storage-probe.jsonl` に追記。
2. `xcrun simctl terminate <udid> com.anonymous.app` でプロセスを強制終了 (rc=0、プロセス消滅を確認)。
3. 同じコマンドでプロセス #2 を新規起動。前回の `token` を復元してログへ `restoredFrom` として記録。

#### 実測値 (プロセス #1 書込み後)

Metro ログ / `Documents/storage-probe.jsonl`:

```json
{"at":"2026-09-25T16:28:52.080Z","token":"398f615d-9a62-4cbe-9728-503b03e08799","restoredFrom":null,"restored":false,"schemaVersion":1}
```

#### プロセス終了

```
=== TERMINATE (process exit) at 2026-09-25T16:29:48Z ===
terminated rc=0
=== verify process is gone ===
no app process (exited)
```

#### 実測値 (プロセス #2 再起動後)

```json
{"at":"2026-09-25T16:29:54.663Z","token":"755fdff8-cf41-4653-bd14-2c4dabf09438","restoredFrom":"398f615d-9a62-4cbe-9728-503b03e08799","restored":true,"schemaVersion":1}
```

- **期待**: 2 行目の `restoredFrom` が 1 行目の `token` と一致し、`restored: true`、`schemaVersion: 1`。
- **実測**: 一致 (`restoredFrom = 398f615d-9a62-4cbe-9728-503b03e08799`)。→ プロセス #1 が書いた値が、
  プロセス終了をまたいで新しいプロセスから復元された。

#### アプリ外からの独立確認 (sqlite3 CLI)

終了後、端末の実ファイル `Documents/SQLite/app.db` (53248 bytes) をコピーして観察:

```
$ sqlite3 app.db "PRAGMA user_version;"
1
$ sqlite3 app.db "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
cache
device_settings
drafts
outbox
pending_invitation
$ sqlite3 -header -column app.db "SELECT account_id, draft_key, updated_at, body FROM drafts;"
  account_id    draft_key   updated_at                                                     body
--------------  ---------   --------------  -------------------------------------------------------
__device_probe  relaunch    1790353794660  {"token":"755fdff8-cf41-4653-bd14-2c4dabf09438","restoredFrom":"398f615d-9a62-4cbe-9728-503b03e08799"}
$ sqlite3 app.db "PRAGMA journal_mode;"
wal
```

すべて期待どおり。スキーマ移行 (user_version=1)・WAL・必須テーブル・下書き行の復元が実機で確認できた。
検証後、フラグファイルとログは端末から削除済み (プローブは無効なまま)。

### 検証中に判明した環境問題と対処 (再発時に再利用可)

1. **Xcode 27 で起動即 SIGTRAP**: 最初のビルドは `UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`
   で `Application failed to launch: UIScene life cycle is required for apps built with this SDK` として
   即時クラッシュした (crash report: `app-2026-09-26-011259.ips`, SIGNAL 5 / EXC_BREAKPOINT)。
   iOS 27 SDK でビルドしたアプリは UIKit シーンライフサイクルが必須のため。
   **対処**: expo/expo#46664 どおり `expo-build-properties` の `ios.enableSceneSupport: true` を
   app.json に設定して prebuild。AppDelegate が `ExpoReactNativeFactoryProvider` になり、
   Info.plist に `UIApplicationSceneManifest` (delegate: `EXExpoAppSceneDelegate`) が入って起動するようになった。
   SDK 57 では expo ≥ 57.0.23 が必要 (本プロジェクトは 57.0.25)。
2. **`simctl openurl` の「"app" で開きますか?」ダイアログ**: シンボリックリンク経由の起動は
   SpringBoard の確認ダイアログで止まり、この環境では GUI 操作 (osascript) が使えないため承認できない。
   **対処**: dev launcher は起動引数 `--initialUrl <url>` を読み取る (`EXDevLauncherController initialUrlFromProcessInfo`)
   ので、`simctl launch ... com.anonymous.app --initialUrl "exp+app://..."` でダイアログを回避した。
3. **`expo run:ios` の最後の osascript エラー** (Simulator ウィンドウ前面化) はビルド・インストール・
   ランチ完了後の表示手順のみの失敗で、アプリ本体には影響しない (無視してよい)。

### JS レベルの検証 (SQL 境界)

```
$ npm --prefix app test -- --runInBand __tests__/storage.integration.test.ts
Test Suites: 1 passed, 1 total
Tests:       41 passed, 41 total
```

- Node 組み込み SQLite (`node:sqlite`) に実 SQL を流す統合テスト (本番と同じ SQL 文)。
- 移行 (部分適用の進行・失敗ロールバック・将来版拒否)、下書き/キャッシュ/outbox/招待/端末設定の
  アカウント分離、書込みトランザクションとネスト時セーブポイント、画像コピーの途中失敗での
  参照確定禁止、SecureStore のチャンク分割・再合成・欠損検出、アカウント破棄でテーマが残ることを検証。
- 回帰: `npm --prefix app test` = 21 suites / 272 tests 全通過、`npm --prefix app run typecheck` 成功。
