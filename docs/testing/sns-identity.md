# 会話とストリークで育つ見た目 — Task 17 検証記録

対象: [設計](../sdd/specs/2026-10-30-sns-identity-design.md) /
[計画](../sdd/plans/2026-10-30-sns-identity.md) /
[移行・運用runbook](../operations/sns-identity.md)。
以前の[ホーム・チャット検証記録](home-chat.md)は別計画の証拠であり、この記録へ流用しない。

**状態: Task 17完了（自動回帰）。Task 18は部分証拠のみ（両OS認証済み0/29→0/30/100日、iOS明暗・文字200%・演出カード/2択）。両OSのVoiceOver／TalkBack・横向き・2列切替・性能・演出中の入力操作は未確認で、計画全体は未完了。**
本記録は2026-10-30（JST）に実行した自動回帰の実測であり、設計時点の予定ではない。
本番デプロイ・本番push・外部ジョブ登録・通常DBのresetは行っていない。

## 1. 実行環境

| 項目 | 実測値 |
| --- | --- |
| 実行日時 | 2026-10-30 23:39–23:51 JST（14:39–14:51 UTC） |
| commit | `bf8b961ded44bffef0002a8be757d027ec61d126`（Task 16完了時点。docs追加前） |
| OS | macOS 27.0.1（Build 26A434） |
| Node / npm | v26.12.1 / 11.20.0 |
| Deno | 2.9.6（`npx deno`） |
| Supabase CLI | 2.122.0 |
| Docker | 29.8.2 |
| Xcode | 27.1（このタスクではネイティブビルドを実行していない） |
| 通常環境 | `daily-chat` / 54321系。実行前から停止中。`app/.env` は存在しない |
| 専用環境 | `daily-chat-home-chat-test` / 55320–55329。一時ディレクトリへコピーして起動 |
| seed | 専用configで `[db.seed] enabled=false`、`sql_paths=[]`。固定seedは使わない |

専用runnerはリポジトリを一時ディレクトリへコピーし、`project_id`・全ポート・Edge inspector portを
専用値へ書き換える。fixtureはrunnerが所有するAuthユーザーと会話だけを作り、終了時に削除する。
通常プロジェクトの起動・停止・migration・resetは行わない。

## 2. 実行コマンドと結果

すべてリポジトリルートで、上から**逐次**実行した。専用stackを使うコマンドは並列実行していない。
ログはgit管理外の `.sdd/logs/task-17-*.log` に保持する。
タイムスタンプはUTC（開始–終了）とJSTの順。すべて実行時commitは上記SHA。

| # | コマンド | UTC | JST | exit | 実測 |
| --- | --- | --- | --- | --- | --- |
| 1 | `npm --prefix app run typecheck` | 14:39:23–14:39:25Z | 23:39:23–23:39:25 | 0 | `tsc --noEmit` 成功。エラー0 |
| 2 | `npm --prefix app test -- --runInBand --testPathIgnorePatterns 'app-journey.test.tsx\|home-chat-journey.test.tsx\|appearance-journey.test.tsx'` | 14:39:27–14:39:54Z | 23:39:27–23:39:54 | 0 | **68 suites / 1,131 tests passed**、0 failed |
| 3 | `npx deno test --allow-env --allow-net --config supabase/functions/deno.json supabase/functions/tests` | 14:39:57–14:39:59Z | 23:39:57–23:39:59 | 0 | **174 passed / 0 failed** |
| 4 | `node --test scripts/chat-test-stack.test.mjs` | 14:40:01Z | 23:40:01 | 0 | **14 passed / 0 failed / 0 skipped** |
| 5 | `node --test scripts/appearance-regression-harness.test.mjs` | 14:40:04Z | 23:40:04 | 0 | **8 passed / 0 failed / 0 skipped** |
| 6 | `node scripts/test-chat-backend.mjs --suite all` | 14:40:15–14:44:42Z | 23:40:15–23:44:42 | 0 | 267.57秒。下記の全suiteがPASS |
| 7 | `git diff --check` | 14:49:02Z / 14:51:12Z | 23:49:02 / 23:51:12 | 0 | docs修正後に複数回実行し、いずれもwhitespaceエラーなし |

### 2.1 通常Jestの除外範囲

コマンド2が除外した実バックエンドjourneyは**次の3本だけ**である。

- `app/__tests__/app-journey.test.tsx`
- `app/__tests__/home-chat-journey.test.tsx`
- `app/__tests__/appearance-journey.test.tsx`

3本はコマンド6の `--suite all` で必ず実行した。Jestの出力にはwatchmanのrecrawl警告と
Reactの `act(...)` 警告が残るが、失敗ではない。既存の環境警告であり、assertionの緩和やskipはしていない。

### 2.2 専用 `--suite all` の内訳

| suite | 実測 | 結果 |
| --- | --- | --- |
| `db`（pgTAP） | **21 files / 5,531 tests**、ロールバック | PASS |
| `legacy`（旧HTTP） | **191 passed / 0 failed** | PASS |
| `legacy` journey（`app-journey`） | **1 suite / 7 tests** | PASS |
| `journey`（`chat-env` + `home-chat-journey`） | **2 suites / 4 tests** | PASS |
| `backend`（実HTTPの閉じた検査） | **16 checks PASS** | PASS |
| `appearance`（実HTTP／SQLite journey） | **1 suite / 1 test** | PASS |
| fixture／process／stack cleanup | 専用資源の削除と通常状態監査 | PASS |
| 通常状態の不変監査 | コンテナ・config・`app/.env` | PASS（DB digestは下記の制約） |

`--suite all` は各suiteに独立したstack寿命を与え、1つが失敗しても残りを隠さない。
今回の実行では途中失敗はなく、全suiteが一度で成功した。

### 2.3 `git diff --check`

docs追加後に実行し、exit 0（出力なし）を確認した。空白エラー・CRLF混入はない。

### 2.4 runbook検証SQLの追加確認

2026-10-30T14:49:35–14:50:15Z（23:49:35–23:50:15 JST）に、[移行・運用runbook](../operations/sns-identity.md)
§6.1–6.5のSQLを新しい専用stack（`daily-chat-home-chat-test`、1寿命）で実行した。exit 0。
migration 0023–0026の4行、4テーブルのRLS有効、`chat_updates` の authenticated SELECT以外の
権限なし、PUBLIC grantなし、`chat_updates` だけのpublication、元テーブルの非公開、
`appearance_celebrations` のサーバー不在、トリガー、日別／累計・operation log・streakの
mismatch 0行を確認した。実行後の専用コンテナ・volume・lock・一時ディレクトリ・ポート・
runnerプロセスは残っておらず、通常コンテナとvolumeは実行前と一致した。

## 3. 失敗・修正・読み替えの禁止

- 今回のTask 17実行では、上記7コマンドの失敗は**0件**。したがって修正は発生していない。
- 前タスクまでの失敗・タイムアウト・Docker不調は各タスクのreportとログに保持し、今回の成功へ読み替えない。
- もし途中で失敗した場合は、失敗した責務（app単体／server／Edge／harness）のファイルとテストだけを直し、
  同じコマンドを再実行して失敗と再実行の両方をこの節へ追記する方針とする。assertionの削除・skip・
  件数の縮小で通さない。
- 通常DBのpgTAPは、実行前から通常DBが停止していたため実行していない。通常DBを起動・resetして
  代用していない。DBテストは専用 `daily-chat-home-chat-test` のロールバック内だけで実行した。

## 4. 専用資源のcleanupと通常状態の不変監査

### 4.1 runnerの監査

コマンド6の最後に、次がPASSした。

```text
PASS dedicated all suite and fixture/process/stack cleanup
PASS normal development database, containers, config and app/.env unchanged
```

ただし通常DBコンテナ `supabase_db_daily-chat` は実行前から停止していた。runnerの
`normalDatabaseDigest` はDBが起動中の場合だけdigestを取るため、今回は**null**であり、
通常DBのデータ内容をdigestで比較したという意味ではない。通常DBのデータ内容不変は主張しない。
開始・終了とも通常stackを起動・停止・resetしていない。

### 4.2 独立した前後比較

実行前（14:39Z頃）、全suite終了後（14:45Z頃）、runbook SQL確認後（14:50Z頃）に、読み取り専用で次を比較した。

| 対象 | 結果 |
| --- | --- |
| 通常コンテナ一覧（12個、すべて `Exited`） | ID・名前・状態が前後で一致 |
| 通常volume一覧（`supabase_db_daily-chat` ほか3個） | 前後で一致 |
| `supabase/config.toml` SHA-256 | `dffeb0e3cf3a62d811e45ff3b4406809a359919c658cc86fec4ac2c0f1958cb3` で一致 |
| `app/.env` | 実行前・実行後とも存在しない |
| 専用コンテナ／volume | 残存なし |
| 専用lock（`$TMPDIR/opencode/.daily-chat-home-chat-test.lock`） | 残存なし |
| 専用一時ディレクトリ（`daily-chat-home-chat-test-*`） | 残存なし |
| 55320–55329のLISTEN | なし |
| `test-chat-backend`／専用`functions serve`プロセス | 残存なし |

通常プロジェクトの `supabase stop`、volume削除、lock削除、DB resetは行っていない。
前後比較の生データは `.sdd/logs/task-17-baseline-*` と `.sdd/logs/task-17-final-*` にある。

## 5. 証拠の種類と限界

この記録では、次の3種類を混ぜない。

1. **SQL／pgTAP証拠**: 専用DBのロールバック内で、実Postgresの制約・トリガー・RLS・関数を検証する。
   ブラウザやアプリの描画は通らない。
2. **実HTTP／SQLite journey証拠**: 専用stackの実Auth、Edge Functions、PostgREST、Realtime、Storageと、
   端末相当のSQLite（Nodeの `node:sqlite` driver）を通す。画面はReact Testing Libraryのrendererで、
   本物のOS描画・OSピッカー・読み上げではない。
3. **renderer／Jest証拠**: React component、provider、純粋関数、storage adapterをテストする。
   ネイティブのSVG／Reanimated描画、VoiceOver／TalkBack、端末設定の実挙動を示さない。

`appearance-journey` のfixture seedは、runnerが所有する会話の受付日rowと本人のstreak値だけを
専用DBへ書く。公開RPCへ日付やactorを注入する経路は追加していない。過去の全履歴を復元した演出では
なく、初回基準と通常の追いつき再生を実HTTPで確認した証拠である。

### 5.1 証拠の選別と匿名化

- 証拠は必須7コマンドの実行ログと実測件数を基準に選び、成功した一部のテストだけを主観で
  抜き出して全体の合格とはしない。coverage matrixには代表的なテスト名を挙げ、証拠種別を明記する。
- 実ユーザーの表示名・User ID・本文・画像・下書き・アクセストークン・OAuth secret・
  サービス資格を、この記録・ログ・コミットへ含めない。fixtureは `@example.test` の合成ユーザーと
  合成メッセージだけで、終了時に削除する。
- 実行ログはgit管理外の `.sdd/logs/` に置き、runnerのredactを通した出力だけを保持する。
  SQL検査結果は件数・UUID・真偽値・テーブル名だけを記録し、行の中身（本文等）を貼らない。
- 本タスクはスクリーンショット・動画を追加していない。両OSの証拠を追加するTask 18では、
  端末・OS・build SHA・日時を記録し、氏名・User ID・本文・画像・通知内容を匿名化した
  必要最小限の画像だけを `docs/testing/screenshots/sns-identity/` へ置く。

## 6. 仕様項目と自動証拠の対応

「PASS」は自動テストの結果であり、ネイティブ確認の完了ではない。
テスト名は実ファイルのテスト名・SQLコメントに対応する。

| 仕様項目 | 自動証拠（代表） | 証拠種別 | 結果 |
| --- | --- | --- | --- |
| 成長日の確定（同じ会話の2人、同じ04:00 JST日） | `appearance-growth.test.sql` のDay 1–5。backendの「one accepted pair-day increments chat growth once…」 | pgTAP＋実HTTP | PASS |
| 1日1回（同日多重送信・同時刻・再試行で増えない） | `appearance-growth.test.sql` Day 1。backendの同時受付検査。journeyのA/B実送信 | pgTAP＋実HTTP＋journey | PASS |
| 04:00 JST境界（03:59:59は前日、04:00は当日） | `appearance-growth.test.sql` の「04:00 JST belongs to the new day; 03:59:59…」 | pgTAP | PASS |
| 100日超も累計は増え、表示だけ100日で止まる | `appearance-growth.test.sql` の past 100。`progress.test.ts`、`calculate.test.ts`、`appearance-layout.test.tsx` の101日 | pgTAP＋Jest | PASS |
| 29日→0日でもearned_days=29・表示7日段階を保持 | `appearance-streak.test.sql` の ordered recovery 29→0。journeyの current 0 / earned 29 表示 | pgTAP＋journey | PASS |
| 1・7・30・60・100日の節目（表示と演出） | `calculate.test.ts` の6→7/29→30/59→60/99→100、`progress.test.ts`、`celebrations.test.ts`、journeyの1日成長と7/30/60の演出 | Jest＋journey | PASS |
| 初回基準（過去分を演出しない） | `celebrations.test.ts` の initial 0/100 baseline、`appearance-storage.test.tsx` の first baseline、journeyの初回canonical sync | Jest＋SQLite＋journey | PASS |
| 種類別停止と再開世代（停止中の達成を後から再生しない） | `preferences.test.tsx` の再開時1回だけbump、restart/foregroundでbumpしない、`celebrations.test.ts` のsubtle/disabled抑制、journeyのskip→種類別停止→再開 | Jest＋journey | PASS |
| 共有プリセットの競合・同ID再実行 | `appearance-settings.test.sql` のlater accepted wins/replay、backendの「current friends share one preset…」、journeyの実picker | pgTAP＋実HTTP＋journey | PASS |
| 設定の結果不明からの同ID回復 | `sharedSettings.test.ts`、`appearance-picker.test.tsx`、backendの「lost accepted response…」、journeyの2xx後transport失敗 | Jest＋実HTTP＋journey | PASS |
| 空会話（設定保存だけで一覧へ出さない） | backendの「settings-only conversation stays out of list/home…」、`appearance-queries.test.sql` のsection 5 | 実HTTP＋pgTAP | PASS |
| 可視性・重要な確認による演出停止 | `celebrations.test.ts`、`appearance-celebrations.test.tsx` のroute/background/logout/確認、`appearance-layout.test.tsx` のactual peer | Jest | PASS |
| 再起動・再ログイン・ログアウト・アカウント分離 | `appearance-storage.test.tsx` のreopen/re-login・account isolation・logout後保持、`logout-entry.test.tsx`、journeyの再起動／B台帳分離 | SQLite＋Jest＋journey | PASS |
| 演出記録の読込・保存失敗 | `celebrations.test.ts` のconsume失敗で両方未消化・再生しない、`appearance-storage.test.tsx` のrollback、`preferences.test.tsx` の保存失敗 | Jest＋SQLite | PASS |
| コントラスト・段階不変・装飾量 | `calculate.test.ts` の全stage/preset/明暗の可読性・段階内固定・100日完成形、`appearance-surfaces.test.tsx` の3:1境界、`appearance-layout.test.tsx` の899/900・1.3/2.0 | Jest | PASS |
| 旧cache・未知version／presetのfallback | `observations.test.ts` のchecking（0を捏造しない）、`contracts.test.ts` のunsupported、`appearance-layout.test.tsx` のunknown preset→確認中 | Jest | PASS |
| RLS・第三者拒否・直接SQL拒否 | `appearance-growth.test.sql`／`appearance-queries.test.sql`／`appearance-settings.test.sql` の権限節、backendの第三者拒否、Denoのpayload／transport境界 | pgTAP＋実HTTP＋Deno | PASS |
| バックフィルと再実行の非破壊性 | `appearance-growth.test.sql` のreplayable backfill、`appearance-streak.test.sql` のmissing rows only、runbookの`initialize_*` | pgTAP | PASS |
| 設定変更が成長・streakを動かさない | `appearance-settings.test.sql` の「Settings changes never touch growth, messages or streak facts」 | pgTAP | PASS |
| 同一snapshot・revision（home/detail） | `appearance-queries.test.sql` のsection 3/7、`observations.test.ts`、backendのA/B同一値 | pgTAP＋Jest＋実HTTP | PASS |

補足: 100日の**演出**は `celebrations.test.ts` の「selects 100 once and nothing at 101」で確認する。
実HTTP journeyは1・7・30・60を実データで通り、100日と101日は純粋関数・renderer・SQLで確認する。
全節目を実時間で待つ試験は行っていない。

## 7. 実HTTP／SQLite journeyで通した範囲

`app/__tests__/appearance-journey.test.tsx` は、実AuthのA・Aの第2端末・Bを使い、実際の
`AuthProvider`、`ChatProvider`、`AppearancePreferencesProvider`、`AppearanceProvider`、
`VisibilityProvider`、`CelebrationHost`、`HomeDashboard`、`ChatList`、`ConversationPanel` を通す。

- 初回canonical syncの基準化（演出なし）。
- A/Bの実送信による同じ成長日と、A・A2・Bの同じ確定値。
- 本番pickerからの共有preset `b-candy` と、確定query再取得後の反映。
- 2xx受信後にtransportだけ失敗させた設定変更の結果不明→同じoperation IDでの確認。
- current 0 / earned 29 の本人表示（`現在0日`、`獲得済み：7日段階`、`次の30日段階まであと30日`）。
- チャット→本人の順、1個スキップ、種類別停止、再開後の30日、3日/14日で新規演出なし。
- 59→60の表示と演出、current/earned 30の本人30日演出。
- 同じSQLiteファイルでの再起動・再ログインで消化済みを再生しない。
- Bの台帳にAの消化済み・本人frameが混ざらないアカウント分離。
- 終了時のowner fixture cleanupと全client/serve/stackの終了。

これは**renderer＋実HTTP／SQLite**の証拠であり、ネイティブ描画・OS操作の証拠ではない。

## 8. 未確認（Task 18が所有）

以下はすべて**未確認**である。この記録をもってTask 18を完了扱いにせず、成功とも書かない。

| 未確認項目 | iOS | Android | 必要な証拠 |
| --- | --- | --- | --- |
| 0/1/6/7/29/30/59/60/99/100/101日の実描画（両明暗・全preset・派手さ設定） | 未確認 | 未確認 | 端末・OS・build SHA・日時・画像／動画 |
| 小画面・横向き・文字200%・safe area・キーボード・2列切替 | 未確認 | 未確認 | 各条件の操作記録 |
| VoiceOver／TalkBackの読み上げ順・ラベル・フォーカス | 未確認 | 未確認 | 読み上げ記録 |
| OSの動き軽減（起動中変更・復帰時再確認） | 未確認 | 未確認 | 設定変更を含む操作記録 |
| 100日＋演出中の入力・送信・履歴scroll・背景化停止 | 未確認 | 未確認 | 動画または操作記録 |
| 0日と100日の操作性能（入力遅延・scroll・再描画） | 未確認 | 未確認 | profilingと観察記録 |
| 実端末のネイティブビルド・インストール・起動 | 未確認 | 未確認 | buildログと端末操作（build成功だけでは不足） |
| ストア配布・本番OAuth・本番通知 | 未確認 | 未確認 | 別承認の証拠 |

Task 17時点では `npm --prefix app run ios` / `npm --prefix app run android` を実行していなかった。
Task 18で両OSの開発ビルドとログイン画面までは取得したが、認証済みの両OS操作・VoiceOver／TalkBack・
性能は未確認である。HTML試作、renderer、ビルド成功をネイティブ合格の代用にしない。

## 9. 再現コマンド

リポジトリルートで、必ず上から逐次実行する。専用stackを使うコマンドを並列化しない。

```sh
npm --prefix app run typecheck
npm --prefix app test -- --runInBand --testPathIgnorePatterns 'app-journey.test.tsx|home-chat-journey.test.tsx|appearance-journey.test.tsx'
npx deno test --allow-env --allow-net --config supabase/functions/deno.json supabase/functions/tests
node --test scripts/chat-test-stack.test.mjs
node --test scripts/appearance-regression-harness.test.mjs
node scripts/test-chat-backend.mjs --suite all
git diff --check
```

通常Jestの除外は上記3本だけにする。`--suite all` は `db, legacy, journey, backend, appearance` を
含み、終了時にfixture・process・stack・通常状態を監査する。通常DBをresetしたり、専用資格を
既存journeyへ渡したりしない。実行ログは `.sdd/logs/task-17-*.log`（git管理外）に保存した。

## 10. 設計時点の予定と実装後の証拠の区別

- 設計書の「テストと完了条件」は要求事項であり、実装・検証の完了を意味しない。
- この記録のPASSは、上記commit・環境・コマンドで取得した実測である。設計時の想定件数や
  過去のTask 22記録（932 tests等）を今回の件数へ流用していない。
- 自動回帰の成功は、両OSの見た目・操作・アクセシビリティの成功ではない。Task 18の証拠が
  揃うまで、完了条件のうちネイティブ部分は未達である。
- 本番反映の有無は別の承認事項であり、この記録は本番適用・ジョブ登録の許可ではない。

## 11. Task 18 — 両OSビルドと部分的なネイティブ証拠（未完了）

**状態: Task 18は未完了（BLOCKED）。** 両OSの開発ビルドとログイン画面、Androidの認証済み
画面の一部は取得した。iOSの認証済み画面、両OSのVoiceOver／TalkBack、文字200%・横向き・
2列切替・キーボード・safe area、OS動き軽減の起動中変更、節目演出のスキップ／種類別停止、
100日状態での入力・送信・scroll、0日と100日の性能比較は**未確認**である。
この節をもってTask 18の完了、まして計画全体の完了とはしない。

### 11.1 ビルド・実行環境（実測）

| 項目 | iOS | Android |
| --- | --- | --- |
| 実行日時 | 2026-10-30 23:5x–2026-10-31 00:0x JST | 2026-10-31 00:0x–00:2x JST |
| 対象 | iPhone 17 Simulator / iOS 27.0 | Pixel_10 AVD / Android API 37（software GPU） |
| ツール | Xcode 27.1（27A9275）、CocoaPods 1.17.0 | Gradle assembleDebug、JDK 17.0.21 |
| コマンド | `npx expo run:ios --device "iPhone 17" --no-bundler` | `./gradlew assembleDebug -x lint` |
| 結果 | **Build Succeeded / 0 errors, 2 warnings**、`com.anonymous.app` を Simulator へインストール | **BUILD SUCCESSFUL in 7m 39s**（733 tasks）、`android/app/build/outputs/apk/debug/app-debug.apk` |
| 起動 | Expo dev client でログイン画面まで到達 | APK を `adb install` し、dev client でログイン画面・認証済み画面まで到達 |
| build SHA | 実装branch `3f44856`（Task 17 docs）＋本節のHeader保護修正（未コミット時点） | 同左 |

iOS/Androidとも `npm --prefix app run ios` / `run android` の常駐Metroではなく、
`--no-bundler` / Gradleでnative buildを分離し、Metroを別プロセスで起動して確認した。
ビルド成功・起動成功・ログイン画面到達は、認証後の操作成功とは区別する。

### 11.2 取得した証拠

匿名化のため、表示名・会話本文・画像を含む画面は保存していない。保存したのは次だけである。

- `screenshots/sns-identity/ios-login.png`: iOS Simulatorのログイン画面（Apple/Googleボタン）。
- `screenshots/sns-identity/android-login.png`: Android Emulatorのログイン画面。
- `screenshots/sns-identity/android-0-earned-7.png`: Android認証済みホーム。現在0日、
  獲得済み7日段階、次の30日段階まであと30日。**29→0の保持段階表示**の実画面。
- `screenshots/sns-identity/android-30.png`: Android認証済みホーム。現在30日、獲得済み30日段階、
  次の60日段階まであと30日。装飾が0日/7日段階から増えていることの比較用。
- `screenshots/sns-identity/android-100.png`: Android認証済みホーム。現在100日、獲得済み100日段階、
  最大段階に到達。100日完成形の背景・模様・ステッカーと、Header文字の保護面。
- `screenshots/sns-identity/android-100-final.png`: ナビゲーションHeader・タブバーも本人visualに
  揃えた後のAndroid 100日。
- `screenshots/sns-identity/android-text200.png`: Android文字サイズ200%の0/7日段階。
  本文は折り返してスクロールでき、4タブは維持される（一部ラベルは省略表示）。
- `screenshots/sns-identity/android-split.png`: Androidの論理幅900以上での2列表示。
  左ナビゲーションと本文が同時に表示され、4タブは増えない。
- `screenshots/sns-identity/android-talkback.png`: TalkBack有効時のシステム許可ダイアログ。
  TalkBackのフォーカス枠が出ることを確認した（読み上げ順・ラベルは別途未確認）。
- `screenshots/sns-identity/ios-0-earned-7.png`: iOS認証済みホーム。現在0日・獲得済み7日段階・
  次の30日段階まであと30日。
- `screenshots/sns-identity/ios-30.png`: iOS認証済みホーム。現在30日・獲得済み30日段階。
- `screenshots/sns-identity/ios-100.png`: iOS認証済みホーム。現在100日・最大段階。
- `screenshots/sns-identity/ios-100-dark.png`: iOSダークモードの100日。ナビゲーションHeader・
  タブバー・本文面が暗色で揃い、文字が読める。
- `screenshots/sns-identity/ios-100-text200.png`: iOS文字サイズ拡大（accessibility-large）の100日。
  レイアウトが崩れず、横スクロールなしで読める。
- `screenshots/sns-identity/ios-celebration-card.png`: iOS会話100日の演出カード
  （会話の節目 / 100日 / 累計100日 / スキップ）。入力欄・送信・履歴は下に残る。
- `screenshots/sns-identity/ios-celebration-choice.png`: スキップ後の非モーダル2択
  （今回だけスキップ / 今後の同種類を停止）。

認証済みAndroid/iOSでは、上記に加えて次を目視確認した（画面は個人名・本文を含むため保存しない）。

- 0日はモノクロで装飾なし。7日段階・30日段階・100日段階で背景色・模様・ステッカー・
  動く背景レイヤーが段階的に増える。
- 現在0日・earned 29日で「獲得済み：7日段階」「次の30日段階まであと30日」となり、
  「29日段階」「あと1日」と表示しない。
- チャット一覧の小さな成長表示（累計1日 / 1日段階）と、会話画面で共有preset
  `b-candy` の100日背景・吹き出しが表示される。会話ヘッダーの累計/次節目はスクロール位置に
  よって画面上端外になる場合がある。
- ホームの100日状態で、Headerの装飾がタイトル文字の直下に重ならないよう、Header文字面を
  不透明な本文面で保護した（`app/src/ui/Screen.tsx`）。ナビゲーションHeaderとタブバーも
  同じ本人visualに揃えた（`(tabs)/_layout.tsx`）。
- iOSでも0日・29→0（7日段階）・30日・100日を確認した。ダークモードではナビゲーション
  Header・タブバー・本文面が暗色で揃い、文字が読める。文字サイズ `accessibility-large`
  でも主要情報が読め、レイアウトが横にはみ出さない。
- iOSの会話100日で演出カード（会話の節目 / 100日 / 累計100日 / スキップ）を確認した。
  カードは非モーダルで、下の入力欄・送信・履歴が残る。スキップ後の2択も非モーダルで表示された。
- Androidの文字200%で本文が折り返し・スクロールでき、4タブが維持された。論理幅900以上の
  2列表示で左ナビゲーションと本文が同時に表示された。TalkBackを有効化してもアプリは
  起動・表示でき、システム許可ダイアログにフォーカス枠が出た。
- Android Emulator（software GPU）で `dumpsys gfxinfo` を取得した。0日相当で
  Total 115 frames / Janky 95.65% / 50th 93ms / 90th 133ms、100日相当で
  Total 136 frames / Janky 89.71% / 50th 77ms / 90th 105ms。SwiftShaderのため
  実機性能の合格値には使わない。クラッシュ・操作不能は観測しなかった。

- 演出カードと2択の操作確認では、2秒では画面を撮影・操作しにくいため、検証中だけ
  `CELEBRATION_DURATION_MS` を12秒へ一時変更した。確認後に2000msへ戻し、
  `celebrations.test.ts` / `appearance-celebrations.test.tsx` を再実行している。
  証拠画像はUIの形を示すもので、最終コードの表示時間は約2秒である。

### 11.3 実施できなかったこと（阻害条件）

- **両OSのVoiceOver／TalkBackの内容**: AndroidはTalkBack有効化とシステムダイアログの
  フォーカス枠まで、iOSはVoiceOver未確認。読み上げ順・ラベル・装飾の読み上げ除外・
  フォーカス移動は音声では確認していない。
- **レイアウト条件**: Androidの文字200%と2列表示は確認した。Androidの横向きは
  `app.json` の `orientation: portrait` によりポートレート固定で、横向き画面の証拠はない。
  Androidのsafe area・キーボード表示中、OS動き軽減の起動中変更は未確認。iOSの横向き、
  iPad幅の2列切替、キーボード表示中の入力・送信も未確認。899/900幅と倍率1.3/2.0の
  分岐はJestで確認済みだが、ネイティブの実画面証拠ではない。
- **演出の実操作**: iOSでカードと2択を確認したが、「今回だけ」「今後の同種類を停止」の
  選択結果、種類別停止からの再開、再起動後の非再表示は実画面では未確認（自動テストは
  `celebrations.test.ts` / `appearance-celebrations.test.tsx`）。
- **性能**: Android Emulatorのgfxinfoは取得したがSwiftShaderで実機性能を代表しない。
  iOSのprofiling、実端末の入力遅延・scroll・再描画・非表示アニメーションは未実施。
- **実機**: Simulator/Emulatorのみで、実端末・ストア配布・本番OAuth・本番通知は未確認。

### 11.4 判定

Task 18の完了条件「両OSの見た目・操作・アクセシビリティの証拠」は満たしていない。
Androidの部分証拠と両OSのビルド/ログイン証拠は記録するが、計画全体を完了扱いにしない。
本番反映は別の承認事項である。
