# App Foundation / Friends UI — 実機検証結果 (living document)

このドキュメントは docs/sdd/plans/2026-09-25-app-foundation-friends-ui.md の実行計画に対する
実データ・実機検証の記録です。タスクごとに「コマンド・期待・実測」を追記していきます。
モックのみを成功の証拠にしないことがルールです。

---

## Task 22: 仕様14節対応表・ストア/プッシュ試行・全体回帰 (2026-09-27 JST)

### 仕様14節「テストと完了条件」と Task 1〜21 の対応表

対象: `docs/sdd/specs/2026-09-25-app-foundation-friends-ui-design.md`
**14節「テストと完了条件」 (134〜146行)** — 見出し `#` を含めた通し番号で14番目の節。
凡例: **実施済み** = 実行して実結果あり / **未実施** = 実行していない (合格として扱わない) /
**外部入力待ち** = 依存する外部入力が未提供。**未実施を「pass」に置き換えていない。**

| # | 要件 (仕様行) | 該当Task | 証明するテスト・実測 (実行済み) | 実機証拠 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R1 | 登録の重複ID・登録途中の復元・アカウントまたぎ分離・変更不可ID (136) | 3, 8, 10, 21 | `src/profiles/validation.test.ts`・`src/profiles/registration.test.ts` (ID正規化/一意性/変更不可/文字数境界)、`__tests__/registration-flow.test.tsx` (ID衝突候補・アカウント別下書き復元・未登録ガード)、`__tests__/storage.integration.test.ts` (アカウント分離)、pgTAP `registration.test.sql`、deno `profile-validation.test.ts`、`--suite registration`、journey#1-2 (実後端で未登録ガード・A/B登録) | ログイン画面到達のみ (`screenshots/task-19,20,21/`) | 自動・実後端 **実施済み** / 登録画面の実機操作 **未実施** (Apple Team ID・Google Client ID未提供 + ヘッドレスでタップ入力なし) |
| R2 | 部分一致・完全一致優先・追加取得・古い結果の抑止・ブロック除外・友達前Streak非表示 (137) | 5, 12, 21 | `src/discovery/lookup.test.ts`、`__tests__/friends-discovery.test.tsx` (2文字境界・300ms・遅い旧応答破棄・もっと見る)、pgTAP `discovery.test.sql` (ブロック除外・Streak非公開)、deno `discovery.test.ts`、`--suite discovery`、journey#3 (完全一致・前方でない大文字部分一致・Streakキーなし) | なし (検索UIはログイン後) | 自動・実後端 **実施済み** / 実機UI **未実施** (R1と同じ理由) |
| R3 | 相互申請・重複送信・承認と取消/期限切れの競合・終了表示・再申請・拒否通知なし (138) | 4, 13, 18, 21 | pgTAP `requests.test.sql`、deno `requests.test.ts`、`--suite requests` (並行競合・古いrequest_id・第三者・重複操作)、`__tests__/request-flow.test.tsx`・`sync-status.test.tsx`、拒否通知なし = pgTAP `notifications.test.sql` + deno `notifications.test.ts` (rejectは配送しない)、journey#4-5 (申請→承認→成立) | なし (申請UIはログイン後) | 自動・実後端 **実施済み** / 実機UI **未実施** (R1と同じ理由) |
| R4 | オフライン再起動復元・送信開始と取消の競合・応答喪失・24時間期限・ログアウト中の停止 (139) | 8, 9, 20, 21 | `__tests__/storage.integration.test.ts`、`src/sync/queue.test.ts`・`worker.test.ts` (応答喪失・取消競合・24時間)、`__tests__/sync-lifecycle.test.ts` (前景/背景同時・タスクキル・期限超過・ログアウト5順序・オフライン境界)、`__tests__/logout-entry.test.tsx` (仕様28行 マイページ入口・pending説明・順序)、journey#7 (実後端: transient pending→storage閉/開→同一操作IDで drain 再送) | Task 20 実機ログ (`[sync] storage open → gate passed → no-session`、`screenshots/task-20/`) | **実施済み** / オフラインログアウトの**対話E2E**と物理端末での境界確認 **未実施** (実OAuthにUI入力が必要+ヘッドレス。理由はTask 20節 device-pending表) |
| R5 | 画像失敗時の非公開・再編集統合・下書き保持・項目別競合解決・文字数境界 (140) | 7, 16, 17 | `--suite profile-publication` + pgTAP `profile-publication.test.sql` (アップロード前/他人画像で全項目不変・版二重増加なし)、deno `profile-commands.test.ts`、`src/media/avatar.test.ts`・`AvatarPicker.test.tsx`・`src/media/images.test.ts`、`__tests__/profile-editor.test.tsx`・`src/profiles/edit.test.ts` (下書き・競合・文字数) | Task 16 実機プローブ (EXIF補正 240×320・白合成4隅(254,254,254)・1024×1024・再起動復元 — Task 16節) | **実施済み** (実機はプローブ範囲) / OSピッカー・カメラUI操作 **未実施** (タップ入力なし・許可UI到達不可)、Android実機 **未実施** (端末/AVDなし) |
| R6 | 招待再発行による失効・登録中の失効・最初の招待の保持・復元不能/不正リンク時の案内 (141) | 6, 14, 15 | pgTAP `invitations.test.sql`、deno `invitations.test.ts`、`--suite invitations` (再発行で旧リンク失効・同時再発行)、`__tests__/invitation-flow.test.tsx` (keep-first・復元不能でも登録を止めない・失効表示)、`node --test scripts/invite-web.test.mjs` (referrer=`invitation=<32hex>`一致・コピー成功時のみApp Store遷移・失敗時再試行) | なし (カメラ/貼り付け/実referrerは device-pending — Task 14節) | 自動 **実施済み** / **ストア経由のE2E 未実施** (下記「ストア引き継ぎの試行」参照 — 外部入力待ち) |
| R7 | 複数端末通知・ログアウト後の停止・表示中の案内・古い通知からの移動・重複配信抑止 (142) | 18, 19, 20 | pgTAP `notifications.test.sql`、deno `notifications.test.ts`、`--suite notifications` (2端末登録・無効トークン・再処理冪等・配信キューの無権限読取拒否・batch claim 1回配信)、`__tests__/notification-entry.test.tsx` (権限拒否・前景案内・背景タップ・cold応答・古い通知・重複callback・招待/OAuth非混同)、`sync-lifecycle`/`logout-entry` (失効順序=配信停止) | `screenshots/task-19/01-launch-login-guard.png` (実dev buildで起動時に許可プロンプトが出ない) | **実施済み** / **実プッシュ (2端末・前景・背景・終了・ログアウト) 未実施** (下記「実プッシュの試行」参照) |
| R8 | ライト/ダーク・時間帯変更・同時刻拒否・文字拡大・1列/2列切替の入力保持・タブ再選択 (143) | 11, 1 | `__tests__/theme-layout.test.tsx` (899/900・fontScale 1.353・同時刻拒否・日跨ぎ・復帰再評価・切替時の選択/下書き保持・テーマ永続)、`__tests__/navigation-shell.test.tsx` (4タブ構成)、`__tests__/tab-behavior.test.tsx` (**タブ再選択=仕様32行**: 別タブ往復で詳細画面保持・選択中タブの再選択でスタック先頭へポップ・先頭なら一覧を先頭へスクロール (friends/requests 両リスト応答) — 4件) | `screenshots/task-11/` 4点 (明暗・最大文字)、`screenshots/task-21/` 01-03 (iPhone明暗・XXXL)・04 (iPad起動) | **実施済み** (前回まで未実施だった**タブ再選択 (仕様32行) は自動テストで本日実施済み** — 実装+テスト4件) / テーマ設定画面・900境界2列・**タブ再選択の実機表示は未実施** (ログイン後のみ到達 — OAuth未提供+タップなし)、VoiceOver **未実施** (simctlに切替手段なし) |
| R9 | 自動テスト = 境界値・状態遷移・サーバー権限・再送の整合性 + 結合経路 (144) | 1〜21 全体 (Task 1 の `navigation-shell`/`scaffold` も本行に計上) | 最終回帰実測: jest **38 suites / 633 tests**、pgTAP **621 / Files=7**、deno **128**、local-backend **191**、invite-web **25** (下記「最終コマンド」)。結合経路 = `__tests__/app-journey.test.tsx` 7件 (実ローカルSupabase・実Auth・実 `app-command`/`app-query`・実SQLite outbox で 登録→検索→申請→承認→成立→更新→オフライン復帰) | journey はNode上の実後端結合 (端末ではない) | **実施済み** — 画面レンダー系はモックワイヤ、journey が実後端の結合経路 (両者を区別して記録) |
| R10 | 実機でカメラ・画像・QR・プッシュ・バックグラウンド処理、AndroidはGoogle Play経由インストール、iOSはインストールを挟む明示的貼り付けと拒否・消失時の復帰 (145) | 14, 15, 16, 18, 19, 20, 21 | (代替の自動検証は R5・R6・R7 に記載) | なし | **大半 未実施** — 個別理由: カメラ/QR = ヘッドレスでタップ入力なし・許可UI到達不可 / 画像 = プローブは実機済み・OSピッカーUIは未 / プッシュ = 資格なし (下記) / バックグラウンド = iOSシミュレータはBGTaskScheduler非対応 (実OS回答 `unavailable`・Task 20実測)、実機実行未 / Google Playインストール = `adb devices` 空・AVD 0件・ストアアカウントなし / iOS貼り付け = ストアインストール不能 (App Store ID・配布権限なし) + ヘッドレス |
| R11 | Expo 57/RN 0.86.3実プロジェクトでビルド・型検査・関連テストを実行し、**ストア経由の検証結果を記録して初めて完成条件** (146) | 1〜21 全体 | ビルド: `npx expo run:ios` **Build Succeeded** (Task 8/20/21 実測、`enableSceneSupport` で起動まで到達)、型検査: `typecheck` **0 errors**、関連テスト: 上記全コマンド緑 | `screenshots/task-11,19,20,21/` | ビルド・型検査・テスト **実施済み** / **ストア経由の検証結果: 未記録** → §14 の完成条件は**未達** → **本番完成を宣言しない** |

### device-pending / 未実施 集約表 (該当箇所の正確なブロック理由)

| 項目 | 確切なブロック理由 |
| --- | --- |
| 実OAuth (Apple/Google) の成功・取消・callback中断 | Apple Team ID / Google OAuth Client ID・Secret / SupabaseプロジェクトのOAuth設定が**未提供の外部入力** (ops doc「未提供の外部入力」)。実Authも `Unsupported provider: provider is not enabled` |
| 登録・検索・申請・プロフィール等のログイン後UIの実機操作 | 上記OAuth未提供でログイン後ルートへ到達不可 + ヘッドレスシミュレータに**タップ入力なし** (Simulator.app がXcode 27に同梱されておらず `idb` も未導入) |
| 幅900の2列表示・テーマ設定画面の実機表示 | ログイン後のみ到達 (同理由)。iPad **起動**自体は task-21/04 で成功済みだが2列表示は未確認 |
| VoiceOver操作 | `simctl ui` にVoiceOver切替コマンドが存在せず (appearance/content_size のみ)、設定.app のタップも不可 |
| 実カメラQR・保存画像読取・`ClipboardPasteButton` 実貼り付け | タップ入力なし・カメラ/写真の許可UIに到達不可 (Task 14節 device-pending表) |
| 実プッシュ (2端末・前景・背景・終了・ログアウト) | `app/app.json` に `extra.eas.projectId`/`expo-notifications` プラグイン**未設定** (`expo config --type public` に projectId なし)、APNs `.p8`/`GoogleService-Info.plist`/`google-services.json` **リポジトリ内に存在しない** (scan 0件)、`eas whoami` → **`Not logged in`** (project idを発行できない)、iOSシミュレータはAPNs受信不可、物理端末なし |
| BGTaskScheduler によるバックグラウンド実行 | **iOSシミュレータは Background Tasks API 非対応** (SDK57ドキュメント明記・実OS回答 `unavailable` をTask 20で実測)。物理端末が必要 |
| Android 全項目 (ビルド・起動・Play配布) | `adb devices` → **デバイス0台**、`emulator -list-avds` → **AVD 0件** (system image は存在するが未作成)、物理端末なし。実エラー `CommandError: No Android connected device found…` (Task 21節) |
| Google Play 検証配布からのインストール→referrer→登録→最初の招待先 | (1) 上記のAndroid実行対象なし、(2) Google Play開発者アカウント/検証配布の**外部入力なし**、(3) `INVITE_ORIGIN` ほか6つの配布入力が全て unset |
| iOS HTTPS招待ページ→コピー→App Storeインストール→標準貼り付け→登録→確認 (コピー消失・失効・別招待・復帰・中断を含む) | `IOS_BUNDLE_ID`/`APPLE_TEAM_ID`/`APP_STORE_ID`/`INVITE_ORIGIN` が**全て unset**、**ストアアカウント・配布権限なし** (提供されていない外部入力)、ヘッドレスで貼り付けUI操作不可。**TestFlightは未使用** (EAS未ログイン・App Store IDなし) であり、仮に使用しても App Store 経由の成立は証明しない |
| EASビルド (`eas build`) | EASアカウント・署名資格なし (`eas whoami` = Not logged in) |

### ストア引き継ぎの試行 — ローカルで可能な範囲の実測と残るブロッカー (要件2)

実測した確認 (すべて本日・リポジトリルート):

1. 配布6入力の実在確認 → `INVITE_ORIGIN / IOS_BUNDLE_ID / APPLE_TEAM_ID / APP_STORE_ID / ANDROID_PACKAGE / ANDROID_CERT_SHA256` は**すべて unset** (既定値・偽値は作らない)。
2. `node scripts/check-native-config.mjs` → **exit 2**、`missing external inputs: <上記6つ>` — 配布準備モードは構造的に通過不可 (外部入力不足でありリグレッションではない)。
3. Android側: `adb devices` → 空、`emulator -list-avds` → 空 → Playインストールを試みる**実行対象が存在しない**。
4. iOS側: `xcrun devicectl list devices` → physical iPhone 15 (`00008120-…`) は paired available だが未署名ビルド導入・ロック解除入力が必要で操作不可 (Task 20節記録)。ストア配布ビルドのインストールはストアアカウント必須 (未提供)。
5. EAS: `eas --version` = 18.11.0 / `eas whoami` → **`Not logged in`** → ビルド・TestFlight・ストア送信すべて不可。
6. 実施可能な代替 (ローカルのみ): `node --test scripts/invite-web.test.mjs` → **25 passed** — Play referrer のURLエンコード値と `invitation=<32hex>` の一致、iOSはコピー**成功後にのみ**App Storeへ遷移・失敗時は遷移せず再試行、を**ローカルのvm実行**で検証 (TEST-ONLY fixture・公開値ではない)。`node scripts/build-invite-web.mjs` は値なしなら失敗 (実測済み)。

**実施できなかったもの (外部入力・ストア権限待ち):**
- Google Play 検証配布からの実インストール → referrer取得 → 登録 → 最初の招待先の確認。
- iOS: HTTPS招待ページ → コピー → App Storeからインストール → 標準貼り付け → 登録 → 確認。およびコピー消失・失効・別招待・復帰・中断の確認。
- → **該当するストア条件が未検証のため、本番完成を宣言しない** (TestFlightで App Store 経由の成立を証明することもしない)。

### 実プッシュの試行 (要件3)

試行と実測:

- `npx expo config --type public` に `projectId` / `notifications` 設定が**存在しない** (grep 0件) → SDK 57 が project id を推定できず、トークン取得は構造的に失敗する。
- リポジトリ内に APNs (`*.p8`) / FCM (`google-services.json`, `GoogleService-Info.plist`) の**資格ファイルなし** (scan 0件)。
- `eas whoami` → **`Not logged in`** → EAS project id を発行できない。
- → **構成済み開発ビルドでの実プッシュ試行は「資格が存在しないため実施できず」、2端末・前景・背景・終了・ログアウトの確認は未実施** (モック成功での代替はしない)。

記録として残す (実機未検証の項目として扱う):

- **バックグラウンドのOS制約**: iOSシミュレータは BGTaskScheduler 非対応 (実OS回答 `unavailable`・Task 20実測)。実機での実スケジュール実行は**未検証**。
- **配信済み通知の扱い**: OS通知センターの通知は取り消せない (アプリの制御外)。ログアウト後の停止は将来の配信について成立する (Task 20 ruling・仕様107行)。**実配信がないため実機での目視確認は未検証**。

### 最終コマンド実測 (2026-09-27 JST、すべてリポジトリルートから実行)

| コマンド | 実結果 |
| --- | --- |
| `npm --prefix app test -- --runInBand` | **Test Suites: 38 passed, 38 total / Tests: 633 passed, 633 total** (16.4s) — タブ再選択 (仕様32行) の4件追加後 |
| `npm --prefix app run typecheck` | **exit 0** (`tsc --noEmit` 0 errors) |
| `npx supabase test db` | **Files=7, Tests=621, Result: PASS** (All tests successful) |
| `npx deno test --allow-env --allow-net --config supabase/functions/deno.json supabase/functions/tests` | **ok \| 128 passed \| 0 failed** |
| `node scripts/test-local-backend.mjs --suite all` | **all: 191 passed, 0 failed** (local Auth users 55人削除) |
| `node --test scripts/invite-web.test.mjs` | **tests 25 / pass 25 / fail 0** (exit 0) |
| `git diff --check` | **exit 0** (出力なし = 空白エラーなし) |
| `node scripts/check-native-config.mjs --dev` | **exit 0** (all checks passed — ローカル設定のみ) |
| `node scripts/check-native-config.mjs` | **exit 2** — 6つの外部入力未提供。**既知の記録状態でありリグレッションではない** (捏造しない) |

失敗したコマンドは無し。新しい失敗による該当Taskの完了見直しは発生していない。

### 今回範囲の完了状態と宣言

計画の完了条項「**全自動検証と必要な実機証拠が揃った時点で今回範囲を完了とする**」に対し:

- **揃ったもの (完了)**: 上記の全自動検証 (jest/pgTAP/deno/local-backend/invite-web/typecheck/diff-check)、実ローカル後端の結合経路 (journey 7件)、この環境で到達可能な実機証拠 (実dev build起動・実SQLite/実画像プローブ・明暗/文字拡大/iPadの実スクリーンショット)。
- **揃わないもの (外部入力待ち)**: ストア経由の検証 (仕様146行が求める「ストア経由の検証結果の記録」)、実OAuth、実プッシュ (2端末含む)、BGTaskSchedulerの実機実行、Android端末一式、VoiceOver、ログイン後UIの実機操作 (900二列・テーマ設定画面・タブ再選択を含む)。

→ **本番完成を宣言しない。** 残る検証は上記「device-pending / 未実施 集約表」と
「ストア引き継ぎの試行」「実プッシュの試行」にブロック理由付きで列挙したとおりで、
いずれもこのリポジトリで解消できない外部入力 (ストアアカウント・配布権限・OAuth資格・
通知資格・EASログイン・実機端末) が原因である。

---

## Task 21: 実データ通し操作とネイティブ配布設定 (2026-09-27 JST)

### 環境

| 項目 | 値 |
| --- | --- |
| ローカル後端 | Supabase (Docker) 起動済み `http://127.0.0.1:54321`、`app/.env` の URL/anon key は `npx supabase status` と**完全一致** (journeyが不一致なら起動時に拒否) |
| iOS dev build | `npx expo run:ios --device 7072095A-…` → **Build Succeeded / 0 errors, 1 warning** (Expo Dev Launcherの Strip Local Network Keys = dev向け既知warning)、`com.anonymous.app` を iPhone 18 Pro へインストール・起動、`iOS Bundled … index.ts (1533 modules)` |
| シミュレータ | iPhone 18 Pro / iOS 27.0 (ヘッドレス) + iPad Pro 13-inch (M5) / iOS 27.0 |
| Android | **ブロッカー** (下記「端末マトリクス」に実エラー全文) |
| Metro | `npx expo run:ios` が同梱起動 (タスク20のIPv6問題なし) |

### 実データ通し操作 (A/B journey — OAuth検証とは別系統の証拠)

```
$ npm --prefix app test -- --runInBand __tests__/app-journey.test.tsx
Test Suites: 1 passed, 1 total
Tests:       7 passed, 7 total
```

**実物**: 本物のローカル Supabase (実Authユーザー・実 `app-command`/`app-query` Edge
Functions・実SQLite outbox・本番クライアント層 `backend/queries` / `sync/api` /
`sync/queue`+`worker` / `sync/lifecycle`)。**模擬**: node:sqlite ドライバと、
送信ポートに1つのオフライン窓 (接続不能を `transient` として報告 — transport層の代役のみ)。

| # | ステップ | 実測内容 |
| --- | --- | --- |
| 1 | 未登録ガード | 登録前の `search_profiles`/`list_friends` が `Confirm the User ID before using the app.` で拒否 |
| 2 | A/B登録 | `assertRegistrationInput` → `createCommandApi.send(kind:'register')` で両者登録、友達0の初期状態 |
| 3 | 部分一致検索 | 完全一致 [B]、**前方でない・大文字にした部分一致** [B] のみ、`relationship:none`、**Streakキー自体なし** (友達前非表示)、プロフィール閲覧 |
| 4 | 申請 | **本番outboxキュー経由**で送信 (`succeeded`)、Bの受信一覧に `pending` + **有効期限 約7日**、Aの送信一覧に `pending\|<B>` |
| 5 | 承認・成立 | Bの直接 `approve` (画面decide pathと同じ経路) → 両方向 `list_friends` に相互あり `relationship:friend` + **streak数値** |
| 6 | プロフィール更新 | キュー経由で `update_profile` (base_version CAS) → 自分 `getOwnPublication` が新しい表示名・自己紹介 (改行入り)・version+1、Bからの閲覧も一致 |
| 7 | オフライン→再起動→復帰 | オフライン窓で enqueue → 送信 `transient` で **`pending` のまま**・サーバー不変・Bからも不変 → **storage閉じ→同一ファイル再オープン (新handle=プロセス再起動相当)** → 行は同一 operation id で生存 → 時計を進めて (初回再試行 ≈5s バックオフ) **本番 `createSyncLifecycle().drain('resume')`** が同一 id を送信 `ok` → 公開反映・`succeeded` |

- **Authパターンは流用 (重複実装しない)**: `scripts/lib/local-backend.cjs` —
  `test-local-backend.mjs` と journey の**共通モジュール** (adminユーザー作成・
  ローカルJWTminting+実 `GET /auth/v1/user` 検証・functions serve寿命管理)。
  `.cjs` は jestが `.mjs`を変換しないため (runnerはESMのdefault importで利用)。
- OAuth自体の実機検証 (Apple/Google成功・取消・中断) は従来どおり device-pending
  (外部OAuth資格)。**この journey はそれとは独立した実データ証拠**。

### マイページのログアウト入口 (Task 20からの引継ぎ要件)

`mypage/index.tsx` に `performLogout` 配線を追加 (未送信/送信中の**確認表示→実行**、
`stopWorker`/`resumeWorker` は `getSharedSyncLifecycle()` に注入 — Task 20レポート指定どおり)。

```
$ npm --prefix app test -- --runInBand __tests__/logout-entry.test.tsx
Tests:       4 passed, 4 total
```

実測: ①入口の描画 (仕様28) ②**未送信1件と送信中1件を別々に説明**しキャンセル→
worker停止・マーカー・port一切なし ③実行→`stop → (マーカー存在下で)invalidate →
discard → purge → resume` の順を実測、マーカー消去・アカウントデータ消去・
provider refresh ④オフライン失効→`pending`: マーカー保持・データ保持・
`resume` 呼び出し・案内表示。**モックはtransport/discardのみ (実performLogout・
実countUnsent・実SQLite・実deleteAccountData)**。

### ネイティブ配布設定の検証

```
$ node scripts/check-native-config.mjs --dev     # ローカル設定 → exit 0 (all checks passed)
$ node scripts/check-native-config.mjs           # 配布準備 → exit 2 (正しく失敗)
  FAIL  missing external inputs: INVITE_ORIGIN, IOS_BUNDLE_ID, APPLE_TEAM_ID,
        APP_STORE_ID, ANDROID_PACKAGE, ANDROID_CERT_SHA256 …
```

- 2モードの区別・検証項目は `docs/operations/app-foundation-friends-ui.md`
  「ネイティブビルド・配布設定の検証 (Task 21)」に記載。
- `app/eas.json`: development (`developmentClient` + internal) / preview (internal + apk)。
  **識別子はeas.jsonに複製しない** (正本 = app.json / expo config)。checkerが一致を検証。
- `app/app.json`: `android.package: "com.anonymous.app"` を追加 (iOS bundleIdentifierと同一の
  開発用識別子。未入力だと prebuild が対話プロンプトで停止)。**ストア申請時は実所有idへ
  差し替えが必要** (配布済みと呼ばない)。
- TEST-ONLY fixture値 (`--test-config` 用) は配布準備モードで**必ずFAIL** (checker実測)。

### 実機スクリーンショット (docs/testing/screenshots/task-21/)

| ファイル | 端末・OS・ビルド | 手順 | 期待 | 実結果 |
| --- | --- | --- | --- | --- |
| 01-iphone-login-light.png | iPhone 18 Pro / iOS 27.0 / dev build `com.anonymous.app` (Build Succeeded・実Metroバンドル) | `simctl ui appearance light` → SpringBoard再起動 (`simctl spawn booted launchctl kickstart -k system/com.apple.SpringBoard`) → `simctl terminate` → `simctl launch` → screenshot | ログイン画面がライトで表示 | **一致** (実アプリ・実iOSのフレーム) |
| 02-iphone-login-dark.png | 同上 | 同手順で `appearance dark` | ダークに追従 (端末に合わせる) | **一致** (surface暗転・可読) |
| 03-iphone-login-dark-text-XXXL.png | 同上 | `content_size extra-extra-extra-large` → SpringBoard再起動 → 冷起動 → screenshot | 文字拡大 (標準サイズ最大) で可読 | **一致** (見出し・ボタン・本文が拡大、破綻なし) |
| 04-ipad-login.png | iPad Pro 13-inch (M5) / iOS 27.0 / 同ビルド | `simctl install` → `simctl launch` → screenshot | タブレットで起動・表示 | **一致** (Metroへ自動接続しログイン画面到達。タスク11でブロックされていたiPad起動が今回成功) |

- 見た目検証用HTMLは**一切使っていない** (全て実アプリ・実OSのスクリーンショット)。

### 端末マトリクス (iPhone / Android / タブレット)

| 項目 | 端末・OS・ビルド | 手順 | 期待 | 実結果 |
| --- | --- | --- | --- | --- |
| 明暗 (iPhone) | iPhone 18 Pro / iOS 27.0 / dev build | 上表 01/02 の手順 | 両テーマで可読 | **実測OK** (01・02) |
| 文字拡大 (iPhone) | 同上 | 上表 03 の手順 (`content_size extra-extra-extra-large`) | 拡大後もレイアウト破綻なし | **実測OK** (03)。注: `accessibility-*` 系カテゴリは `simctl ui` では設定されるが**RNアプリへ伝わらず通常サイズのまま** (ネイティブ設定.appでは拡大表示を確認 — 環境観測として下記に記録) |
| 起動 (タブレット) | iPad Pro 13-inch (M5) / iOS 27.0 / 同ビルド | `simctl install`+`launch` | 起動・表示 | **実測OK** (04) |
| 登録 (iPhone/Android/タブレット) | 全端末 | ログイン→登録画面へ | User ID・表示名の登録UI動作 | **device-pending**: 実Apple/Google OAuth資格が未提供 (Apple Team ID / Google Client ID — ops doc「未提供の外部入力」) + ヘッドレスシミュレータは**タップ入力なし** (Xcode 27制約)。サーバー側の登録は journey#1-2 で実後端実測、UI規則は jest (registration-flow 等) |
| 画像 (プロフィール画像) | 同上 | 登録後→マイページ→編集→画像選択 | 選択・切り抜き・円形表示 | **device-pending**: 上記に加え画像ピッカー/カメラ/写真アクセスの**許可ダイアログもタップ不可**。処理パイプラインは jest (Task 16) + 実SQLite/FS実測 (Task 16) |
| QR (招待QR・読み取り) | 同上 | 友達追加→QR表示/スキャン | QR表示・カメラ読取 | **device-pending**: 同上 (カメラ許可UI到達不可)。生成・パースは jest (Task 14) |
| 幅変更 (900境界・2列) | 同上 (幅≥900は iPad/横長) | ログイン→タブシェル→幅/文字拡大変更 | 900以上で左ナビ2列、狭い/拡大で4タブ1列、選択・下書き保持 | **device-pending**: タブシェル自体がログイン後のみ到達 (OAuth未提供+タップなし)。境界ロジックは jest 実測 (theme-layout 889/900/fontScale) |
| 音声読み上げ (VoiceOver) | iPhone/iPad / iOS 27.0 | 設定→アクセシビリティ→VoiceOver → 画面操作 | ラベル・読み上げ順で操作可能 | **device-pending**: `simctl` にVoiceOver切替コマンドがなく (appearance/content_sizeのみ提供)、設定.app内のタップも不可。ラベル付与はjestで検証済み (accessibilityLabel/role assertions) |
| Android 全項目 | (端末なし) | `npx expo run:android --device` | ビルド・インストール・起動 | **ブロッカー (実エラー)**: `CommandError: No Android connected device found, and no emulators could be started automatically.` — `adb devices` は空、**AVDなし** (system image `android-37.0` は存在するがAVD未作成)、物理端末なし。`prebuild`自体は成功 (`android.package` 追加により対話プロンプトなし) |

### 検証コマンドと結果 (一覧)

| コマンド | 結果 |
| --- | --- |
| `npm --prefix app test -- --runInBand __tests__/app-journey.test.tsx` | **7 passed** |
| `npm --prefix app test -- --runInBand __tests__/logout-entry.test.tsx` | **4 passed** |
| `npm --prefix app test -- --runInBand` | **36 suites / 623 tests 全通過** (タスク20比: 34/612 → +2/+11) |
| `npm --prefix app run typecheck` | **0 errors** |
| `node scripts/test-local-backend.mjs --suite all` | **191 passed** (helper共通化後の回帰) |
| `node --test scripts/invite-web.test.mjs` | **25 passed** (app.json・invite-web-config変更後も `expo config` 両状態green) |
| `node scripts/check-native-config.mjs --dev` | **exit 0** (all checks passed) |
| `node scripts/check-native-config.mjs` | **exit 2** — 6つの外部入力未提供を明示 (配布準備は未達。**捏造しない**) |
| `npx expo run:ios --device <UDID>` | **Build Succeeded** / 0 errors, 1 warning / install + launch 実測 |
| `npx expo run:android --device` | **exit 1 (blocker)** — 上記エラー全文 |
| `npx supabase test db` | **621 passed / Files=7** (サーバー無変更の回帰) |
| `npx deno test --allow-env --allow-net --config supabase/functions/deno.json supabase/functions/tests` | **128 passed** (同上) |

### 検証中に判明した環境問題と対処 (再発時に再利用可)

1. **jest-expoは `expo/fetch` をグローバル `fetch` に差し替え、そのnative module
   (`ExpoFetchModule`) はテスト用スタブ** → `res.status === undefined` で実HTTPが死ぬ。
   → `app/testSupport/nodeFetch.ts` がNode realmに残る**本物のundici fetch**を
   捕まえて (`process.nextTick.constructor('return globalThis')()` 経由) ジョーニーのimport時
   に復元。**journey以外のテストは注入wireのまま** (影響なし)。
2. **外観・文字サイズの変更はSpringBoard再起動を挟むまでアプリへ届かない** (タスク11と同一)。
   `simctl ui …` → `simctl spawn booted launchctl kickstart -k system/com.apple.SpringBoard`
   → `terminate` → `launch` → screenshot。**1サイクル-staleになることがあった** (設定と
   表示がずれる) ので、撮影後は画像を必ず目視確認してから確定 (不一致は撮り直し)。
3. `accessibility-*` 系の文字サイズはネイティブ設定.appでは効くが**RNアプリに伝達されず**
   (冷起動後も通常サイズ)。標準最大 `extra-extra-extra-large` は伝達された (03を確認)。
4. **`"app" で開きますか?` の起動確認ダイアログ** (タスク11と同じ) はタップ不可。
   → SpringBoard再起動で消える (有効な回避策)。
5. `simctl launch` は**既存プロセスを前面化しない** (同一PIDで何も起きない)。
   前面化には `terminate` → `launch` の順が必要 (別アプリ比較の時も同じ)。
6. `logout-entry.test.tsx` の**テスト順は意図的** (render → pending → cancel → completed):
   「cancel→completed の直後に別のレンダー」の組み合わせで state更新が落ちる
   (renderRouterのfake timer下の act多重化)。組合せは特定済み・順序固定で安定。

### device-pending まとめ (今回の打切り条件)

| 項目 | 理由 (具体) |
| --- | --- |
| 実OAuth (Apple/Google) を含む 登録/ログインUI実機操作 | Apple Team ID・Google OAuth Client ID/Secret 未提供 (ops doc) + ヘッドレスでタップ入力なし |
| 画像・QR・許可ダイアログ操作 | 同上 (ログイン未了 + タップ不可) |
| 900境界の2列表示・タブ内詳細保持 | ログイン後のタブシェル到達不可 |
| VoiceOver操作 | simctl に切替手段なし・設定.appのタップ不可 |
| Android全項目 | 接続端末/AVDなし (AVD作成は未実施の追加作業、system imageは有り) |
| EASビルド (`eas build`) | EASアカウント・署名資格なし (外部入力) |

---

## Task 20: バックグラウンド再送とログアウト境界 (2026-09-27 JST)

### 環境

| 項目 | 値 |
| --- | --- |
| Mac / Xcode | Xcode 27.0, macOS 27 |
| シミュレータ | iPhone 18 Pro / iOS 27.0 (UDID 7072095A-…、Boot済み)。**GUI不在・タップ入力なし** (タスク16/19と同じ制約) |
| ネイティブビルド | `npx expo prebuild --platform ios` → `app/app.json` に `expo-background-task` プラグイン追加 (expo install の指示どおり) → Info.plist に **`UIBackgroundModes: processing`** と **`BGTaskSchedulerPermittedIdentifiers: com.expo.modules.backgroundtask.processing`** を確認。`npx expo run:ios --device 7072095A-…` → **Build Succeeded, 0 error** (警告は既存の Build Phase 依存関係表示のみ)。Podfile.lock に **ExpoBackgroundTask (57.0.20) / ExpoTaskManager (57.0.20) / ExpoNetwork (57.0.2)** を確認 |
| JS | Metro `localhost:8081`。`xcrun simctl terminate` → `xcrun simctl launch … --initialUrl "exp+app://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081"` で cold launch |

### JS層 (MOCKED-LAYER: expo-task-manager / expo-background-task / expo-router/entry。アウトボックスは**実SQLite**、キュー・ワーカー・lifecycle・ログアウトは**本物の実装**)

```
$ npm --prefix app test -- --runInBand __tests__/sync-lifecycle.test.ts   → 27 passed
$ npm --prefix app test -- --runInBand                                     → 34 suites / 612 tests 全通過 (タスク19比 +27)
$ npm --prefix app run typecheck                                          → 0 errors
$ node --test scripts/invite-web.test.mjs                                 → 25 passed (app.json にプラグイン追加後も expo config 両状態green)
$ npx supabase test db                                                    → 621 passed / Files=7
$ npx deno test --allow-env --allow-net --config supabase/functions/deno.json supabase/functions/tests/ → 128 passed (サーバー未変更の回帰)
```

27件の主な内容 (計画が指定した4シナリオ + 要件):

| グループ | 検証したこと |
| --- | --- |
| **定義順序** (要件2) | `expo-router/entry` の評価**時に** `TaskManager.isTaskDefined('app-foundation.sync-drain')` が true — index.ts の import 運行順でタスク定義がRouterより先であることを実行時証明 |
| **OS登録** (要件2) | Available → `registerTaskAsync(name, {minimumInterval:15})`; Restricted → `'unavailable'` でregisterTaskAsync**呼ばず**; throw → `'failed'` で例外を出さない (Expo Go/シミュレータで壊れない) |
| **ハンドラ→同一claim経路** (要件2) | 捕獲したTaskManagerハンドラを呼び出し → 共有lifecycle → **本物の `queue.claim`** 経由で送信 Success; drainエラー時 Failed; `runBackgroundSyncNow` 同樣 |
| **前景/背景同時送信** (計画) | (a) 同一lifecycleへの `drain('foreground')`+`drain('background')` 同時発火 → 各操作IDちょうど1回; (b) **独立した2つのlifecycle** (画面泵 vs バックグラウンド) が同一キューで競合 (送信を遅延させて両方in-flight化) → 2操作とも1回のみ・`attempts===1` ( guarded claim が二重送信を防ぐ ) |
| **復帰トリガー** (要件2) | `start()` の初期前景ドレイン → `AppState 'active'` → ドレイン; 接続 `false→true` → ドレイン; 連続 `true` は再ドレインしない (復帰のみ); `stop()` で送信停止 → `start()` で再開; detach でリスナー解除 |
| **認証失効で停止** (要件2) | セッションnull → `no-session` で**送信ゼロ**・行不変; セッションが別アカウントに切り替わっても元アカウントの行は触らず (`claim` はアカウント結合)、同一資格の復帰後に1回だけ送信 |
| **タスクキル** (計画) | claim後に"死亡"し未settle → リース内は**再送しない** (他ワーカーの可能性) → `SEND_LEASE_MS`超過後に `結果確認中` 経由で**同一操作ID**で再送 (attempts=2・行は1件・新規IDを作らない = サーバー冪等) |
| **24時間期限** (計画) | 超過後は**自動実行ゼロ**で `needs_confirmation` へ; `retryAsNew` で**新しい操作ID**・同一ペイロードで送信、旧IDは `superseded` |
| **ログアウト5順序** (要件3) | `confirm → stop → invalidate → discard → purge → resume` の**厳密な順序** (失効呼び出し時にpendingマーカー在りをassert)、要約 `{unsent:1, inFlight:1}` (未送信と送信中の別々説明); 拒否時は `confirm` のみで何も触らない; purge後も**テーマ (端末スコープ) は残存**、アカウント設定は消える |
| **オフライン境界** (要件4) | transient失効 → `'pending'`: **discard/purge未実行**・セッション保持・マーカー保存; マーカー在り中は**全drainが halted-pending-logout** (オフラインログアウト後に再送しない); 接続復帰 → ゲートが invalidate→discard→purge→マーカー消去 を完遂し**それでも送信しない**; 指紋不一致 (同一アカウントの再ログイン) は purge のみで**セッション破棄せず**、別アカウントのセッションも絶対に破棄しない |
| **ログアウト中の応答** (計画) | 送信in-flight中にログアウトがpurge → 迟れて戻った `ok` 応答は `applySendResult → null` (**復活ゼロ**: 行0件・新規行なし)、以降のドレインは `no-session` で送信ゼロ、テーマは保持 |

### 実機試行 (実dev build + 実Metro — 実測できたこと)

手順: (1) prebuild+`expo run:ios` で新ネイティブモジュール込みビルド → (2) Metro 起動 → (3) terminate+launch で cold start → (4) Metroコンソールの `[sync]` ログ取得 → (5) スクリーンショット。

| 検証項目 | 期待 | 実測 |
| --- | --- | --- |
| 新パッケージ込みの実dev build | ビルド成功 | **Build Succeeded (0 errors)**、`Podfile.lock` に ExpoBackgroundTask/ExpoTaskManager/ExpoNetwork |
| Task 20 起動経路 (defineTask → Router → index本文) | クラッシュなく起動 | `iOS Bundled … index.ts (1662 modules)` → **ログイン画面到達** — `docs/testing/screenshots/task-20/01-launch-login-guard.png` / `02-final-code-login-guard.png` |
| 起動時drainが**実機の実SQLite・実pending-logoutゲート・実セッション判定**を完走 | 段階ログが最後まで到達 | 計装版の実機ログ: `[sync] index: starting lifecycle` → `[sync] lifecycle.start()` → `[sync] drainOnce(foreground) enter` → `[sync] drainOnce: storage open` → `[sync] drainOnce: gate passed` → `[sync] drainOnce: account=null` → `[sync] initial drain: no-session` — **実機SQLite opened / ゲート通過 / セッションなしで送信せず停止** を実測 |
| リスナーも同一のdrain経路を使う (要件2) | 接続イベントが別の送信経路を作らない | 同じ実機ログに `[sync] drainOnce(network) enter` → `storage open` → `gate passed` → `account=null` — **同一関数を経由**していることを実測 (別のsend pathは存在しない) |
| 最終コードの起動 (計装除去後) | 同上 | `[sync] background task registration: unavailable` + `[sync] initial drain: no-session` を実機で取得 — `02-final-code-login-guard.png` |
| OSへのバックグラウンド登録 | 非対応環境では no-op | **実OSの回答は `unavailable`** (iOSシミュレータは BGTaskScheduler 非対応: SDK57ドキュメント「The Background Tasks API is unavailable on iOS simulators」) → `registerTaskAsync` は呼ばず、復帰ドレインで代替。仕様「OSが許す範囲で試行し、実行されなければ次の復帰で再開する」に整合 |

### 設計境界の記録 — オフラインログアウトと配信済みOS通知 (要件4)

**事実 (実機+実装):**
1. **オフラインログアウトはサーバーへ即時通知できない。** 端末失効 (`device-session` unregister) はTask18契約上**認証必須** (401 without session)。オフライン時に先にローカルのセッションを破棄すれば失効を送れないため、本実装は: 未送信確認 → worker停止 → `logout.pending` マーカー保存 → 失効試行 → **transient失敗は `pending` で停止 (セッション・アカウントデータ保持)**。接続復帰のdrainゲートが 失効 → セッション破棄 → purge → マーカー消去 を完遂する (jest: 「オフラインログアウト境界」4件)。
2. **配信済みOS通知は取り消せない。** OS通知センターはアプリの制御外。

**仕様照合 (`docs/sdd/specs/2026-09-25-app-foundation-friends-ui-design.md` §オフライン106-107行・§通知109-116行) → 衝突なし:**
- 107行「ログアウト後はそのアカウントの自動送信と通知配信を停止」— 本実装は**ログアウト完了を端末失効成功の時点と定義**している (失効できない間はログアウト未完了=pending)。完了した瞬間に通知配信・自動送信・ローカル消去がすべて停止するため条件は充足。自動送信は**確認直後から**停止 (worker停止) しており、仕様の要求を前倒しで満たす。
- pending中は114行「許可済みでログイン中の全端末に配信する」が字義どおり成立する (セッション保持 = ログイン中)。
- 配信済み通知の**取り消し**は仕様が要求しない (停止は将来の配信についてのみ; 拒否・期限切れのプッシュ対象も§通知111行で定義済み) → 矛盾なし。
- 残余境界として記録: (a) pending窓 (オフライン確認〜接続復帰) ではこの端末への配信が継続し得る、(b) 配信済みOS通知は取り消せない。**いずれも仕様が要求する「ログアウト後」の停止条件には抵触しない**ため、本タスクは完了とする。

### device-pending (今回実測できない項目・理由)

| 検証項目 | 状態 | 理由・代替検証 |
| --- | --- | --- |
| BGTaskScheduler によるバックグラウンドタスクの実OS実行 | **DEVICE-PENDING** | **iOSシミュレータは Background Tasks API 非対応** (SDK57ドキュメント明記)。実機の実OS回答が `unavailable` であることは実測済み (上表)。タスクの実スケジュール実行・`triggerTaskWorkerForTestingAsync` (アプリ内呼び出し要) は物理端末が必要 — タスク21の `npx expo run:ios --device` 範囲 |
| オフラインログアウトの対話的E2E (実機で確認→機内モード→復帰で完遂) | **DEVICE-PENDING** | (1) 実セッションが必要だが実OAuthはUI入力を要し (タスク10のBLOCKED条件)、headlessシミュレータで完了不可、(2) ログアウトUI (マイページ入口・確認ダイアログ) は今回のファイル範囲外。実行経路の完全検証はjest27件 (5順序・pending保持・復帰完遂・ゲート遮断・指紋/アカウントガード) で実施 |
| 配信済みOS通知「取り消せない」の目視確認 | **DEVICE-PENDING** | 実配信が無い (タスク19のproject id欠如)。OSの仕様上の事実として上記に記録 |
| 物理端末でのオフラインログアウト境界記録 | **DEVICE-PENDING** | 物理iPhone (00008120-…) は未署名ビルド導入・ロック解除入力が必要でこの環境から操作不可。タスク21の `--device` 実行時に同じ境界を再記録する |

### 検証中に判明した環境問題と対処 (再発時に再利用可)

1. **Metro (`expo start --localhost`) が `[::1]:8081` (IPv6 loopback) にのみ bind** し、アプリが接続する `127.0.0.1` (IPv4) から拒否され「Could not connect to development server」に到達。→ `npx expo start --port 8081` (全インターフェース) に変更して解決。
2. **watchman の recrawl 警告 (`MustScanSubDirs UserDroppedTo`) で Metro が変更を検知せず、同一バイト数の古いバンドルを配信し続ける** (curl で新ロジック文字列が入っていないことを確認)。→ `watchman watch-del /Users/h-uma/orca/projects/yu_lu` + `watch-project` + Metro再起動で解決。**JS変更が実機に反映されないときはまずbundleをcurlして文字列確認**すること。
3. `simctl launch` は**既存プロセスでは再起動しない** (同一PID)。cold launch は必ず `simctl terminate` → `simlaunch` の順 (タスク19と同じ)。
4. 既存のMetro (別タスク起動分, pid95769) が8081を掴んでいた → `kill` してから再起動。

### 既知の無害なコンソール

- `expo-notifications` の Expo Go push廃止に関する `console.warn` — `auth/logout → notify/registration → expo-notifications` のimport連鎖により、index.ts を import するスイート (scaffold / sync-lifecycle) で各1回出る (実行結果に影響なし)。
- 起動時の `[sync] background task registration: unavailable` / `[sync] initial drain: …` は **__DEV__専用の診断ログ** (機証用。本番では出ない)。

---

## Task 19: 通知受信・画面更新・外部入口の統合 (2026-09-27 JST)

### 環境

| 項目 | 値 |
| --- | --- |
| Mac / Xcode | Xcode 27.0, macOS 27 |
| シミュレータ | iPhone 18 Pro / iOS 27.0 (UDID 7072095A-…、Boot済み)。**Simulator.app (GUI) はこの環境に存在しない** (`/Applications/Xcode.app/Contents/Developer/Applications/` 無し) — タップ入力が使えない |
| JS | Metro localhost:8081 稼働 (`/status` → 200)。実dev buildへTask 19のJSを流し込み `xcrun simctl launch 7072095A-… com.anonymous.app --initialUrl "exp+app://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"` で起動 |
| 入力手段 | **無** — GUI不在 + `idb` / `fb-idb` 未導入 + ヘッドレス運用 (タスク16と同じ制約) |

### JS層 (モック層 — MOCKED-LAYER)

```
$ npm --prefix app test -- --runInBand __tests__/notification-entry.test.tsx → 22 passed
$ npm --prefix app test -- --runInBand → 33 suites / 585 tests 全通過 (タスク19で +22)
$ npm --prefix app run typecheck    → 0 errors
```

- **権限拒否**: OSプロンプトは有効化ボタン (`friends-notify-enable`) の操作時のみ。起動・読込では prompt / トークン取得 / device-session 登録のどれも呼ばない。拒否時は `friends-notify-denied` を出し、トークン取得・登録はゼロ、`申請を確認` の入口は残存。
- **2端末**: 同一アカウントの別インストール (別SQLite) がそれぞれ device-session へ登録され device_id が分かれる。同一トークンの再有効化は transport を二度叩かず `alreadyRegistered` (冪等)。許可済みなら prompt を挟まない (`get` のみ)。
- **前景**: 抑止ハンドラが `{shouldShowBanner, shouldShowList, shouldPlaySound, shouldSetBadge}` すべて false (SDK 57 形状)。到着では `notify-in-app-notice` を表示し (タップ/5秒で消える)、`list_requests` の pending 件数を読み直して `friends-unread-count` を更新、**画面は移動しない** (移動はタップ時のみ)。
- **背景タップ**: `/friends/requests?tab=incoming&focus=<request_id>` へ遷移し `request-focus-badge` (通知から開いた申請) を表示。
- **終了状態 (cold)**: `getLastNotificationResponse` → 実行中応答と**同一の処理経路**。既読idはアカウント別SQLite (`notify.seen_ids`) に永続し、プロセス再起動後 (インメモリ破棄後) の同一通知は duplicate で再処理されない。
- **古い通知**: pending → 対象行へfocus、終了済み → `requests-entry-ended` 説明 + focus、期間切れ (一覧に無し) → `requests-entry-stale` 説明で**失敗しない**、検証不能 (オフライン) → 画面既存の状態へ。サーバ確認 (`list_requests`) はナビゲーション**より前**。
- **重複callback**: 同一通知の2回目は headless・実ルーターの両方で1回しかナビゲーションしない (サーバ状態が変わっていても再遷移・stale追記なし)。
- **招待/OAuth混同なし**: 通知の `url` ペイロードは `notification-carries-url` で拒否 (招待/OAuth経路へ流れない)、招待URL起動時は通知応答を種付けせず入口を奪わない、URLはパス優先分類でクエリに `code` が付いても型が反転しない、`/invitation*` `/auth/*` `/login` `/register` 中は通知エントリを保留。
- **未登録**: cold応答は登録画面で**既読化せず保持** → 登録完了後、サーバ確認を経て申請一覧へ (テストID: `requests-entry-ended` / `requests-entry-stale` / `request-focus-badge`)。
- **編集下書き**: 通知タップで `/friends/requests` へ移動しても `profile.edit` 下書き行は失われない。

### 実機試行 (実dev build + 実Metro — 実測できたこと)

手順: (1) Metro稼働確認 (`/status`=200) → (2) 実dev buildをTask 19のJSで launch → (3) ディープリンク `app:///friends` を openurl → (4) スクリーンショット取得。

```
$ xcrun simctl launch 7072095A-… com.anonymous.app --initialUrl "exp+app://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"
com.anonymous.app: 51186
$ xcrun simctl openurl 7072095A-… "app:///friends"   → iOS確認ダイアログ '"app" で開きますか？' が出現
```

| 検証項目 | 期待 | 実測 |
| --- | --- | --- |
| 実dev buildでのTask 19 JS起動 | クラッシュなく起動 | **起動成功 (pid 51186)**、Metroから新JSをロードしルートレイアウト (NotificationHost = 実expo-notifications import) まで到達、クラッシュ/デッドログなし — `docs/testing/screenshots/task-19/01-launch-login-guard.png` |
| 起動時にOS許可プロンプトが出ないこと | 出ない | 起動〜ログイン画面表示までの間、プロンプトは**発生していない** (01)。ただし有効化ボタンの押下自体は入力不能で未実施 (下記 device-pending) |
| `/friends` へのディープリンク | 友達タブへ遷移 | 系統の確認ダイアログで停止 — **タップ手段が無く先へ進めない** — `02-deeplink-confirm-dialog.png` |
| 認証状態 | セッションあり前提 | **セッション無効でログイン画面** (01) — 認証ガードが友達タブを遮断。実OAuth完了にもUI入力が必要でこの環境では完了不可 |

- 対応するJS層の検証は上記MOCKED-LAYERの22件。**実機で確認したのは「実dev buildがTask 19のJSでクラッシュなく起動し、起動時に許可プロンプトが出ないこと」のみ**。実プッシュの配信・タップ遷移は一切主張しない。

### device-pending (今回実測できない項目・理由)

| 検証項目 | 状態 | 理由・代替検証 |
| --- | --- | --- |
| 有効化ボタン押下 → 実OS許可プロンプト → 許可/拒否の実機挙動 | **DEVICE-PENDING** | この環境にSimulator.app GUIが無く (Xcode 27に同梱アプリが存在しない)、`idb` も未導入のためタップ入力が存在しない。加えてセッション無効で認証ガードを突破できず (実OAuthもUI入力が必要)、友達タブ自体に到達できない。jestでプロンプトが出る経路 (get→request) と拒否時のUI・入口残存を実測済み |
| 実pushトークン取得 (`getExpoPushTokenAsync`) | **DEVICE-PENDING** | `app/app.json` に `extra.eas.projectId` も `expo-notifications` プラグイン設定も無く、`app/eas.json` は未作成 (タスク21で作る予定)。**EAS資格情報が提供されていない**ためSDK 57がproject idを推定できずトークン取得は失敗する。jestではトークン失敗 → `token-unavailable` の国内語フォールバックと登録ゼロを検証済み |
| 実プッシュ配信 (2端末・前景/背景/終了状態) | **DEVICE-PENDING** | (1) 上記の資格情報欠如で送信側も受信側もトークンが無い、(2) **iOSシミュレータはAPNs受信不可**、(3) この環境に物理のiOS/Android端末が無い。Task 22の実機範囲に留める |
| 配信済み通知のタップ → エントリ遷移の実機挙動 | **DEVICE-PENDING** | 配信された通知が無いとタップが発生しない (上記に同じ)。応答経路はjestで cold / 背景タップ / 重複 / 未登録保持 / 古い通知 / 招待OAuth非混同 の全分岐を実測 |
| 前景受信時のOSバナー抑止とアプリ内案内の実機表示 | **DEVICE-PENDING** | 前景受信を作るには実配信が必要 (上記に同じ)。抑止ハンドラの戻り値 (全false) と案内・件数更新の配線はjestで実測 |

- 既知の無害なコンソール: ルートツリーを実際にjestで描画するスイートでは、`_layout → NotificationHost → expo-notifications` のimport連鎖により Expo Go の push 廃止に関する `console.warn` がスイート1件につき1回出る (実行結果に影響なし)。また `invitation-flow` の `act(...)` 環境エラー21件は**タスク19以前からベースラインと同数** (ワークチェックで増分ゼロを確認)。

---

## Task 16: プロフィール画像処理と永続化 (2026-09-26 JST)

### 環境

| 項目 | 値 |
| --- | --- |
| Mac / Xcode | Xcode 27.0, macOS 27 |
| ネイティブビルド | `npx expo run:ios --no-bundler` (Debug, dev client) — `expo-image-manipulator` 追加後に再ビルド成功 (0 errors、末尾のosascript警告はタスク8と同じ表示手順の失敗のみ) |
| シミュレータ | iPhone 18 Pro / iOS 27.0 (UDID 7072095A-…、ヘッドレス) |
| JS | Metro localhost:8081 (既存プロセス)。起動は `xcrun simctl launch <udid> com.anonymous.app --initialUrl "exp+app://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"` (タスク8と同じ手順) |
| プローブ | `app/src/media/avatarProbe.tsx` — `Documents/avatar-probe.enabled` 存在時のみ起動 (storage-probe と同じ方式・レンダリングは無し)。ヘッドレスでタップできないため、入力は埋め込みfixture (透過PNG 1600×1200 / EXIF Orientation=6 JPEG 320×240、`avatarProbeFixtures.ts`) を使用 |

### JS層 (モック層 — MOCKED-LAYER)

```
$ npm --prefix app test -- --runInBand src/media/avatar.test.ts        → 40 passed
$ npm --prefix app test -- --runInBand src/media/AvatarPicker.test.tsx →  6 passed
$ npm --prefix app test             → 31 suites / 540 tests 全通過 (タスク16で +46)
$ npm --prefix app run typecheck    → 0 errors
```

- **形式判定**: MIME別名 (`image/jpg`・パラメータ付き) 受理、MIME欠落時はファイル名→URI拡張子、**MIMEがあれば偽装拡張子より優先** (`.jpg` のGIFは拒否)、拒否文言に JPEG・PNG・HEIC を明記。
- **10MB境界**: ちょうど10MB受理 / +1byte拒否 (`media/images.ts` の `validImageSize` と同一値) / `fileSize` 欠落時はファイルシステム実サイズ。
- **ステージ順** decode → fit → flatten → encodeJpeg。**透過は必ずJPEGより前に白合成** (合成入力はgeometry適用後の画像)。EXIFはdecode後の寸法からgeometryを計算し二重回転しない (decodeは1回だけ)。
- **キャンセル**: `source=null` は読む・書く・消すすべての前で `canceled` を返す。UIではエラー表示なし・下書き変更なし・onChangeなし。
- **失敗で旧下書き保持**: decoder例外・透過合成失敗・ENOSPC (コミットコピー)・1024超過の出力・下書き書込み失敗のそれぞれで、下書き行と旧ファイルが不変。下書き書込み失敗時はコミット済みファイルをロールバック (参照と下書きは不変のまま)。
- **順序**: コミット→下書き (実呼び出し順をテストで固定)、コミット失敗時は下書き書込み自体が無い。差し替え成功時は旧stagedファイルを回収。
- **再起動復元**: DBを閉じて開き直すと同一参照を読込、破損した下書きbodyは「画像なし」に退避して例外にしない。
- **削除**: 下書き行を先に消してからファイルを削除 (削除失敗時は一時ファイル残存のみで参照切れにならない)。公開済み画像 (別の参照) は一切触らない。
- **UI配線**: カメラ権限拒否は説明のみでカメラを起動しない、形式拒否はエラー通知で表示、削除後は `onChange(null)` かつ削除ボタン無効化。

### 実機実測 (iOS・実ネイティブモジュール・実SQLite・実ファイルシステム)

手順: (1) フラグ配置→プロセス#1起動→ログ取得、(2) `simctl terminate` (rc=0・プロセス消滅確認) →プロセス#2起動→復元ログ取得、(3) 出力画像を端末からコピーして `sips` で画素確認、(4) 検証後にフラグ・ログ・fixture・プローブ画像を端末から削除し、フラグ無しで再起動して成果物が増えないことを確認。

```json
# プロセス#1
{"phase":"restore","draft":null,"draftExists":false,"draftBytes":0}
{"phase":"exif-decode","source":"320x240 jpeg, EXIF Orientation=6","width":240,"height":320,"normalized":true}
{"phase":"commit","status":"committed","width":1024,"height":1024,
 "relativePath":"images/__avatar_probe/070ef2e1-….jpg","bytes":27226,
 "stages":{"decode":{"ok":2},"fit":{"ok":2},"flatten":{"ok":1},"encodeJpeg":{"ok":1},"commit":{"ok":1}}}
# プロセス#2 (terminate rc=0 → プロセス消滅確認 → 再起動)
{"phase":"restore","draft":"images/__avatar_probe/070ef2e1-….jpg","draftExists":true,"draftBytes":27226}
```

| 検証項目 | 期待 | 実測 |
| --- | --- | --- |
| EXIF回転 (320×240, Orientation=6) のdecode寸法 | 240×320 | width 240 × height 320、`normalized: true` — **向き補正を実ネイティブで確認** |
| 透過PNG (1600×1200) の確定結果 | 1024×1024 JPEG | `committed`、**1024×1024**、27,226 bytes、`images/__avatar_probe/….jpg` |
| 出力の4隅画素 (透過だった箇所) | 白・不透明 | topLeft/topRight/bottomLeft/bottomRight すべて **(254,254,254)・alpha 255** (JPEG量子化による1の差のみ) |
| 出力の中央画素 | 画像内容が残る | **(219,40,40)** — fixtureの不透明赤コア (220,40,40)。白合成であって白紙ではないことの確認 |
| 終了→再起動後の読込み | 前回の下書き参照+実ファイル | terminate rc=0・プロセス消滅確認後、プロセス#2が `070ef2e1-….jpg` を復元、`draftExists: true`・27,226 bytes |
| 差し替え後の旧staged回収 | 旧ファイル削除 | 差し替え後に `images/__avatar_probe/` は新ファイル1件のみ |
| フラグ削除後の再起動 | プローブ無動作 | avatar-probe の成果物ゼロ (フラグゲート確認) |

- ステージ所要時間 (実機): decode 13〜42ms / fit 41〜43ms (二段) / flatten 68〜72ms / encode 4〜5ms / commit 5〜9ms。
- **検証中に判明し修正した点**: iOS の `UIGraphicsImageRenderer` は**画面スケールでラスタライズ**するため、1024² 要求のSVG合成が 3072² (3×) になり、最初の実行はコミット前検査で拒否された (全ネイティブステージは成功)。対処として合成PNGのIHDRから実寸を読む `pngDimensionsFromBase64` と、合成後に1024キャップを再適用するステージを追加 (`src/media/avatar.ts`)。iOS base64の改行は除去してから書き込む。修正後の同一環境で `committed` まで到達。

### device-pending (今回実測できない項目・理由)

| 検証項目 | 状態 | 理由・代替検証 |
| --- | --- | --- |
| OSピッカー/カメラUIでの撮影・選択 (正方形切り抜き画面) と実写真ライブラリの操作 | **DEVICE-PENDING** | Xcode 27ヘッドレスシミュレータはタップ入力が無くOSピッカーUIを操作できない。加えてAvatarPickerはタスク17で初めて画面へ配線され、本タスク時点で到達可能なルートが無い。jestではキャンセル・権限拒否・形式拒否・削除の配線を実測 |
| ピッカー出力そのものの向き (ピッカーがEXIFを焼き・タグを外すこと) | **DEVICE-PENDING** (ソース確認のみ) | ピッカーUIが操作不能なため実測不可。expo-image-picker のソースで iOS `fixOrientation()` / Android `copyExifData` が `TAG_ORIENTATION` を除外することを確認。本プローブはその「タグが付いていない/焼き済み」入力を扱うdecode段階を実機で確認 |
| Android の白背景合成・寸法・EXIF | **DEVICE-PENDING** | この環境にAndroidビルド/実機が無い (タスク14と同じ外部条件)。`SvgView.toDataURL(w,h)` は指定寸法のBitmapを使う実装 (ソース確認) で、合成も含め同一コードをjestで通している |
| 物理端末でのカメラ撮影 | **DEVICE-PENDING** | タスク21/22の実機パスへ |

- JS層の46件はすべてMOCKED-LAYERの下、**実機で白背景・寸法・再起動読込みを確認したのは上記のプローブ実測のみ**。モックを実機成功の証拠にはしていない。

---

## Task 15: 招待Web入口とドメイン関連付け (2026-09-26 JST)

**すべてローカル検証・未公開。** 実HTTPSドメイン・実bundle id・実署名・実ストアIDは
未提供のため、配信・関連付け・ストア遷移の実測は行っていない (手順のみ
docs/operations/app-foundation-friends-ui.md Task 15 節に記載)。
以下に現れた `example`/`example.test` 値は**テスト専用fixture**であり、公開値ではない。

### 検証コマンドと実測

```
$ node --test scripts/invite-web.test.mjs
ℹ tests 25  ℹ pass 25  ℹ fail 0   (exit 0)

$ node scripts/build-invite-web.mjs            # 値なし → 失敗 (期待どおり)
error: missing required invite web inputs: INVITE_ORIGIN, IOS_BUNDLE_ID,
APPLE_TEAM_ID, APP_STORE_ID, ANDROID_PACKAGE, ANDROID_CERT_SHA256. …   (exit 1)

$ node scripts/build-invite-web.mjs --test-config --out <tmp>
invite web build OK [TEST-ONLY (do not publish)]                      (exit 0)

$ npm --prefix app run typecheck   → 0 errors (app/app.config.ts を含む)
$ npm --prefix app test            → 29 suites / 494 tests 全通過 (増分なし)
$ cd app && npx expo config --type public  (INVITE_ORIGIN なし) → exit 0・追加なし+
  stderr「INVITE_ORIGIN not set — skipping …(no domain was invented)」
$ INVITE_ORIGIN=https://invite.invite-web.test npx expo config --type public → exit 0・
  ios.associatedDomains=['applinks:invite.invite-web.test'] +
  android.intentFilters(autoVerify, https, host同値, pathPrefix=/invitation, BROWSABLE/DEFAULT)
$ INVITE_ORIGIN=http://insecure.example npx expo config --type public → exit 1 (明確なエラー)
```

### `scripts/invite-web.test.mjs` の主な内容 (25件)

- **入力検証**: 6変数すべて欠落→一括列挙で失敗 / 部分欠落→残りのみ名指し /
  不正値 (http・path付きorigin・port・非bundle id・10桁以外のteam id・非数値store id・
  不正package・64桁でないSHA) で失敗。 originは正規化 (末尾スラッシュ除去)、
  SHAはコロン除去+小文字化。既定値・偽値の自動補完は一切なし。
- **出力検証**: `--test-config` で7ファイル生成 (TEST-ONLY-OUTPUT.txt 含む・
  DO NOT PUBLISH バナー)、実値相当envでの生成はマーカーなし。静的3ファイルは
  `invite-web/` の原文コピー。AASA `appID`/`paths: ['/invitation/*']`、assetlinks の
  `package_name` + `sha256_cert_fingerprints` が検証済み入力と一致 (JSON・末尾改行)。
- **app.js 安全性**: `.innerHTML` / `.outerHTML` / `insertAdjacentHTML(` /
  `document.write(` の使用ゼロ・`textContent` のみ (トークンをHTML挿入しない)。
- **実ページ (生成済み runtime-config + app.js を vm 実行)**:
  - Android: Play URL の `referrer` デコード値が `invitation=<urlencoded 32hex>` と
    完全一致 (Task 14 の `parseInstallReferrer` が読む形)。タップで遷移。
  - iOS: 読み込み時はコピーなし → タップ内で書込み → 成功後にのみ App Store へ遷移、
    失敗時は遷移せず再試行ボタン+URLの再開案内を表示、clipboard非対応も説明のみ。
  - runtime-config 欠落・不正トークン → 説明文を表示 (パネル非表示・トークン露出なし)。
  - テスト専用出力には日本語バッジ表示。
- **expo config 両状態**: 値なし→成功・domain追加なし (既存 app.json 値と
  `enableSceneSupport: true` 維持) / INVITE_ORIGINあり→両OSに同値反映 /
  不正値→非0で失敗。

### 未検証 (外部入力待ち・BLOCKEDではなく外部依存)

- 実HTTPS配信・associationファイルのリダイレクトなし・署名一致・実ストアURL・
  実Play referrer/実iOS貼り付けのE2E → 手順は運用手順書。**公開済みとは記録しない。**

---

## Task 14: 招待保存・QR・iOS貼り付け・Android取得 (2026-09-26 JST)

### JS層 (モック層 — MOCKED-LAYER)

```
$ npm --prefix app test -- --runInBand __tests__/invitation-flow.test.tsx
Test Suites: 1 passed, 1 total
Tests:       44 passed, 44 total   (3回連続で同結果、actリークなし)

$ npm --prefix app run typecheck   → OK (0 errors)
$ npm --prefix app test            → 29 suites / 494 tests 全通過 (タスク14で +44)
```

`__tests__/invitation-flow.test.tsx` (**MOCKED-LAYER**: `backend/queries` = 読み取りワイヤ、
`sync/api` = コマンドワイヤ、端末DBは実SQLite、
camera/clipboard/install-referrer/image-picker はネイティブモック) の主な内容:

- **リンク構築/解析**: `<origin>/invitation/<32hex>` の構築、`EXPO_PUBLIC_INVITE_ORIGIN` 欠落時は
  名前付きエラー (偽ドメインを作らない)、URL/ディープリンク/生パスの3形態、不正URLは null。
  Install Referrer は**許可した `invitation` パラメータのみ**を読み (utm_* 等は無視、
  有効な32hexが他のパラメータにあってもトークンにしない)、完全URLとは限らない値 (クエリ文字列・
  生パラメータ) を解析。貼り付けも同様 (空=none/乱文=invalid は説明のみ)。
- **QR**: URLから `qrcode-generator` で行列を生成 (奇数サイズ・決定的・URL変更で行列変更)、
  `qrPath` で1本のSVGパスに変換 (ダークモジュール数と一致)。パネルは `invite-qr` としてSVG描画。
- **別招待 (keep-first)**: 実SQLiteで 初回の招待を維持・期限切れ初回のみ置換・破損行は削除して
  続行 (復元不能でも登録を止めない)・OAuth後に pre-login 行をアカウントへ移動 (アカウント既存の
  ライブ招待が優先、pre-login バケットは空になる)・同一トークンのみ resolution 記録。
- **スキャナ**: カメラの不正コードは説明のみ (emitなし)、有効コードは**1回だけ** latch、
  `active=false` (画面非表示) でカメラごと消える、権限拒否は説明+画像フォールバック、
  保存画像は 複数コード/不正URL/空/ネイティブ失敗 をすべて文言で説明し例外を投げない、
  OSキャンセルはエラー扱いしない。
- **インストール引き継ぎ**: Android = referrer をマウント毎に1回だけ読み、
  許可パラメータを解析 (無いインストール=UIなし、`ERR_APPLICATION_INSTALL_REFERRER_*` =
  無音で継続、不正値=説明のみ)。iOS = `ClipboardPasteButton` + 近接説明、
  **children/title でOSラベルを上書きしない**、`getStringAsync` が一度も呼ばれない
  (起動時の自動読取りなし)、iOS<16 は描画なし。
- **招待パネル (inviter側)**: 有効リンクは再利用 (マウントでコマンド0回)、origin未設定は
  明確なエラー、status none は明示発行ボタン、expired は自動発行、
  手動再発行は確認画面 (確認なしではコマンド0回) + 同一フレームの二重タップでも
  `reissue_invitation` は**1回だけ** (競合封じ) + 旧リンクは新リンクで置換、
  オフラインはキャッシュ+取得時点表示+再発行ボタン非表示、成功結果はアカウント別キャッシュに保存。
- **確認ルート**: valid=確認カード+案内済み記録 (`mark_onboarding_seen`)+申請
  (`request` + `invitation_token` + `target_user_id` をキュー経由で送信)、
  invalidated/expired=失効・期限切れ表示 (申請ボタンなし)、404=見つかりません、
  不正トークン=ネットワークに触れずローカル説明、オフライン再起動=取得時点のキャッシュ表示
  (現在の有効性は未確認と明示・申請不可)、オフライン+キャッシュなし=説明+再試行で回復。
- **認証をまたぐ復元**: ログイン中保存 (pre-loginバケット) → OAuth成功後に
  **同じ確認画面へ戻る** (post-authターゲット) + pre-login行がアカウントへ移動、
  OAuth callback 深リンクでも復元、登録後は /home ではなく **/invitation/&lt;token&gt; へ**
  (招待経則・ターゲットは1回だけ消費)、招待なし登録は従来どおり /home。
- **友達追加画面配線**: 招待QR表示/QR読み取りのトグル、画像から読み取った1件の招待で
  確認ルートへ遷移、`focused=false` でカメラが消える (画面非表示時はカメラ停止)。

### ネイティブ挙動 (device-pending — 実機/実OSでの未検証項目)

| 検証項目 | 状態 | 理由・代替検証 |
| --- | --- | --- |
| 実カメラでのQR読取り (CameraView プレビュー・フレーム走査) | **DEVICE-PENDING** | Xcode 27ヘッドレスシミュレータはタップ入力がなくGUI操作不可 (タスク8/10と同じ制約)。jestではネイティブモック経由で走査コールバック・権限拒否・latchを検証済み。タスク21/22の実機パスで確認 |
| `Camera.scanFromURLAsync` の実OS画像デコード | **DEVICE-PENDING** | 同上。モックで URI 引数 (`file:…`, `['qr']) と結果分類を検証済み |
| iOS `ClipboardPasteButton` (UIPasteControl) の実表示・実貼り付け | **DEVICE-PENDING** | 同上。モックで children なし (OSラベル非改変)・明示 onPress のみ・`getStringAsync` 非呼び出しを検証済み |
| Android `Application.getInstallReferrerAsync` の実Play Store値 | **DEVICE-PENDING** | Androidビルド/実機が本環境に無い。許可パラメータ解析 (クエリ文字列/生パラメータ/完全URL) はjestで実測、SDK 57ドキュメントの「完全URLとは限らない」形をカバー済み |
| 実機カメラ画面非表示時のセッション停止 (バックグラウンド等) | **DEVICE-PENDING** | jestでは `active=false` でカメラコンポーネントがアンマウントされることを検証済み。実セッション停止はタスク21/22の実機パスで確認 |

- JS層の44件はすべて MOCKED-LAYER。実機カメラ・貼り付け・Install Referrer の成功を
  **主張しない** (上記のとおり device-pending として記録)。

---

## Task 11: モノトーンUI・テーマ・可変レイアウト (2026-09-26 JST)

### 環境

| 項目 | 値 |
| --- | --- |
| iOS dev build | `npx expo run:ios --no-bundler` (Xcode 27.0), bundle `com.anonymous.app` |
| シミュレータ | iPhone 18 Pro / iOS 27.0 (UDID 7072095A-…) — **ヘッドレス** (Simulator.app なし = タスク8/10と同じ制約) |
| Metro | `npx expo start --port 8081` + `app/.env` (EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321, EXPO_PUBLIC_SUPABASE_ANON_KEY=<ローカルanon key>)。ローカルSupabaseは起動済み |
| app.json | `userInterfaceStyle` を `light` → `automatic` に変更 (端末設定に追従するため)。`ios.enableSceneSupport: true` は維持。生成済み `ios/app/Info.plist` の `UIUserInterfaceStyle` もローカル成果物として `Automatic` に修正して再ビルド |
| ヘッドレス時の工夫 | openurl による起動確認ダイアログはタップ不可 → `launchctl kickstart -k user/501/com.apple.SpringBoard` で解除。dev-menu 初回案内はローカル成果物の Info.plist `EXDevMenuIsOnboardingFinished=YES` (タスク8と同じ扱い)。外観・文字サイズの変更は SpringBoard 再起動後にアプリへ反映 |

### JS層 (モック層 — 実機のログイン操作を含まない)

```
$ npm --prefix app test -- --runInBand __tests__/theme-layout.test.tsx
Test Suites: 1 passed, 1 total
Tests:       32 passed, 32 total

$ npm --prefix app run typecheck   → OK (0 errors)
$ npm --prefix app test            → 25 suites / 403 tests 全通過 (タスク11で +32)
```

`__tests__/theme-layout.test.tsx` の主な内容:
- 承認済み試作Aのトークン (ライト/ダークの電話画面パレット・ボード・余白スケール・フォーカスリング) が試作HTMLと同一値であること、`.blue` 派生値を含まないこと
- 900境界: 幅899→1列+下部タブ / 幅900→左ナビ+2列。文字拡大 fontScale 1.353 (>1.3) では幅が広くても1列へフォールバック
- 2列⇄1列の切り替えで選択中の相手 (aoi_07) と下書き入力が保持される ( lifted state )
- 時間帯: 初期値 07:00/19:00、境界 (06:59/07:00/18:59/19:00)、日跨ぎ (19:00の暗転が翌07:00まで継続)、夜跨ぎのカスタム時間帯、現地時刻ロジック (getHours基準・UTC非依存)
- 同じ時刻は保存不可 (state・ストレージ共に何もしない)、不正形式は項目エラー
- 端末テーマ変更 (system モード時の light→dark 追従)、明示モードでは追従しない
- 復帰 (AppState active) 時に境界を跨いだ再評価 (18:00→翌06:30 で暗転、07:30 で復帰)
- device_settings (アカウント削除deleteAccountData後も残る) での永続化を実SQLiteで検証
- UI部品: 入力ラベル (accessibilityLabel)、ボタン role/状態/押下 (opacity 0.75)、エラーは色だけでなくテキスト (`エラー: …`) + alert、画面タイトルは header role、safe area insets
- ルート実測 (実SQLite): /mypage → テーマ入口 → 既定「端末に合わせる」→ モード永続化 → 時間帯編集 (同時刻拒否→07:00/21:00保存→不正形式拒否)

### 実機スクリーンショット (docs/testing/screenshots/task-11/)

| ファイル | 内容 | 確認できたこと |
| --- | --- | --- |
| 01-login-light-default-text.png | ログイン画面・ライト・標準文字 | 承認済みモノトーンのトークン (surface #ffffff / text #272a2e / line #e5e6e8) が実機で適用 |
| 02-login-dark-live-system-appearance.png | ログイン画面・ダーク | 端末の外観切り替えを**そのまま追従** (端末に合わせる)。surface #202225 で再描画、ダーク状態で読み取り可能 |
| 03-login-light-max-text-size.png | ライト + 最大文字サイズ (extra-extra-extra-large) | fontScale=1.353 をアプリが受領 (Metro経由の [fontprobe] 1.353 で数値確認)、文字拡大後もレイアウト破綻なし |
| 04-login-dark-max-text-size.png | ダーク + 最大文字サイズ | 暗転 × 文字拡大の複合でも読み取り可能 |

- 検証用手順: `xcrun simctl ui <udid> appearance dark` → SpringBoard 再起動 → アプリ再起動 → `xcrun simctl io <udid> screenshot`。リセットは `appearance light` / `content_size large`。

### 未取得として記録する項目 (ブロック条件)

| 検証項目 | 状態 | 理由 |
| --- | --- | --- |
| テーマ設定画面 (マイページ→テーマ) の実機表示 | **BLOCKED** | 4タブ領域はログイン後のみ到達。Apple/Google のOAuth設定が未提供 (ローカルGoTrueは `apple:false, google:false` = タスク10と同じ外部入力) でサインイン不能 |
| 幅900以上の左ナビ + 一覧/詳細2列の実機表示 | **BLOCKED** | 同上 (タブシェル自体がログイン後)。ロジックはjestで 899/900・fontScale境界・選択/下書き保持を実測済み |
| タブレット (iPad Pro 13-inch) のスクリーンショット | **BLOCKED** | インストール自体は成功したが、ヘッドレスでdev-clientのURL投入が効かず「Searching for development servers…」から先へ進めない (タップ操作なし)。2回試行して打ち切り |
| 最大文字サイズ時のタブ/左ナビ切替の実機表示 | **BLOCKED** | 上記ログイン不能に同じ。jestで fontScale 1.353 > 1.3 のフォールバックを検証済み |

- HTMLモックでの代替は行っていない (スクリーンショットはすべて実アプリ・実iOSのもの)。
- iOSモック層で確認した以外の実OAuth操作はタスク10のブロック条件を継続。

---

## Task 10: OAuth・登録画面と起動分岐 (2026-09-26 JST)

### 環境

| 項目 | 値 |
| --- | --- |
| iOS dev build | `npx expo run:ios --no-bundler` (expo-auth-session 57.0.13 / expo-web-browser 57.0.3 追加のため再ビルド), bundle `com.anonymous.app` |
| シミュレータ | iPhone 18 Pro / iOS 27.0 (UDID 7072095A-…) — **ヘッドレス** (Simulator.app が存在せず、GUIウィンドウなし。osascript・タップ操作は不可 = タスク8と同じ制約) |
| Metro | `EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321`, `EXPO_PUBLIC_SUPABASE_ANON_KEY=<ローカルanon key>` |
| ローカルSupabase | `npx supabase start` — config.toml 変更後に再起動して反映 |

### JS層 (モック層 — 実OAuthラウンドトリップは含まない)

```
$ npm --prefix app test -- --runInBand __tests__/registration-flow.test.tsx src/auth/session.test.ts
Test Suites: 2 passed, 2 total
Tests:       48 passed, 48 total

$ npm --prefix app run typecheck   → OK (0 errors)
$ npm --prefix app test            → 24 suites / 371 tests 全通過 (タスク10で +40)
```

- `__tests__/registration-flow.test.tsx` (**MOCKED-LAYER**: Supabase client・システムブラウザ・redirect URI・端末DBドライバをモック。実OAuth成功を主張しない) 40件:
  - PKCEコールバックURL・`code`/`error`の解析・招待リンクをOAuth応答と混同しないこと
  - Apple/Google の2プロバイダのみ (それ以外は例外)
  - ログイン取消 → 再試行 (同じプロバイダを保持) / 通信失敗 → 再試行 → 成功
  - 未登録ガード (/friends → /register、未ログイン → /login)、登録確認画面、ID衝突時の類似候補 (入力保持・候補は編集可能な提案)、再試行で operation id を再利用
  - アカウント別下書き (別アカウントの下書きは復元しない / 自分の下書きは再起動相当で復元 / 登録成功で削除)
  - 招待保有アカウントの確認到達で `mark_onboarding_seen` が実行される (招待なしでは実行しない)
  - cold起動 → ホーム、warm復帰 → 前回の詳細 destination、設定欠落時は明確なエラー (偽ホームなし)

### ローカルAuth実サーバーでの実測 (curl / 実supabase-js)

1. **メール登録が無効** (config.toml `[auth.email] enable_signup = false` を再起動で反映):

   ```
   $ POST /auth/v1/signup {"email":"probe2@example.com",...}
   {"code":400,"error_code":"email_provider_disabled","msg":"Email signups are disabled"} [HTTP 400]
   $ GET /auth/v1/settings → "external": {"email": false}, "disable_signup": false
   ```
   - 期待: メール登録は拒否、OAuth (グローバル) signup は維持。→ 実測どおり。

2. **コールバックURLが実サーバーのallow-listに入った**:

   ```
   GOTRUE_URI_ALLOW_LIST=https://127.0.0.1:3000,app://auth/callback,exp://*/--/auth/callback
   ```
   (config.toml `additional_redirect_urls` が実Authプロセスのenvに反映されていることを docker inspect で確認)

3. **アプリと同じ supabase-js 呼び出し (PKCE + skipBrowserRedirect) が実Authで受理される**:
   実 `@supabase/supabase-js` で `signInWithOAuth({provider, options:{redirectTo:'app://auth/callback', skipBrowserRedirect:true}})` を実行し、生成された authorize URL へ実HTTPアクセス →

   ```
   authorize URL: 127.0.0.1:54321/auth/v1/authorize?provider=github&redirect_to=app://auth/callback&code_challenge=<s256>&code_challenge_method=s256
   → 実Auth: HTTP 302 Location: https://github.com/login/oauth/authorize?...&redirect_to=app%3A%2F%2Fauth%2Fcallback&redirect_uri=http://127.0.0.1:54321/auth/v1/callback...
   ```
   - 手順: プロバイダ検証のため `[auth.external.github]` をダミーclient_idで一時有効化 → 上記を実測 → **設定は元に戻し再起動してベースラインを再確認** (`providers.email:false` / allow-list維持)。
   - 期待: PKCE code_challenge 付きで実Authがプロバイダへ302し、`redirect_to=app://auth/callback` が運ばれる。→ 実測どおり。
   - **未検証として記録**: allow-listの**執行** (redirect_to検証) はGoTrueがコールバック償却時に行うため、authorize段では許可/拒否が観測できず (evil redirectも同様に302になった)、実プロバイダのログインを経ないと到達しない。

4. **偽codeの実交換は拒否される** (callback失敗経路が実Authで機能、偽成功を作らない):

   ```
   $ POST /auth/v1/token?grant_type=pkce {"auth_code":"this-is-not-a-real-code",...}
   {"code":404,"error_code":"flow_state_not_found","msg":"invalid flow state..."} [HTTP 404]
   ```

### iOS dev build 実機 (シミュレータ)

- ログイン画面が cold start で表示される: `simctl launch … --initialUrl "exp+app://expo-development-client/?url=…"` → バンドル `iOS Bundled 1026ms index.ts (1402 modules)` → スクリーンショットで **「ログイン」+「Appleでログイン」+「Googleでログイン」のみ** を確認 (メール/パスワード入力なし)。
- dev-menu の初回オンボーディング枠はローカルビルド成果物の Info.plist `EXDevMenuIsOnboardingFinished=YES` で除外 (ソース管理外のビルド产物)。
- `simctl openurl "app://auth/callback?code=…"` → iOS側の「"app" で開きますか?」ダイアログ表示 (タスク8同様、GUI不可のため操作不能)。

### 実OAuthの成功・取消・callback中断 — ブロック条件 (モック成功での代替はしない)

| 検証項目 | 状態 | 理由 |
| --- | --- | --- |
| Apple/Google 実ログイン成功 | **BLOCKED** | Apple team ID / Google OAuth client / SupabaseプロジェクトのOAuth設定が未提供の外部入力。実Authも `Unsupported provider: provider is not enabled` (apple: enabled=false) |
| ブラウザ取消 → 再試行の実機操作 | **BLOCKED** | ヘッドレスシミュレータ (Simulator.appなし)・osascript GUI操作不可 → タップ入力経路がない |
| callback中断 (実プロバイダcode) | **BLOCKED** | 上記に同じ。偽codeでの「成功」は作らない (実Authは404 flow_state_not_foundを実測) |
| jest層の取消・中断・失敗経路 | MOCKED-LAYERとして検証済み (上記40件) | 実成功の証拠として提示しない |

### サーバーレグレッション (メール登録無効化の後)

emailプロバイダ無効は `password grant` (メール+パスワード) を拒否するため、ローカルハーネスのトークン取得を変更:
`scripts/test-local-backend.mjs` — 実Auth管理者APIで作ったユーザーに対し、GoTrueが発行するものと同じ claim 形状 (iss/aud/role/sub/exp, session_id なし) のJWTをローカル署名し、**実 `GET /auth/v1/user` で検証してから**各スイートへ渡す (検証失敗は即エラー)。

```
$ node scripts/test-local-backend.mjs --suite all        → all: 161 passed, 0 failed
$ npx supabase test db                                   → Files=6, Tests=542, PASS
$ npx deno test --allow-env --allow-net --config supabase/functions/deno.json supabase/functions/tests/ → 100 passed, 0 failed
```

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
