# ホーム・チャット — Task 22 検証記録

対象: [設計](../sdd/specs/2026-10-27-home-chat-design.md) / [運用](../operations/home-chat.md)。
以前の[基盤検証記録](app-foundation-friends-ui.md)は過去の別計画の証拠であり、今回の実機合格へ流用しない。

**状態: BLOCKED（実機マトリクス未実施）。Dockerは復旧済み。未実施を合格・skip済み完了にはしない。**
実行環境: macOS、Expo SDK57 / RN0.86.3、Xcode27.1。実測開始時計は2026-10-28 UTC（10-29 JST）。
ログはgit管理外 `.sdd/task-22-*.log`。秘密を含む可能性のあるローカルログは外部公開しない。

## 再現コマンドと環境分離

すべてリポジトリルートで実行（Expo依存確認だけapp/）。DBは `npx supabase start` で確認する。
追加migrationを作った場合だけ `npx supabase migration up --local`。既存0001–0013は変更しない。
reset、remote/linked変更、push、publish、本番スケジュール登録は行わない。

```sh
npm --prefix app run typecheck
npm --prefix app test -- --runInBand --testPathIgnorePatterns home-chat-journey.test.tsx
npx supabase test db
npx deno test --allow-env --allow-net --config supabase/functions/deno.json supabase/functions/tests
node scripts/test-local-backend.mjs --suite all
node scripts/test-chat-backend.mjs --suite all
git diff --check
```

- 通常Jestは新 `home-chat-journey` **だけ**を除外し、既存 `app-journey` は実行する。
  既存journeyは通常 `daily-chat` / 54321系専用。`app/.env` があればstatusとの一致を確認し、変更しない。
  今回はファイルが無いため、共有 `scripts/lib/local-backend.cjs` の `readSupabaseStatus()` で実ローカルの
  `API_URL` / `ANON_KEY` を取得し、Jest子プロセスだけの `EXPO_PUBLIC_SUPABASE_URL` /
  `EXPO_PUBLIC_SUPABASE_ANON_KEY` に供給した。秘密を表示せず、通常プロジェクトの設定も変えていない。
- 新しいHTTP/journeyは `daily-chat-home-chat-test` / 55320–55329 の専用runnerでのみ実行する。
  `all` はbackendとjourneyの両方を別の所有スタックで走らせ、終了時にfixture/process/stackを片付け、通常DB・コンテナ・設定・`.env`不変を監査する。
  専用資格を既存journeyへ渡さない。専用環境なしのjourney失敗をskipへ変えない。

## 自動回帰の実測

| コマンド | 実結果 |
| --- | --- |
| typecheck | 初回・修正後・交代実装者の再確認とも exit 0 |
| 全Jest（上記除外のみ、実ローカル環境供給） | 初回55 suites / 929 tests、修正後55 suites / 930 tests、どちらもexit 0（既存journeyを含む） |
| pgTAP | exit 0、16 files / 5,100 assertions、ロールバック |
| Deno | exit 0、168 passed / 0 failed |
| legacy backend all | 初回 exit 1、71 passed / 120 failed（途中からGateway 502と連鎖失敗）。診断再実行と最終の元コマンド再実行はともに191 passed / 0 failed、exit 0。初回原因は断定しない |
| dedicated chat all | **最終exit 0**、一時診断差分なしの元コマンドで2 suites / 3 tests（journey15.533秒）、backend全10群、fixture/process/stack cleanup・通常状態監査すべて成功（`task-22-all-restored-final.log`）。時間診断付きallもexit 0（`task-22-all-restored-diagnostic.log`）。以前の失敗は下記のとおり保持 |
| `node --test scripts/chat-test-stack.test.mjs` | exit 0、11 passed |
| `node --test scripts/invite-web.test.mjs` | exit 0、25 passed |
| `node scripts/check-native-config.mjs --dev` | exit 0、ローカル設定確認のみ。配布入力のINFOは配布完了ではない |
| `npx expo install --check`（app/） | exit 1、既存14依存のSDK57 patch推奨。合格ではない、依存変更なし |

初回専用journeyで、明示的「最新へ」のHTTP取得中に自動 `first_unread` 再取得が世代を進め、
ユーザーの最新移動と既読intentを破棄する競合を発見。`src/messages/repository.test.ts` に決定的な再現を追加し、
同じコマンドで **RED: 1 failed / 15 passed → GREEN: 16 passed** を確認。
明示的最新取得中だけ自動初期取得を延期し、完了後は通常回復を許可する。既読上限はその取得位置のままで、後着分を巻き込まない。
交代後も同repositoryコマンドは16 passed、typecheckはexit 0（`task-22-repository-replacement.log` / `task-22-typecheck-replacement.log`）。

### 専用allのタイムアウト調査と環境復旧

修正後の失敗ログにはEdge isolateの `CPU time soft limit reached` とearly terminationがある。
ただしJestのスタックはtest本体入口のみで、停止したawaitやCPUログとの因果関係は特定できていない。
180秒の制限や業務・権限のassertionは変更せず、推測による製品修正は追加しなかった。
交代後は `docker ps` が5分でも返らず、Docker socketへの直接 `/_ping` も3秒でtimeout。
専用runnerの再実行は最初の通常状態取得より先に進まず、30分で外側timeoutした（空の `task-22-chat-all-replacement.log`）。
再確認時にはsocket自体が存在しなくなり、同じallコマンドはsuite開始前にexit 1（`docker ps --format failed` / missing socket、`task-22-chat-all-replacement-final.log`）。Docker/OrbStackの再起動、通常スタックの停止・再設定は実施していない。
当該停止時には専用runner/serveの残存と専用lockはなかった。Docker利用不可の間はコンテナ/volume一覧とDB digestを再監査できず、当時の不変・完全cleanup成功とは主張しない。
ファイル確認では通常configと依存ファイルはHEADから不変、`app/.env` は引き続き存在しない。

Controllerが `open -a OrbStack` で非破壊的に復旧し、Docker29.8.2の応答を確認した。
再開前の一覧に専用コンテナ/volume/lock・runner/serveはなく、通常11コンテナとDB digestを読み取り専用で記録。
診断用にstage/request時間だけを一時記録した同じallでは、journeyは全段階を完走した。
初回PNG4.481秒、疎な既読6.577秒、最新へ7.797秒、offline7.878秒、結果不明9.444秒、旧epoch10.193秒、自動復活禁止11.444秒、完走/cleanup開始13.487秒、最後のAuth cleanup応答14.048秒。
HTTP応答546件の中央値29ms、最大168ms（`task-22-journey-timings.log`）。180秒timeoutは再現せず、旧CPUログとの因果関係は未証明。
timeout・runtime上限・assertion・認証は変更せず、追加の製品修正は行っていない。一時診断差分は削除し、元のjourneyファイルと一致を確認した。
診断allと並列に誤って起動したstack単体は共有lockとの衝突で7 passed / 4 failed（資源再利用・停止は拒否）。終了後に同コマンドを逐次再実行し11 passed / 0 skipped、exit 0を確認（`task-22-stack-restored-final.log`）。
診断削除後の元allコマンドもexit 0で両suite・cleanup・通常状態監査に成功。終了後の独立監査でも、復旧直後からの通常DB digest・11コンテナID・`.env`状態が一致し、専用コンテナ/volume/lockとrunner/serve/Jestの残存なし、専用ポート空きを確認した。
旧180秒timeoutの根本原因は未証明のまま履歴に残す。今回の成功だけで過去の失敗を合格へ読み替えない。

## 実データ2者の証拠と限界

Task21のcommit `4fe00dc`、`app/__tests__/home-chat-journey.test.tsx` と
`.sdd/reports/task-21-report.md` / `.sdd/task-21-all-verified.log` が先行証拠。
実AuthのA/Bと独立したA第2端末、実SQLite、実Edge/Storage/Realtimeを使用し、本文+PNG送受信、
Bの厳密に後の返信、Aのさらに後の返信で達成、2端末の疎な既読の和、明示的最新回復、
再起動・結果不明の同ID再送、関係終了と再成立後の明示確認を検証した。
Task22復旧後の実データ証拠は上記allログを参照。これは**renderer + 実バックエンド**であり、OSピッカー、
ネイティブcodec、OS読み上げ、実機手動操作の証拠ではない。

## ネイティブの試行と阻害条件

| 試行 | 実結果 / 範囲 |
| --- | --- |
| `CI=1 npm --prefix app run ios` | Xcode Build Succeeded、0 errors / 1 warning、iPhone18 Pro iOS27.0シミュレータへinstall/open。Metro常駐で外側120秒timeout、コマンド全体exit 0とは記録しない |
| iOS再試行（既存Metro） | `task-22-ios-second.log` もBuild Succeeded、0 errors / 1 warning、install/openを確認。以後は接続エラーを記録し、終了コードの証拠なし。native chat合格ではない |
| iOS起動スクリーンショット | `.sdd/task-22-ios-launch.png` / `task-22-ios-direct-launch.png`。OSの「appで開きますか」確認とdev launcherまで。チャット表示の証拠ではない |
| `open -a Simulator` | exit 1、`Unable to find application named 'Simulator'`。simctlのboot/launch/screenshotは利用可能 |
| `xcrun devicectl device info details --device …` | iPhone15 iOS27.2、Developer Mode Enabled、paired/wired。ただしdeveloper disk imageをmountできず詳細取得警告。物理端末を「存在しない」とはしない |
| codesigning identity | Apple Development identityが1件存在。署名資格ゼロとはしない。ストア/EAS資格や本人のOAuth対話認証は別問題 |
| `CI=1 npm --prefix app run android` | 初回 exit 1、接続対象なし。SDK絶対パスで確認するとAVD `Pixel_10` が存在し、手動boot後は `emulator-5554 device` |
| Android再試行 | Java27で `Unsupported class file major version 71`。既存Zulu17をプロセス限定で選ぶとSDK location不足まで進んだ。リポジトリや通常設定は変更しない |
| Android最終ビルド | JAVA_HOME17とANDROID_HOMEをプロセス限定で指定。`task-22-android-sdk.log` は **BUILD SUCCESSFUL in 14m 51s**、APK installと既存AVDへのdev-client URL openまで記録。コマンド終了コードとnative chat表示の証拠はない |

### 両OSの未完了マトリクス（全行、未実施であり合格ではない）

両OSのnative build成功は確認済みだが、チャットの実機ログイン後ルートに到達した証拠がない。Metro接続、iOSのGUI確認/本人OAuth、物理端末のDDI、Androidの実画面/本人OAuthを先に確認する。
認証迂回ルート・テスト資格注入・本番Auth緩和で代用しない。

| 対象 | iOS | Android | 再開時の確認 |
| --- | --- | --- | --- |
| ライブラリJPEG・透過PNG・HEIC | 未実施 | 未実施 | OSピッカーから選択、送信→相手表示、透過保持、HEIC→JPEG/PNG |
| EXIF向き・原寸/縮小・metadata除去 | 未実施 | 未実施 | 縦横の目印付き原本、長辺2048以下・JPEG品質80%、元/変換後各10MiB以下、最大4枚 |
| 再起動後の下書きと添付 | 未実施 | 未実施 | 未送信の本文/画像順序、相手・アカウント別復元、二重予約なし |
| オフライン・結果不明・24h期限 | 未実施 | 未実施 | 実ネット切断/復帰、同ID、FIFO、結果不明を新規送信しない |
| 文字200%・小画面・横向き | 未実施 | 未実施 | 入力/送信/画像操作の欠落・重なり・スクロール、下書き保持 |
| 2列/1列切替 | 未実施 | 未実施 | 論理幅900以上かつfontScale1.3以下のみ2列。899/900・1.3/超過・選択/下書き保持 |
| ライト/ダーク/時間帯切替 | 未実施 | 未実施 | 本文・リンク・状態・画像viewerの可読性、入力保持 |
| VoiceOver / TalkBack | 未実施 | 未実施 | 読上順、ラベル、フォーカス、送信状態/新着案内、最新移動 |
| 写真権限拒否・限定許可 | 未実施 | 未実施 | 拒否後の説明/再操作、本文/添付消失なし、通知許可は要求しない |
| バックグラウンド復帰 | 未実施 | 未実施 | 復帰再取得、未読整合、日跨ぎ古い対象者の抑止。OS自動タスク実行と前景復帰を区別 |

## 再開条件

指定自動回帰の成功証拠は上表のとおり確保済み。対象OSの必要機材・Metro接続と本人認証を確保して上表を実操作する。
端末/OS/build SHA、fixture原本の寸法・形式、スクリーンショット/動画、実施日時・期待/実測を追記する。
阻害条件を記録したことだけでネイティブ検証完了や本番完成は宣言しない。
