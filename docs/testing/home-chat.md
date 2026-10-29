# ホーム・チャット — Task 22 検証記録

対象: [設計](../sdd/specs/2026-10-27-home-chat-design.md) / [運用](../operations/home-chat.md)。
以前の[基盤検証記録](app-foundation-friends-ui.md)は過去の別計画の証拠であり、今回の実機合格へ流用しない。

**状態: Task 22完了。両OSの手動確認完了（2026-10-29、利用者報告）、修正後の最終自動回帰・専用環境の後片付けも確認済み。DBテストは分離環境で実施。**
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
  当初の検証時はファイルが無かったため、共有 `scripts/lib/local-backend.cjs` の `readSupabaseStatus()` で実ローカルの
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

## ネイティブの試行と阻害条件（当初チェックポイントの履歴）

以下は当初の自動検証で得られた結果を保持したもの。後日の利用者による両OSの完了報告とは別の証拠であり、当時の失敗・制限を成功へ書き換えない。

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

### 両OSの手動確認マトリクス（利用者報告で確認済み）

2026-10-29、利用者から「動作確認が完了しました。大きな問題はありませんでした」、続いて
「AndroidもiOSでも全てに動作確認が完了しました」との明示的な報告を受領した。
以下の全項目を両OSで確認済みとして記録し、手動確認の阻害条件を解除する。
証拠は利用者の完了報告であり、エージェントによる実操作や個別のスクリーンショット取得の主張ではない。
確認に用いた端末・OS版・build SHA・個別時刻・画像や動画は未提出のため補完しない。認証迂回やテスト資格注入で代用していない。

| 対象 | iOS（利用者報告） | Android（利用者報告） | 確認項目 |
| --- | --- | --- | --- |
| ライブラリJPEG・透過PNG・HEIC | 確認済み | 確認済み | OSピッカーから選択、送信→相手表示、透過保持、HEIC→JPEG/PNG |
| EXIF向き・原寸/縮小・metadata除去 | 確認済み | 確認済み | 縦横の目印付き原本、長辺2048以下・JPEG品質80%、元/変換後各10MiB以下、最大4枚 |
| 再起動後の下書きと添付 | 確認済み | 確認済み | 未送信の本文/画像順序、相手・アカウント別復元、二重予約なし |
| オフライン・結果不明・24h期限 | 確認済み | 確認済み | 実ネット切断/復帰、同ID、FIFO、結果不明を新規送信しない |
| 文字200%・小画面・横向き | 確認済み | 確認済み | 入力/送信/画像操作の欠落・重なり・スクロール、下書き保持 |
| 2列/1列切替 | 確認済み | 確認済み | 論理幅900以上かつfontScale1.3以下のみ2列。899/900・1.3/超過・選択/下書き保持 |
| ライト/ダーク/時間帯切替 | 確認済み | 確認済み | 本文・リンク・状態・画像viewerの可読性、入力保持 |
| VoiceOver / TalkBack | 確認済み | 確認済み | 読上順、ラベル、フォーカス、送信状態/新着案内、最新移動 |
| 写真権限拒否・限定許可 | 確認済み | 確認済み | 拒否後の説明/再操作、本文/添付消失なし、通知許可は要求しない |
| バックグラウンド復帰 | 確認済み | 確認済み | 復帰再取得、未読整合、日跨ぎ古い対象者の抑止。OS自動タスク実行と前景復帰を区別 |

## 確認結果と本番運用の区別

手動確認の完了報告は上表に記録済み。自動回帰は各実行時点の結果を上表・追記に分けて保持する。
本番へのデプロイ・外部ジョブ登録・配布は別の承認事項であり、動作確認完了を実行許可や本番運用開始とは扱わない。
既存14依存のSDKパッチ推奨（`expo install --check` exit 1）も未解消のまま明示する。

## 追記: Androidの会話再取得中に入力できない問題（2026-10-29）

- 利用者からAndroidで友達申請・承認まで操作できたとの報告後、会話画面の連続再描画と入力不可が報告された。この時点では上の手動マトリクス全体の合格とは扱わなかった。
- 通常DBの `daily_cycle_runs` は読み取り確認で0行。抽選未実行の `checking` が期限後も続くと、providerが毎秒全体を再取得していた。
  さらに会話リポジトリが再取得開始時に確認済み送信可否を落とし、並行するホーム・閲覧同期の表示更新で入力欄が無効になっていた。
- 空の会話の再取得を保留し、その間の入力・SQLite下書き保存を検証するテストを追加。修正前は `editable=false` で失敗、修正後は成功。
  再取得開始を関係失効とは扱わず、現在の関係・世代照合とアカウント停止の制約は維持する。
- 期限後も抽選が未確定のケースもRED/GREEN確認。最初の速やかな再確認後は既存の指数バックオフを使い、04:00／04:05の確認とサーバーによる確定を維持する。
- 関連4 suites / 83 tests成功。journey2本を除くJestは54 suites / 925 tests成功（既存テストから `act(...)` 環境の警告あり）、typecheck・`git diff --check` も成功。
  この時点では利用者の手動操作と競合する実バックエンドjourneyを再実行していない（後日の最終回帰は下記）。
- 修正後、利用者からAndroid・iOSの全項目の動作確認完了・大きな問題なしとの報告を受領。ネイティブ依存・DB・OAuth設定の変更やデータ消去は不要だった。

## 追記: 両OS完了報告後の最終自動回帰（2026-10-29）

- typecheckはexit 0。通常Jest（新journeyのみ除外、既存実バックエンドjourneyを含む）は再実行で **55 suites / 932 tests成功**。
  初回は既存journeyの3件が失敗し、同時刻のGatewayに502接続失敗を記録。診断用runtime出力を採取した単独journeyは7件成功し、元の全Jestコマンドも成功した。
  初回失敗を成功には読み替えず、接続断の根本原因は未証明として残す。テストの再試行機構・assertion緩和・製品側の推測修正は追加していない。
- 通常DBのpgTAPは **5 / 5,100 assertions失敗**。既存テストの全体件数assertionに、手動確認で作成済みの友達関係1件と申請受信・友達成立イベント各1件が含まれていた。
  通常データを削除・resetせず、同じSQLテストを `withChatTestStack` の所有する専用 `daily-chat-home-chat-test` / 55320–55329 へコピーして実行し、**16 files / 5,100 assertionsすべて成功**。
  分離DB実行前後の通常DB digest・コンテナ・config・`app/.env` は不変、専用環境の後片付けも成功。
  通常DBでの元コマンドはデータの存在に依存するため、以後も空の検証DBと区別する。
- Deno **168 passed / 0 failed**、既存backend **191 passed / 0 failed**、専用chat all **journey 2 suites / 3 tests＋backend全10群成功**。
  専用allのfixture/process/stack cleanupと通常DB・コンテナ・config・`app/.env`不変監査も成功。
- 専用環境テスト **11 passed / 0 skipped**。招待Webは初回 **23 passed / 2 failed** で、手動確認用 `.env` の招待originが入力なし／指定入力のテストへ混入していた。
  Expo公式の `EXPO_NO_DOTENV=1` をテストプロセスにだけ設定した再実行は **25 passed / 0 failed**。`.env`・テストassertion・アプリ設定は変更していない。
- ローカルnative config検査とdiff検査はexit 0。独立した終了時監査で専用コンテナ・volume・lockの残存なし、55320–55329の全ポート空き、runner/serve/Jestの残存なしを確認。
- ログ: `.sdd/task-22-final-acceptance-*.log`、結果一覧 `task-22-final-acceptance-{followup,closeout}-results.json`、終了時監査 `task-22-final-acceptance-cleanup.json`。
  途中の失敗を合格へ書き換えず、通常DB・dotenvの再現条件と既存14依存の推奨更新を残した上でTask 22を完了とする。本番デプロイ・ジョブ登録は別途承認が必要。

### 分離DBで同じpgTAPを再実行する

専用runner・stack単体テストと同時に実行しない。所有権・ポート確認、専用スタックの起動と停止は既存helperを使い、通常DBをresetしない。

```sh
node <<'NODE'
const fs = require('node:fs/promises');
const path = require('node:path');
const stack = require('./scripts/lib/chat-test-stack.cjs');
const backend = require('./scripts/lib/local-backend.cjs');
stack.withChatTestStack(async ({ workdir }) => {
  await fs.cp(path.join(backend.REPO_ROOT, 'supabase/tests'),
    path.join(workdir, 'supabase/tests'), { recursive: true });
  process.stdout.write(stack.command('npx', ['supabase', 'test', 'db'], workdir));
}).catch(error => {
  console.error(backend.redact(error.message));
  process.exitCode = 1;
});
NODE
```
