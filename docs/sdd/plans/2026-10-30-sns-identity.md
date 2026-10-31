# Growing Chat and Streak Appearance Implementation Plan

**Goal:** 承認済み仕様に従い、会話の累積成長と保持される本人の見た目、共有プリセット、重複しない節目演出を既存アプリへ実装する。

**Architecture:** 既存の受付トランザクション、日付順ストリーク適用、認証付きクエリと本人用revisionを拡張する。確定状態を既存リポジトリで取り込み、純粋な見た目計算、ネイティブ描画、端末内の演出記録とコーディネーターを分離する。サーバーを先に導入できる後方互換性を保ち、共有設定と本人・端末設定の所有者を混ぜない。

**Tech Stack:** Expo SDK 58.0.21、React Native 0.88.1、React 19.3.0、TypeScript、Expo Router、expo-sqlite、react-native-svg 15.16.0、react-native-reanimated 4.7.1、react-native-worklets 0.13.0、既存Supabase Postgres/Auth/Edge Functions/Realtime、Jest、React Native Testing Library、pgTAP、Deno tests、Node test runner。

**Spec:** docs/sdd/specs/2026-10-30-sns-identity-design.md

## Global Constraints

- ストリークの達成条件、抽選、送受信・未読・下書きの仕様は変更しない。ランキング、関係の採点、課金、自由な色入力・画像持ち込み、プッシュ通知、音・振動、新しい関係管理UIは対象外。
- 既存バックエンドを拡張し、別の成長サービス・認証・送信待ち基盤・定期ジョブは新設しない。ADRの3条件が全て成立する判断はなく、理由・数値・順序保証を本書に保持する。
- 同じ会話の2人が、同じ04:00 JST以上・翌04:00 JST未満の日に、それぞれ1件以上のサーバー受付済みメッセージを持つと、その会話に1日を加算する。両者の受付時刻が等しくてもよく、ストリークの厳密な返信順序を流用しない。
- 1会話・1日につき最大1回。双方が何件送っても増分は1日であり、メッセージ件数や連続日数ではない。実際の累計は100日を越えて増やし、見た目だけを100日で上限にする。
- 会話しない日や友達解除で累計を減らさない。友達でない間は凍結し、再成立後は同じ会話で再開する。ブロック等の既存送信禁止を迂回しない。
- 日付順の結果適用の中で各途中値を反映する。復旧処理の最後が0日でも、その処理内で29日へ達していればearned_days=29を保持し、見た目は7日段階とする。最終値だけを採取せず、保存値を7へ切り下げない。
- Chat GrowthとStreak Appearanceは0・1・7・30・60・100日段階で表示する。同じプリセット・明暗・端末設定なら段階間の装飾を固定し、日数と残り日数だけ更新する。100日以降はBの完成形を保つ。
- 会話詳細のチャット状態と本人状態を同じSTABLE読み取り・同じrevisionで返し、片方の別クエリが先に到着しただけで演出の順番を逆転させない。
- 自動割り当ては正規化したペアと固定版から決定的に求め、会話作成前後で変えない。最初の永続操作で保存する。自動に戻すと元の割り当てに戻り、再抽選しない。
- 操作IDと入力の一致を検証し、成功済み操作の再試行は元の結果を返すだけで再適用しない。古い成功応答を現在の設定として直接上書きせず、クエリの確定状態を取り直す。
- 共有成長と共有設定は当事者だけが取得する。関係終了後のプロフィール・現在のストリーク取得禁止は継承し、本人の見た目を相手へ返さない。ログには本文・画像・認証情報を出さない。
- 導入済みのreact-native-svgとreact-native-reanimatedで描画し、WebView、新しい描画エンジン、外部の演出サービスは追加しない。静的な模様・ステッカーと、少数の動く装飾レイヤーを分ける。
- 画面外・バックグラウンドの恒常アニメーションを止める。テーマ・成長・共有設定だけで画面を再マウントせず、入力、選択相手、スクロール位置を維持する。既存の幅900以上・文字倍率1.3以下の2列条件は変更しない。
- 通常の文字は合成後の面に対して4.5:1以上、意味のある操作境界・アイコンは3:1以上を確保する。飾りだけを読み上げ対象にせず、日数・状態を色だけで伝えない。
- 本人については現在のストリーク、獲得済みの見た目段階、次の節目を区別する。現在0日・earned_days=29なら「獲得済み：7日段階」「次の30日段階まであと30日」と表示する。保持値29を「29日段階」と呼ばず、その差だけから「あと1日」としない。
- 派手さと種類別停止は端末設定として保存する。ログアウト後も保持し、同じ端末の別アカウントにも適用する。他端末へ同期せず、マイページから再開できる。
- OSの動き軽減を起動時、設定変更時、アプリ復帰時に反映する。派手設定でも恒常的な動きを止め、節目は動かない達成表示に置き換える。控えめ・オフをOS設定で派手へ戻さない。
- 節目は1・7・30・60・100日。対象ごとに最高の未消化節目を1件だけ選び、途中の節目を連続再生しない。同じ判定で両方あればチャット、ストリークの順とし、1回のバッチは最大2件・通常約4秒となる。
- 再生開始前に、その回の対象・最高節目とそれ以下をまとめて消化済みとして端末内に保存する。保存失敗なら両方とも開始せず、成長した見た目だけ反映する。保存後の中断で見逃す可能性を許容し、必ず最後まで見せることより重複防止を優先する。
- 画面移動、選択相手変更、バックグラウンド移行、ログアウトで現在・選択表示・残りを終了する。すでに消化済みにした残りを次回再表示しない。
- 保持するのは対象を区別する内部識別子、初回基準に達したこと、その時点以下を含む消化済み節目、種類別停止の再開世代だけ。名前・User ID・本文・画像・達成内訳を演出記録に複製しない。
- 本人・各会話の最初の正規同期を、その対象の基準として保存し、そこまでの節目は演出しない。新端末・再インストール・初めて取得する会話も同じ。古い項目欠落キャッシュや未確認の仮の0日で基準を作らない。
- ログアウトでは既存のアカウントキャッシュ・下書き・画像等を従来どおり削除し、この最小限の演出記録だけを明示的な例外として保持する。別アカウントから参照せず、旧セッションのタイマー・保存完了通知・演出を復活させない。
- DBテストは専用の分離環境で行い、通常の開発DBや他作業のデータを消さない。既存の型検査、アプリ単体・統合、SQL、Edge、backend・journeyの回帰を維持する。検証環境・実測・未確認範囲を記録し、設計時点の予定と実装後の証拠を区別する。

## File Structure

- サーバー: `supabase/migrations/0023_chat_growth.sql`、`0024_streak_appearance.sql`、`0025_chat_appearance_settings.sql`、`0026_appearance_queries_realtime.sql`を追加する。既存0001〜0022は参照だけとし、適用済みSQLを編集しない。
- API: `supabase/functions/_shared/appearance-commands.ts`を追加し、`commands.ts`、`chat-queries.ts`と`app/src/backend/chat.ts`を拡張する。クライアントの見た目DTO検証は`app/src/appearance/contracts.ts`へ分離する。
- 見た目: `app/src/appearance/`へ`catalog.ts`、`calculate.ts`、`progress.ts`、`preferences.tsx`、`motion.ts`、`provider.tsx`、`AppearanceDecorations.tsx`、`AppearanceSurface.tsx`、`ProtectedSurface.tsx`を追加する。
- 共有設定: `app/src/appearance/sharedSettings.ts`と`ChatAppearancePicker.tsx`を追加する。既存の会話所有者・認証付きCommandApiを使い、送信キューへ設定変更を積まない。
- 演出: `app/src/appearance/celebrations.ts`、`visibility.tsx`、`CelebrationHost.tsx`を追加する。端末保存は`app/src/storage/appearance.ts`と既存の追加マイグレーションで扱う。
- 接続先: `app/src/daily/homeRepository.ts`、`HomeDashboard.tsx`、`app/src/messages/repository.ts`、`provider.tsx`、`chatListRows.ts`、`ChatList.tsx`、`ChatWorkspace.tsx`、`ConversationPanel.tsx`、既存Screen・ナビゲーション・認証済みルートを変更する。
- 検証: SQL・Denoの`appearance-*.test.*`、`app/src/appearance/*.test.*`、`app/__tests__/appearance-*.test.tsx`を追加する。`scripts/test-chat-backend.mjs`を専用DB・旧回帰・新演出journeyの入口として拡張する。
- 証拠: `docs/testing/sns-identity.md`、`docs/operations/sns-identity.md`、`docs/testing/screenshots/sns-identity/`を追加し、READMEへ参照を足す。既存の検証記録を今回の合格証拠へ書き換えない。

## Execution Rules

- コマンドの作業ディレクトリは全てリポジトリルート。新しいコマンドの追加先は各タスクに記載する。Task順に進め、各機能は失敗するテストを先に実行し、最小実装後に同じコマンドを再実行する。
- Task 1で追加する`--suite db`は既存`withChatTestStack`を使用する。`daily-chat-home-chat-test`、55320〜55329、seedなし、所有権確認、終了処理を維持し、SQLは一時コピーのDBでだけ実行する。専用スタックを使うコマンド同士は逐次実行する。
- 計画中のカタログv1は`b-pop`（ポップ大騒ぎ）、`b-candy`（キャンディ）、`b-soda`（ソーダ）の3項目。全てBの派手さを保つ色・模様の変種とし、A/C方向や成長量の違いにしない。本人の外枠には標準の`b-pop`を使う。
- アプリコードを書く前に`app/AGENTS.md`と[Expo SDK 58の正確な版の資料](https://docs.expo.dev/versions/v58.0.0/)を読む。ライブラリ固有の実装はその時点の版の資料で確認し、SDK・依存の追加や更新をこの機能へ混ぜない。
- SQLの時刻注入・履歴準備はDB所有者の分離テストだけで使い、公開RPC/HTTPへ日付指定や認証迂回を追加しない。新しいprivate helperは空のsearch_pathと明示的なEXECUTE権限を持ち、通常クライアントから直接呼べないことを検証する。
- 実装中のcommit単位はTask見出し。mainへの直接実装、worktree作成、push、PR、本番デプロイはこの計画の作成では行わない。実装場所はsdd-execute開始時の選択に従う。無関係な`app/mise.toml`は触らない。

## Task 1: チャット成長の保存・受付・履歴移行

**Dependencies:** なし。

**Files:** 追加`supabase/migrations/0023_chat_growth.sql`、`supabase/tests/database/appearance-growth.test.sql`。変更`scripts/test-chat-backend.mjs`、`scripts/chat-test-stack.test.mjs`。

1. 専用runnerへ`db`を追加し、一時workdirへ`supabase/tests`をコピーしてpgTAPを実行する。既存の通常状態監査を`db`にも適用し、失敗時を含むcleanupをNodeテストで確認する。`all`はDB・journey・backendを別々の所有期間で逐次実行する。
2. SQLテストを先に追加する。双方送信・一方だけ・同日多重・04:00境界・同時刻・自由な会話・画像のみ・抽選未確定/失敗・withdrawn・同日再成立・100日超過・受付全体のロールバックを検証し、新しい状態がないため失敗することを確認する。
3. 一意な日別記録と累計・固定自動プリセットを保存する。v1の自動割り当ては正規化したUUIDペアと版1の固定ハッシュから3項目を選び、既存会話と未作成会話で同じprivate helperを使う。RLS・権限を閉じ、会話作成時の初期化、抽選条件の外の受付処理、ロック下の履歴バックフィルを追加する。DB所有者fixtureから初期化helperを呼び、withdrawnを含む既存履歴の復元と再実行時の非破壊性を確認する。二重加算・選択リセットを起こさない。
4. 下記をRED→GREENで実行する。DBは全既存SQLを含め成功、Nodeは資源所有と拒否経路が成功すること。実HTTPの同時受付はTask 16で追加する。

```sh
node --test scripts/chat-test-stack.test.mjs
node scripts/test-chat-backend.mjs --suite db
```

## Task 2: ストリークの途中最大値を保持する

**Dependencies:** Task 1。

**Files:** 追加`supabase/migrations/0024_streak_appearance.sql`、`supabase/tests/database/appearance-streak.test.sql`。

1. 導入時現在値の0〜100への制限、新規ユーザー0、29→0と復旧途中29→0でearned_days=29を保持すること、再達成1〜29日で保持値を増やさず30日到達で30へ進むこと、100超、再初期化しないことをSQLテストにし、失敗を確認する。
2. 本人専用表を作り、既存`apply_daily_results`の日付順ループ内で各途中値との最大を保存する。earned_daysは表示段階へ丸めず、別ストリークの日数を加算しない。新しいprofileの初期化と導入時バックフィルを同じ追加migrationに含める。過去最高を履歴から推定せず、ストリークの達成条件・適用順・リセットは変えない。
3. 下記で新規・既存SQLが成功すること。関係削除では状態が残り、アカウント削除では既存FKの規則に従うことも確認する。

```sh
node scripts/test-chat-backend.mjs --suite db
```

## Task 3: 共有プリセットの認証付き変更コマンド

**Dependencies:** Task 1、Task 2。

**Files:** 追加`supabase/migrations/0025_chat_appearance_settings.sql`、`supabase/functions/_shared/appearance-commands.ts`、`supabase/functions/tests/appearance-commands.test.ts`、`supabase/tests/database/appearance-settings.test.sql`。変更`supabase/functions/_shared/commands.ts`。

1. `set_chat_appearance`の入力を`peer_id`・`friendship_epoch`・必須`preset_id`に閉じるテストを追加する。nullは自動、文字列はv1の既知IDだけとする。匿名・第三者・未登録・ブロック・旧世代・未知キー・直接SQL呼出しを拒否し、2人のどちらでも操作できることを検証する。
2. 既存app-command登録と操作ログを使うhandlerを実装する。同じ会話の変更を直列化し、設定版を進める。成功済みIDを再適用せず、同ID別入力は競合とする。送信前の明示保存で会話を作れるが、成長日数やストリークへ影響させない。
3. 下記をRED→GREENで実行する。SQLで後の受付優先・自動復帰・解除後閲覧/変更拒否・再成立後復元も確認する。

```sh
npx deno test --allow-env --allow-net --config supabase/functions/deno.json supabase/functions/tests/appearance-commands.test.ts
node scripts/test-chat-backend.mjs --suite db
```

## Task 4: 同一スナップショットの取得と本人用更新通知

**Dependencies:** Task 1〜3。

**Files:** 追加`supabase/migrations/0026_appearance_queries_realtime.sql`、`supabase/tests/database/appearance-queries.test.sql`、`appearance-realtime.test.sql`。変更`supabase/functions/_shared/chat-queries.ts`、`supabase/functions/tests/chat-queries.test.ts`。

1. ホーム・会話一覧・詳細の共有状態、ホーム・詳細の本人状態、第三者への非公開、未作成会話の確定0、取得で会話を作らないこと、設定だけの空会話を一覧へ出さないことをテストにする。
2. 現在の本体`query_boundary.chat_query_data`を拡張し、既存のSTABLE wrapperで同じsnapshotのrevisionを付ける。共有状態には日数、自動/選択/実効ID、カタログ版、設定版、変更可否を返す。本人状態には現在値・獲得値・版を返し、相手の本人状態は返さない。
3. 会話IDから参加者2人を解決するstatement triggerと、本人だけのtriggerを追加する。lifecycle→ペア→ユーザー→会話の順を壊さず、無変更更新・複数行・削除を検証する。Realtimeへ公開するのは既存chat_updatesだけとする。
4. 下記をRED→GREENで実行する。通常プロフィールへの現在ストリーク公開条件と既存DTO項目を維持する。

```sh
node scripts/test-chat-backend.mjs --suite db
npx deno test --allow-env --allow-net --config supabase/functions/deno.json supabase/functions/tests/chat-queries.test.ts
```

## Task 5: アプリの見た目DTOと安全な検証境界

**Dependencies:** Task 4。

**Files:** 追加`app/src/appearance/contracts.ts`、`contracts.test.ts`。変更`app/src/backend/chat.ts`と既存テストのホーム・会話fixture。

1. 正規の0、100超のチャット累計、本人0〜100、必須null、未知版/ID、不正数値、項目欠落をテストにする。新規項目が壊れていても正常なメッセージ・入力用の関係情報を破棄しない契約にする。
2. Edge DTOと一致するwire型と検証関数を作る。表示用は確定値と利用不能を明示的に分け、欠落を0へ変換しない。未知版の装飾を実行せず、core responseの既存検証と認証所有者照合を維持する。
3. 下記をRED→GREENで実行する。既存fixtureは実際の新サーバー値を表すよう更新し、旧キャッシュfixtureは欠落したまま残す。

```sh
npm --prefix app test -- --runInBand --runTestsByPath src/appearance/contracts.test.ts
npm --prefix app run typecheck
```

## Task 6: 確定状態を既存リポジトリで同期する

**Dependencies:** Task 5。

**Files:** 追加`app/src/appearance/observations.ts`、`observations.test.ts`。変更`app/src/daily/homeRepository.ts`、`app/src/messages/repository.ts`、`provider.tsx`、`chatListRows.ts`と対応する既存テスト。

1. 応答の逆順、revision不一致、別相手、アカウント変更、ログアウト中のcommit、旧キャッシュ、オフライン、設定のみの空会話をテストにする。ホーム先着でストリークだけを先に演出候補へ出す失敗も再現する。
2. 表示用キャッシュと正規取得の観測を分ける。観測にはaccount・peer・revision・所有者寿命を付け、ホームの本人状態と会話詳細内の同時点の本人/共有状態を区別する。会話表示中の演出判定には詳細の組だけを渡し、別取得の本人値を先行再生しない。
3. 既存session.commit、世代、日付、未読、カーソル、明示的「最新へ」の保護を維持して状態を保存する。オフラインでは直近の利用可能な確定表示、未取得では確認中を返す。キャッシュ再生を初回基準用の正規同期にしない。
4. 下記をRED→GREENで実行し、更新通知は再取得の合図であって達成イベントではないことを確認する。

```sh
npm --prefix app test -- --runInBand --runTestsByPath src/appearance/observations.test.ts src/messages/repository.test.ts __tests__/home-chat-home.test.tsx __tests__/home-chat-realtime.test.tsx
npm --prefix app run typecheck
```

## Task 7: Bのカタログ・段階計算・進捗文言

**Dependencies:** Task 5。

**Files:** 追加`app/src/appearance/catalog.ts`、`calculate.ts`、`progress.ts`、`calculate.test.ts`、`progress.test.ts`。

1. 全3プリセット・両明暗・0〜100の全整数日と101日・全3派手さの組を列挙するテストを作る。0→1、6→7、29→30、59→60、99→100の切替と、1〜6・7〜29・30〜59・60〜99・100日以降の装飾不変を確認する。0日モノクロ、1日が完成形でないこと、同じ入力の決定性、通常文字4.5:1・操作境界3:1を検証する。
2. カタログに節目`[1,7,30,60,100]`と、未到達なら0・到達済みの最大節目を返す共通の段階計算を置く。チャットはgrowth_days、本人はearned_daysから段階sを求め、`x=s/100`、色`x**0.72`、模様`x**1.15`、発光`x**1.5`、追加装飾`x**1.7`、動き`x**1.2`とする。生の日数で補間せず、プリセット・明暗・端末設定が同じなら段階間は同じ装飾を返す。ライト/ダークは別配色にし、キャンディ/ソーダも同じ成長量で色・模様だけを変える。Bの100日完成形は変えない。
3. 動く模様を文字の直下に透過合成し続けないよう、不透明で対比を保証できる本文面を計算結果へ含める。保護された表面は既存tokensを使う。名前・アイコン・状態の色以外の識別を残す。
4. 進捗文言と演出判定は共通の節目を使う。現在0・earned_days=29なら獲得7日段階・次30まで30日、現在29なら同じ7日段階・残り1日、現在30なら30日段階、獲得100なら最大段階、チャット101なら累計101・見た目100を検証する。段階内でも日数・残り日数は更新するが、段階バーは未獲得部分を日々塗り足さない。下記をRED→GREENで実行する。

```sh
npm --prefix app test -- --runInBand --runTestsByPath src/appearance/calculate.test.ts src/appearance/progress.test.ts
npm --prefix app run typecheck
```

## Task 8: 演出記録と端末設定の永続化

**Dependencies:** Task 5。

**Files:** 追加`app/src/storage/appearance.ts`、`app/__tests__/appearance-storage.test.tsx`。変更`app/src/storage/migrations.ts`、`database.ts`、`app/src/auth/logout.ts`、既存storage/logoutテスト。

1. 実SQLiteで現行schema v2からの追加migration、失敗時のversion/DDLロールバック、最大2件の一括消化、1・7・30・60・100日の単調な消化済み節目、別アカウント、再ログイン、通常データ削除を先にテストする。既存テストの現行schema固定値は新しいSCHEMA_VERSIONに追従させ、旧版migrationの検証を消さない。
2. アカウント・種類・対象内部IDを主キーにした最小限の演出記録を作る。会話は相手IDで識別し、conversation_idやfriendship_epochの変更で別記録にしない。初回基準、消化済み最高節目、再開世代だけを保持する。
3. 初回基準保存とバッチ消化をwrite transactionにし、失敗を呼出側へ返す。旧寿命の書込みをcommit直前にも拒否する。端末設定には派手さ、2種類の有効フラグ、再開世代を保存し、変更と世代更新を同じtransactionにする。
4. deleteAccountDataで通常キャッシュ・下書き・画像・保留操作は消し、演出記録と端末設定だけを明示的例外にする。例外の列へ名前・本文等を入れられないことを検証する。下記をRED→GREENで実行する。

```sh
npm --prefix app test -- --runInBand --runTestsByPath __tests__/appearance-storage.test.tsx __tests__/home-chat-storage.test.tsx __tests__/storage.integration.test.ts __tests__/logout-entry.test.tsx
npm --prefix app run typecheck
```

## Task 9: 派手さ・種類別停止・OS動き軽減の設定

**Dependencies:** Task 7、Task 8。

**Files:** 追加`app/src/appearance/preferences.tsx`、`motion.ts`、`preferences.test.tsx`、`motion.test.ts`、`app/src/app/(tabs)/mypage/appearance.tsx`。変更`app/src/app/_layout.tsx`、`app/src/app/(tabs)/mypage/index.tsx`、`_layout.tsx`。

1. 初期値が派手/両演出オン、同端末の別アカウントへ共通、再起動保持、読み込み中/失敗では再生不可、保存失敗の起動中適用と再試行をテストする。控えめは色を保って動きと節目を停止、オフは明暗別モノクロであることを確認する。
2. ThemeProviderの明暗・時間帯設定は変えず、その内側へ独立した設定providerを接続する。この時点では設定だけを管理し、装飾の適用はTask 12で行う。マイページへ新しい画面を追加し、4タブを増やさない。再開で有効化された種類だけ世代を進め、再起動や通常の前景復帰では進めない。
3. 動き軽減の初期取得・起動中購読・復帰再取得を注入可能なportで実装する。設定変更中の古い非同期応答を排除する。OS軽減は派手時の静止達成表示へ置換し、控えめ/オフの停止を解除しない。
4. 下記をRED→GREENで実行する。端末設定はアカウントの通常purgeやサーバー同期へ渡さない。

```sh
npm --prefix app test -- --runInBand --runTestsByPath src/appearance/preferences.test.tsx src/appearance/motion.test.ts __tests__/theme-layout.test.tsx __tests__/navigation-shell.test.tsx
npm --prefix app run typecheck
```

## Task 10: 共有プリセットの結果不明回復と選択UI

**Dependencies:** Task 3、Task 6〜9。

**Files:** 追加`app/src/appearance/sharedSettings.ts`、`sharedSettings.test.ts`、`ChatAppearancePicker.tsx`、`app/__tests__/appearance-picker.test.tsx`。変更`app/src/messages/ConversationPanel.tsx`、`provider.tsx`。

1. 見本閲覧では未変更、明示適用でのみ送信、オフライン拒否、二重押下、同ID回復、成功済み旧応答、再起動、旧関係世代、account停止をテストする。メッセージ入力・送信を巻き込まないことも確認する。
2. 既存CommandApi.sendを使い、送信前にaccount cacheへ操作ID・元の入力・dispatch状態を保存する。通常outboxへは積まない。dispatch後の通信失敗を未受付と断定せず、同IDの「結果を確認」で解決する。未解決中は新しい設定変更を確定できず、別ID・新世代へ自動変換しない。
3. 変更成功は表示へ直接反映せず、確定クエリを再取得する。ピッカーは最後の確定設定・共有である説明・自動復帰を表示し、関係終了後は閲覧だけにする。画面離脱後に届く応答を現在の会話へ適用しない。
4. 下記をRED→GREENで実行する。保留操作はログアウト時に消える通常account cacheであり、演出記録の保持例外へ混ぜない。

```sh
npm --prefix app test -- --runInBand --runTestsByPath src/appearance/sharedSettings.test.ts __tests__/appearance-picker.test.tsx __tests__/home-chat-conversation.test.tsx
npm --prefix app run typecheck
```

## Task 11: ネイティブの静的・恒常装飾レイヤー

**Dependencies:** Task 7、Task 9。

**Files:** 追加`app/src/appearance/AppearanceDecorations.tsx`、`AppearanceSurface.tsx`、`ProtectedSurface.tsx`、`app/__tests__/appearance-surfaces.test.tsx`。

1. 計算済み表示値を渡す描画テストを追加する。decorative treeが読み上げ/タッチ対象でないこと、本文・入力を動かさないこと、画面外停止、控えめ/オフ/OS軽減を検証する。
2. SVGで静的な模様・ステッカーを描き、Reanimatedで少数の背景要素だけをゆっくり動かす。毎フレームReact stateを更新しない。日数や色の更新でchildrenを再マウントせず、乱数で模様を振り直さない。
3. protected surfaceは既存明暗tokensを維持する。wrapperの測定や重なりでレイアウト・safe area・keyboardを変えず、100日でも本文領域を奪わない。下記をRED→GREENで実行する。nativeの実性能合格はTask 18で判断する。

```sh
npm --prefix app test -- --runInBand --runTestsByPath __tests__/appearance-surfaces.test.tsx
npm --prefix app run typecheck
```

## Task 12: 認証済み画面・会話への階層適用

**Dependencies:** Task 6、Task 9〜11。

**Files:** 追加`app/src/appearance/provider.tsx`、`app/__tests__/appearance-layout.test.tsx`。変更`app/src/app/_layout.tsx`、`app/src/app/(tabs)/_layout.tsx`、`app/src/app/(tabs)/mypage/index.tsx`、`app/src/app/conversations/[peerId].tsx`、`app/src/ui/Screen.tsx`、`app/src/navigation/AdaptiveLayout.tsx`、`app/src/daily/HomeDashboard.tsx`、`app/src/messages/ChatList.tsx`、`ChatWorkspace.tsx`、`ConversationPanel.tsx`。

1. 認証画面は無装飾、認証済み外枠は本人、会話背景/吹き出しは共有、入力/エラーは標準配色となるテストを書く。テーマ・日数・設定切替で下書き/スクロール/選択を保持し、未読badgeや4タブを変えないことを検証する。
2. ThemeProviderと既存chat所有者の内側へ表示providerを接続する。認証済み主要画面と独立会話ルートを明示的に適用し、ルート全体への無条件の派手tokens差替えは行わない。無効/未取得は安全なモノクロへ戻す。
3. ホーム/マイページの現在値・獲得済み段階・次節目、会話ヘッダーの累計・次節目、一覧の小さな印を接続する。29日からリセット後の「現在0日・獲得7日段階・次30まで30日」をUIでも検証する。会話の名前/画像と既存送信状態を残す。表示値が不明なら確認中であり、0日の達成済み表示にしない。
4. 下記をRED→GREENで実行する。幅899/900、倍率1.3/超過と200%、独立routeとsplit内の同じ会話を検証する。

```sh
npm --prefix app test -- --runInBand --runTestsByPath __tests__/appearance-layout.test.tsx __tests__/theme-layout.test.tsx __tests__/home-chat-home.test.tsx __tests__/home-chat-list.test.tsx __tests__/home-chat-conversation.test.tsx __tests__/tab-behavior.test.tsx
npm --prefix app run typecheck
```

## Task 13: 初回基準・停止世代・順次再生の状態機械

**Dependencies:** Task 6〜9。

**Files:** 追加`app/src/appearance/celebrations.ts`、`celebrations.test.ts`。

1. 注入した時計・正規観測・可視性・設定・永続portで状態機械のテストを書く。初回0/既存100、相手ID継続、1・7・30・60・100日の達成だけを候補とし3日・14日の達成候補は作らないこと、1日・7日消化後の3日・14日では候補が増えず未消化なら通常の追いつき規則に従うこと、29日から60日へ進んだとき最高60日だけを選ぶこと、チャット→本人の最大2件、保存待ち/失敗、保存直後の終了を先に失敗させる。
2. 待機→保存中→再生中→選択待ち→終了を実装する。Task 7の共通節目を使い、対象ごとの基準化と、今回選ぶ全件の消化を保存してから約2秒ずつ再生する。保存中の状態変更では開始を再検査し、失効した旧寿命で再生しない。最新観測から再判定し、無制限の待ち行列を作らない。
3. 控えめ/オフ/種類別停止中の同期は基準化し、再開世代の最初の同期も過去分を演出しない。一覧で更新した通常の未消化チャットを消費せず、初回/停止分だけを基準化する。キャッシュだけで基準・再生を進めない。
4. スキップは現在1件を止めて非モーダル選択を待ち、今回だけ/同種類停止を処理する。選択待ち中の新観測・停止保存失敗・次の別種類・画面離脱・背景・ログアウトをテストする。下記をRED→GREENで実行する。

```sh
npm --prefix app test -- --runInBand --runTestsByPath src/appearance/celebrations.test.ts __tests__/appearance-storage.test.tsx
npm --prefix app run typecheck
```

## Task 14: 演出ホスト・可視性・重要確認の遮断

**Dependencies:** Task 12、Task 13。

**Files:** 追加`app/src/appearance/visibility.tsx`、`CelebrationHost.tsx`、`app/__tests__/appearance-celebrations.test.tsx`。変更`app/src/appearance/provider.tsx`、`app/src/app/_layout.tsx`、`app/src/messages/ConversationPanel.tsx`、`ChatWorkspace.tsx`、`ImageViewer.tsx`、`app/src/sync/SyncStatus.tsx`、`app/src/requests/RequestList.tsx`、`app/src/invitations/InvitePanel.tsx`、`app/src/app/(tabs)/mypage/index.tsx`、`edit.tsx`、`conflict.tsx`。

1. 非表示のmountedタブ、独立会話route、split相手切替、重要確認、画像viewer、背景、logoutと遅延保存完了をUIテストにする。ホーム応答が先でも可視会話の組が揃うまで本人演出を先行させない。
2. 認証寿命・route focus・前景・実際の会話表示を一つのvisibility portへ渡す。確認中は開始禁止、開始済みなら残りも終了とする。再送/ログアウト/申請判断/招待再発行/プロフィール上書き等の既存確認を登録・解除し、unmount時の解除を保証する。
3. 装飾表示と操作部を分け、入力・送信・スクロールを止めない。チャットと本人を別の約2秒表示にし、スキップ2択は小さな非モーダル面へ置く。OS軽減時は静止表示、控えめ/オフ時は表示なしとする。音・振動・強い点滅を追加しない。
4. 下記をRED→GREENで実行する。破棄済みbatchの再表示、画面移動を待たせる確認dialog、複数providerによる重複ホストを作らない。

```sh
npm --prefix app test -- --runInBand --runTestsByPath __tests__/appearance-celebrations.test.tsx __tests__/logout-entry.test.tsx __tests__/profile-request.test.tsx __tests__/home-chat-send.test.tsx __tests__/home-chat-realtime.test.tsx
npm --prefix app run typecheck
```

## Task 15: 既存HTTP・journey回帰を分離環境で実行する

**Dependencies:** Task 1〜14。

**Files:** 追加`scripts/appearance-regression-harness.test.mjs`。変更`scripts/test-chat-backend.mjs`、`scripts/test-local-backend.mjs`、`app/__tests__/app-journey.test.tsx`、`app/testSupport/localEnv.ts`。

1. 旧backendと旧journeyが専用status/workdirを受け取り、通常環境へ接続しない入口をNodeテストにする。未指定時の既存CLIは従来の接続を保ち、専用モードはworkdir・project・portの検証必須とする。
2. 旧HTTP suiteの実行本体を明示的なstatus注入で呼べるようexportする。旧journeyには専用runnerから渡す厳密な設定だけを許可し、実Auth・実HTTP・既存assertionを維持する。通常環境と専用環境の一致確認を無効化するのではなく、選んだ専用statusとの一致を検証する。
3. 専用runnerへ`--suite legacy`を追加し、旧HTTP全群と旧journeyを専用スタックで逐次実行する。`all`にも含める。実データのfixtureは所有するAuthユーザーだけをcleanupし、終了時の通常DB digest・config・dotenv・コンテナ不変監査を維持する。
4. 下記をRED→GREENで実行する。環境不足をskip/成功へ変えず、旧suiteの件数やassertionを減らさない。

```sh
node --test scripts/appearance-regression-harness.test.mjs
node --test scripts/chat-test-stack.test.mjs
node scripts/test-chat-backend.mjs --suite legacy
```

## Task 16: 実HTTPと実SQLiteの成長・設定・演出journey

**Dependencies:** Task 15。

**Files:** 追加`app/__tests__/appearance-journey.test.tsx`。変更`scripts/test-chat-backend.mjs`、`scripts/lib/chat-fixtures.cjs`と必要な専用journey設定型。

1. backend suiteへ同時受付の1日1回、日別記録と累計一致、第三者取得/変更拒否、旧クライアント入力、設定競合、同ID再実行、失われた応答の回復、空会話非表示を追加する。
2. 新しい画面journeyはA/BとAの第2端末、実Auth/Edge/Realtime/SQLiteで実行する。初回基準→両者送信→両端末同じ成長→共有preset→本人の外枠→チャット/本人順次→一個スキップ→種類別停止/再開→再起動/再ログイン→別account分離を通す。29→0で7日段階を保持し再び30日で次段階へ進むこと、59→60の見た目と演出、1日・7日消化後の3日・14日で新規演出が増えないことも確認する。全節目の時間経過を待たず、所有fixtureの受付履歴/日次結果だけを専用DBで準備する。
3. 専用runnerへ`--suite appearance`を追加する。rendererだけでnative描画/読み上げの合格にはしない。backend・旧journey・新journeyで独立したfixture所有期間を持ち、全client・timer・serve・stackを終了する。
4. 下記をRED→GREENで実行する。新しいbackend assertionは`--suite backend`にも含め、`all`に新suiteを含める。

```sh
node scripts/test-chat-backend.mjs --suite backend
node scripts/test-chat-backend.mjs --suite appearance
```

## Task 17: 全回帰・移行手順・検証記録を揃える

**Dependencies:** Task 16。

**Files:** 追加`docs/testing/sns-identity.md`、`docs/operations/sns-identity.md`。変更`DEVELOPMENT.md`。必要な回帰修正は失敗した責務のファイルとテストに限定する。

1. 全自動回帰を下記の順で実行し、実行時刻・commit・環境・exit code・件数・失敗を記録する。通常Jestから実バックエンドの3journeyだけを除外し、それらは専用runnerの`all`で必ず実行する。専用stackのコマンドを並列実行しない。
2. 移行runbookへサーバー/Edge先行→アプリの順、ロックとバックフィル、本人の導入時現在値、再実行の非破壊性、旧cache確認中、初回基準、未知版fallback、演出保存失敗、設定の同ID結果確認を記載する。migration/RLS/通知対象の検査と日別件数対累計の照合SQLをそのまま実行できる形で載せる。
3. 途中失敗を後の成功へ書き換えず、通常状態不変監査と専用資源のcleanup結果を記録する。通常DBのreset・本番push・外部job登録は行わない。両OS手動確認欄は証拠が入るまで未確認として残し、Task 18を代替しない。

```sh
npm --prefix app run typecheck
npm --prefix app test -- --runInBand --testPathIgnorePatterns 'app-journey.test.tsx|home-chat-journey.test.tsx|appearance-journey.test.tsx'
npx deno test --allow-env --allow-net --config supabase/functions/deno.json supabase/functions/tests
node --test scripts/chat-test-stack.test.mjs
node --test scripts/appearance-regression-harness.test.mjs
node scripts/test-chat-backend.mjs --suite all
git diff --check
```

## Task 18: 両OSの見た目・操作・アクセシビリティを実証する

**Dependencies:** Task 17。

**Files:** 変更`docs/testing/sns-identity.md`、`docs/operations/sns-identity.md`。追加`docs/testing/screenshots/sns-identity/`内の匿名化した必要最小限の証拠。

1. 下記で両OSの開発buildを用意し、実行環境・対象端末・OS・build SHA・認証方法を記録する。本人の対話認証や端末操作が必要なら利用者へ依頼し、認証迂回や固定の本番達成値注入で代用しない。起動commandの常駐/timeoutとnative build成功、操作成功を区別する。
2. 両明暗の0・1・6・7・29・30・59・60・99・100・101日を、専用の所有fixtureまたは純粋描画の開発用検証画面で比較する。段階間の装飾不変、日数だけの更新、100日以降の完成形保持、ストリークリセット後の保持段階と次節目案内を確認する。検証画面での表示と本番取得の達成を混ぜない。全preset、控えめ/オフ、明暗/時間帯変更、共有変更の相手端末反映を確認する。
3. 小画面、横向き、文字200%、safe area、キーボード、2列切替、VoiceOver/TalkBack、OS軽減の起動中変更、重要確認、再起動を両OSで確認する。100日＋節目再生中にも本文入力・送信・履歴scrollが続き、背景化で動き/残り再生が止まることを動画または操作記録で示す。
4. 代表端末で0日と100日の同じ操作を比較し、入力遅延・scroll引っ掛かり・繰返しlayout/React再描画・非表示アニメーションの有無をprofilingと観察で記録する。固定FPSの新たな合格値は作らず、操作を妨げる退行を修正する。修正した場合はTask 17の全自動回帰コマンドと影響した両OSの操作を再実行する。
5. 個別結果と証拠の範囲を記録する。HTML試作・renderer・buildだけでは完了としない。両OSの必要な操作が実施できなければ阻害条件を報告し、計画全体を完了扱いにしない。本番反映は別の承認事項とする。

```sh
npm --prefix app run ios
npm --prefix app run android
git diff --check
```
