# Daily Chat 開発・検証ガイド

開発環境の起動、二者での動作確認、自動テスト、トラブル対処の詳細です。
作品の概要とクイックスタートは [README.md](README.md) を参照してください。

- [構成](#構成)
- [前提条件](#前提条件)
- [1. ローカルバックエンド (Supabase) の起動](#1-ローカルバックエンド-supabase-の起動)
- [2. アプリ (Expo) の起動](#2-アプリ-expo-の起動)
- [3. 招待 Web のビルドと確認](#3-招待-web-のビルドと確認)
- [4. 環境変数](#4-環境変数)
- [5. 動作確認と自動テスト](#5-動作確認と自動テスト)
- [6. トラブルシューティング](#6-トラブルシューティング)

## 構成

| ディレクトリ | 内容 |
| --- | --- |
| `app/` | Expo 58 / RN 0.88.1 / React 19.3 アプリ本体 (`package.json` の `scripts` が起動定義) |
| `supabase/` | ローカル Supabase 設定・マイグレーション・Edge Functions |
| `invite-web/` | 招待ランディングの静的サイト (ソースのみ。`dist/` はビルド生成・git 管理外) |
| `scripts/` | 招待 Web ビルド・ローカル統合テスト・ネイティブ設定チェッカー |

## 前提条件

- Node.js 22系は22.13+、24系は24.3+、または26以降の偶数メジャー（Expo SDK 58要件。23・25系は非対応。テストでは `node:sqlite` も使用。SDK 58検証時: v26.12.1）
- Docker 起動中 (ローカル Supabase 用)
- Supabase CLI（ホーム・チャット検証時: 2.122.0。以下では `npx supabase` を使用）
- iOS: macOS・Xcode・シミュレータまたは開発用実機（SDK 58検証時: Xcode 27.1）。Android: Android SDK・JDK 17・接続デバイスまたはAVD
- Edge Function の単体テスト用に Deno (実行形は `npx deno test ...`。本環境未導入でも他は動く)

## 1. ローカルバックエンド (Supabase) の起動

すべてリポジトリルートで実行。

Google OAuthが有効な構成では、ルートの `.env` に `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET` と
`SUPABASE_AUTH_EXTERNAL_GOOGLE_REDIRECT_URI` を用意する。後者はシミュレータ用なら
`http://127.0.0.1:54321/auth/v1/callback`、iPhone実機用は[認証コールバック専用HTTPSトンネル](docs/operations/iphone-local-oauth.md)を使う。

```sh
# 初回 / Docker イメージ取得後
npx supabase start

# 起動確認（ローカル資格も含むため、出力をチャット・スクリーンショット・Gitへ貼らない）
npx supabase status --output json

# 追加migrationを適用する（既存データを消すresetは通常検証で使わない）
npx supabase migration up --local
```

ローカルポート (既定): API `54321` / DB `54322` / Studio `54323` / Mailpit `54324`。

アプリで友達一覧・マイページなどを操作するときは、ローカルの Edge Functions も起動したままにする。`supabase start` で Auth が応答していても、`/functions/v1/app-query` が HTTP 503 (`name resolution failed`) の場合は関数ランタイムが停止している。

```sh
npx supabase functions serve
```

このコマンドは別のターミナルで起動し、アプリを使う間は終了しない。統合テストランナーは独自に関数を起動・停止するため、テスト後にアプリで 503 が出た場合は上記コマンドを再起動する。

## 2. アプリ (Expo) の起動

### 2.1 `app/.env` を用意する (git 管理外)

未作成の場合のみコピーする。既存の `app/.env` は上書きしない。

```sh
cp app/.env.example app/.env
```

通常ローカル環境と既存journeyの検証用に、`app/.env` の URL / anon key を
`npx supabase status` の値と**完全一致**させる（不一致だとjourneyテストが拒否する）。
テンプレートのダミー値は実値へ置き換える。招待を試さない場合、例示の `EXPO_PUBLIC_INVITE_ORIGIN` は削除またはコメントアウトする。

```dotenv
EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
EXPO_PUBLIC_SUPABASE_ANON_KEY=<supabase status の ANON_KEY>
```

`SERVICE_ROLE_KEY`・JWT secret・OAuth secretはアプリへ入れない。使うのは公開用anon keyのみ。
値が無い状態で起動すると、アプリはプレースホルダを作らず**明確なエラー表示で停止**する
(`src/backend/client.ts` の `SupabaseConfigError`)。

### 2.2 起動コマンド (`app/package.json` の定義どおり)

```sh
cd app
npm ci

# Metro 開発サーバー (全インターフェースで待つ。--localhost は IPv6 のみ bind され
# 実機接続で失敗することがあるため --port 8081 を使う)
npx expo start --dev-client --lan --port 8081

# 初回・ネイティブ依存変更時の開発ビルド（別ターミナルで実行）
npm run ios
npm run android

# Web 確認用
npx expo start --web

# 型検査 / テスト
npm run typecheck
npm test -- --runInBand --testPathIgnorePatterns home-chat-journey.test.tsx
```

Expo Goではなく、上記でインストールした開発ビルドを開く。Web表示はネイティブ画像処理・SQLite・OS動作の確認には代用できない。
ビルド後は **Metro接続 → ログイン画面 → 本人認証 → ホーム表示**まで確認する。
開発ビルドのランチャーや `Build Succeeded` が見えただけでは、アプリの動作確認完了ではない。

#### 開発用：ストリーク見た目のプレビュー

開発ビルド（`__DEV__`）では、画面右下の `DEV` からストリーク／チャット成長の表示だけを切り替えられる。
0・1・7・30・60・100日と「リセット中（現在0日・獲得29日）」を選べ、ホーム・マイページの背景、
模様、段階表示、会話画面の「累計N日」がその場で変わる。`サーバーの値に戻す` で解除する。

この操作は表示だけを差し替え、Supabaseの記録・SQLite・実際の節目演出は変更しない。
リリースビルドではボタン自体が表示されない。実データでの達成・演出まで確認するときは、
実際の連続日数を進めるか、検証用のバックエンド状態を用意する。

#### 実機・Androidエミュレータから接続する場合

`127.0.0.1` は端末自身を指すため、開発PCのSupabaseへ届かない。実機はPCと同じ信頼できるLANへ接続し、
PCのLANアドレスへ到達できることを確認する。`app/.env` は通常テスト用のままにして、
**端末向け起動のプロセスだけ**URLを上書きする（`<PCのLANアドレス>`は実際の値へ置換）。

```sh
# app/ で実行。括弧内だけに適用し、通常テストの接続先を変えない
(
  export EXPO_PUBLIC_SUPABASE_URL="http://<PCのLANアドレス>:54321"
  npx expo start --dev-client --lan --port 8081
)
```

anon keyは同じローカルプロジェクトのものを使う。アプリのURLを変えた後はバンドルを再読み込みする。
Metroの `8081` とSupabaseの `54321` は別の接続先であり、両方への通信が必要。
Metroだけをトンネル化してもローカルSupabaseは公開されない。DB・Studioやサービス資格をインターネットへ公開しない。
OAuthの許可済みリダイレクト・プロバイダーcallbackも対象環境に合っている必要がある（次節）。

iPhoneのUSB接続は `127.0.0.1` をMacへ転送しない。Googleログイン直後に同じ接続エラーへ戻る場合は、
アプリのAPI URLとは別に[GoogleからSupabaseへの戻り先](docs/operations/iphone-local-oauth.md)を設定する。
認証専用トンネルは `app/` で `npm run tunnel` を実行するとプロキシとまとめて起動できる（終了は `Ctrl+C`）。

### 2.3 ホーム・チャットの手動確認

#### 準備

1. 同じバックエンドへ接続した開発ビルドを2台（実機／シミュレータ／エミュレータ）用意する。
2. 別々のApple／GoogleアカウントでA・Bとしてログインし、未登録ならUser ID・表示名を確定する。
   メール／パスワードログインやテストログイン画面はない。現在のローカル設定ではGoogleが有効、Appleは無効。
   Google側の資格・許可済みcallback・アプリへの復帰設定と、本人の同意操作が必要。認証を迂回しない。
3. 「友達」から相手のUser IDを検索して申請し、相手の申請一覧で承認する。
   友達成立後は、今日の割り当てがなくても会話できる。
4. 向きの目印付きJPEG・透過PNG・HEICを写真ライブラリに用意する。個人情報を含まない画像を使う。

#### 基本シナリオと期待結果

| 手順 | 確認すること |
| --- | --- |
| Aが友達プロフィールの「メッセージ」またはチャットの「新しいチャット」からBを開く | 同じ会話へ入り、戻ると元画面へ戻る。開いただけで空の履歴を作らない |
| Aが本文、画像のみ、本文＋画像を送信する | Bに同じ内容・画像順で届く。受付後は送信待ちではなく確定表示になり、画像を拡大できる |
| Aが入力途中で別の相手・タブへ移動し、アプリを再起動する | 相手別の下書きと添付が残り、別の相手の入力と混ざらない |
| Bが別画面を表示中にAが送信する | チャットバッジは未読のある**相手人数**、各行はメッセージ件数。バナーは相手名と「新しいメッセージ」のみで、本文・画像・音を出さない |
| Bが同じ会話を前景表示したまま新着を受ける | 同じ相手のバナーは重ならない。過去を閲覧中は勝手に末尾へ移動しない |
| Bが一部だけ閲覧し、その後「最新へ」を押す | 通常は表示した受信分だけ未読解消。「最新へ」は取得した位置までで、後着分を巻き込まない。同期中表示と件数・バッジが矛盾しない |
| Aをオフラインにして同じ相手へ順に送信予約し、接続を戻す | 入力・画像が失われず、相手別に予約順で送られる。別の相手の送信は独立して進む |
| 会話の「共通の送信状況」またはマイページの送信状況を開く | 送信待ち・確認が必要・結果確認中を区別する。取りやめは未送信と確定できる項目のみ。結果不明を別の新規送信で代用しない |
| Aの別端末でも同じ会話を開く（任意の3台目） | 表示済み受信の和集合が同期し、古い端末からの同期で未読へ戻らない |
| ログアウトする | 未送信・結果不明の説明を確認でき、確定後は旧アカウントの処理・購読を再開しない |

#### 今日の達成を確認する

- 日付は **04:00 JST** で切り替わり、抽選は **04:05より前**に確定する。端末時計を変えてもサーバーの日付は変わらない。
- 友達になった当日は「次の抽選から参加」になる場合がある。対象者を捏造せず、自由な会話とは分けて確認する。
- 日次ワーカーは `functions serve` だけでは定期起動されない。[サービス認証・起動手順](docs/operations/home-chat.md)に従って担当者が設定する。本番ジョブは未登録。
- 対象確定日に、ホームのSend Targetへ送り、全Reply Targetからの受信**より厳密に後**に返信する。
  相互対象なら「A送信 → B返信 → Aがさらに返信」が必要になる場合がある。
  送信予約だけでは達成にならず、「今できることは完了」と全条件の達成も別。
- 04:00／04:05の再取得で会話・下書きを失わず、古い対象者を今日として表示しないことを確認する。
  時刻・関係世代・応答喪失などの再現が難しい条件は、[専用自動テスト](#51-まずホームチャットを実バックエンドで確認する)で検証できる。

#### 両OSの手動確認項目

iOS・Androidの両方で、JPEG／透過PNG／HEIC・向き・縮小、再起動、文字200%、小画面・横向き、
ライト／ダーク、VoiceOver／TalkBack、写真権限拒否・限定許可、背景復帰を確認する。
2列は論理幅900以上かつ文字倍率1.3以下のみ。それ以外へ切り替えても選択相手・入力を保つ。

本文は10,000書記素、添付は4枚まで・元と変換後それぞれ10MiB以下・変換後の長辺2048px以下。
超過や変換失敗時に入力が残ることも確認する。OS通知許可要求・プッシュ・送信済み編集／取消は今回の対象外。
再検証時は端末・OS・build SHA・日時・期待／実測・画像や動画を[検証記録](docs/testing/home-chat.md)へ記録する。
上記の手動確認は両OSとも利用者から完了報告を受領済み。個別の端末情報・画像や動画が提出されたという意味ではない。

## 3. 招待 Web のビルドと確認

`invite-web/` は `index.html` / `app.js` / `styles.css` + 生成される `runtime-config.js` と
関連付けファイルからなる静的サイト。チェックイン済みの `runtime-config.js` は未設定 (`null`) の
スタブで、ビルド時に上書きされる。実値はリポジトリに存在しない。

```sh
# 実値ビルド (6つの環境変数を供給済みの場合。出力は invite-web/dist/・git 管理外)
node scripts/build-invite-web.mjs --out invite-web/dist

# 検証専用ビルド (.test ドメインの fixture。TEST-ONLY-OUTPUT.txt 付き・公開禁止)
node scripts/build-invite-web.mjs --test-config --out invite-web/dist-test

# 自動検証
EXPO_NO_DOTENV=1 node --test scripts/invite-web.test.mjs
```

値なしで実行すると「不足している変数名を全部挙げて失敗する」が**正しい挙動** (疑似値は作らない)。
配信時は出力ディレクトリを `INVITE_ORIGIN` の HTTPS ルートに設置し、
`/invitation/<32桁hex>` が `index.html` を返すこと、
association の 2 ファイルがリダイレクト無し (200・`redirect_url` 空) で配信されることを確認する
(手順は `docs/operations/...` の「招待Web・ドメイン関連付け」節)。

## 4. 環境変数

### 4.1 アプリ (`app/.env`。git 管理外。テンプレート: `app/.env.example`)

`EXPO_PUBLIC_` 接頭辞の値はバンドルへ**平文で入る**。秘密値 (クライアントシークレット等) を入れない。

| 変数 | 用途 | 形式・例 | 必須度 |
| --- | --- | --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase API URL | ローカル `http://127.0.0.1:54321` / 本番 `https://<project-ref>.supabase.co` | 必須 |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | anon / publishable key | ローカルは `supabase status` の値 | 必須 |
| `EXPO_PUBLIC_INVITE_ORIGIN` | 招待リンク・QR の origin (アプリが読む) | HTTPS origin・パスなし (例 `https://invite.example.com`)。欠落時はリンク生成が変数名入りのエラーで失敗 | 招待機能に必須 |
| `INVITE_ORIGIN` | 同 origin (expo config のドメイン配線が読む)。`app/.env` 追記でも可 (expo CLI が `.env` を読む) | 同上。両方設定時は**一致必須** (食い違いはビルドエラー) | `EXPO_PUBLIC_INVITE_ORIGIN` とどちらか片方あれば可 |

### 4.2 招待 Web ビルド・配布準備の6入力 (既定値なし。シェル環境変数で供給)

検証ロジックの正本は `scripts/invite-web-config.mjs`。

| 変数 | 内容・形式 |
| --- | --- |
| `INVITE_ORIGIN` | HTTPS 招待ドメインの origin。スキーム `https`・ホストのみ (パス・ポート・認証・クエリ不可。末尾スラッシュは許容) |
| `IOS_BUNDLE_ID` | iOS bundle id (逆 DNS)。`app/app.json` の `ios.bundleIdentifier` と一致必須 |
| `APPLE_TEAM_ID` | Apple Developer Team ID (英数10文字) |
| `APP_STORE_ID` | App Store の数値 ID (6〜12桁) |
| `ANDROID_PACKAGE` | Android application id。`app/app.json` の `android.package` と一致必須 |
| `ANDROID_CERT_SHA256` | Play 署名証明書の SHA-256 (64桁 hex。コロン区切り・大文字可。ビルドが正規化) |

`node scripts/check-native-config.mjs` (配布準備モード) はこの6入力が全件有効なときだけ通る。
`--dev` はローカル設定モード (未設定は INFO、設定済みの不正値は fail)。

### 4.3 Edge Functions 実行時 (Supabase が注入 / 手動供給)

| 変数 | 用途 | 備考 |
| --- | --- | --- |
| `SUPABASE_URL` | 関数が DB/Auth を呼ぶ URL | プラットフォームが供給 (`_shared/*.ts` が読む) |
| `SUPABASE_ANON_KEY` / `SUPABASE_PUBLISHABLE_KEY` | ユーザー JWT の検証 (`GET /auth/v1/user`) 用 | どちらか。`_shared/auth.ts` がフォールバック |
| `SUPABASE_SERVICE_ROLE_KEY` | サービス専用関数の Bearer 資格 (`daily-settlement` / `request-expiry` / `notification-dispatch` / `friendship-admin` 等) | エンドユーザー JWT・匿名呼び出しは 401。未設定ならフェイルクローズ |
| `EXPO_ACCESS_TOKEN` | `notification-dispatch` の Expo 実送信資格 | 未設定でも安全動作 (配送行の生成のみ。送信バッチはクレームせず通信ゼロ) |

### 4.4 `supabase/config.toml` の `env(...)` 参照 (値は書かない)

`SUPABASE_AUTH_EXTERNAL_APPLE_SECRET` (Apple OAuth secret)・
`SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET` (Google OAuth secret)・
`SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN`・`OPENAI_API_KEY` (Studio AI)・
`S3_HOST` / `S3_REGION` / `S3_ACCESS_KEY` / `S3_SECRET_KEY`。
いずれもリポジトリに平文で書かず CI・ローカル環境から供給する。

### 4.5 外部入力と本人操作が必要なもの

OAuth secret、AppleのTeam ID／Service ID／`.p8`、本番Supabase、実招待ドメイン・配布署名、
EAS資格などは対象環境の管理者が用意する。Googleのclient IDが設定済みでも、secret注入・callback・本人の同意まで成功した証拠にはならない。
今回の検証環境にはApple Development署名が存在し、Googleも有効だったため、一律に「資格なし」とは扱わない。
本番配布・実OAuth・実プッシュの状態は個別に確認し、手動ログインを自動テストの資格注入で代用しない。
プッシュは今回のホーム・チャットの対象外。

## 5. 動作確認と自動テスト

以下はすべてリポジトリルートで実行する。テストには実ローカルAuthユーザー・fixtureの作成と削除が含まれる。
通常環境のテストはアプリの手動操作と同時に実行せず、バックエンドrunner・専用runner・stack単体テストも**一つずつ**実行する。

### 5.1 まずホーム・チャットを実バックエンドで確認する

Dockerを起動し、`npm --prefix app ci` を済ませてから実行する。通常の開発DBや `app/.env` の準備は不要。

```sh
# HTTP権限・画像・送受信と、画面からの二者操作を両方実行する
node scripts/test-chat-backend.mjs --suite all

# 切り分ける場合（上と同時には実行しない）
node scripts/test-chat-backend.mjs --suite backend
node scripts/test-chat-backend.mjs --suite journey

# 専用環境の安全性テスト（runner終了後に実行）
node --test scripts/chat-test-stack.test.mjs
```

| 環境 | 用途・接続情報 | 起動・後始末 |
| --- | --- | --- |
| 通常 `daily-chat` / `54321`系 | 手動操作、既存 `app-journey`、既存backendテスト | 開発者が起動。追加migrationのみ適用し、resetしない |
| 専用 `daily-chat-home-chat-test` / `55320–55329` | 新chatのbackend／journey | runnerが一時ディレクトリへコピーし、fixture・関数・スタックを後始末する |

専用runnerはポート・所有権の衝突で失敗する。他のプロセスを止めたり、通常プロジェクトを使い回したりしない。
`journey`を通常Jestから直接実行すると専用設定不足で失敗するのが正しい。
成功時は **journeyの3テスト、backendの10群、後始末、通常状態の不変監査**を確認する。
画面rendererと実HTTP／Storage／SQL／Realtime／SQLiteを通すが、OSピッカーや実機の読み上げ確認にはならない。

### 5.2 全体回帰

先に§1の通常Supabaseを起動し、§2.1のURL／anon keyを一致させる。
通常Jestに含まれる既存 `app-journey` は実バックエンドが必要なため、DBなしの単体テスト一式ではない。

```sh
npm --prefix app test -- --runInBand --testPathIgnorePatterns home-chat-journey.test.tsx
npm --prefix app run typecheck
npx supabase test db
npx deno test --allow-env --allow-net --config supabase/functions/deno.json supabase/functions/tests
node scripts/test-local-backend.mjs --suite all   # 個別: command-boundary / registration / requests / discovery / invitations / profile-publication / notifications
node scripts/test-chat-backend.mjs --suite all    # 新chat backend + journeyを専用5532xスタックで両方実行
node --test scripts/chat-test-stack.test.mjs      # 専用runnerとは同時実行しない
EXPO_NO_DOTENV=1 node --test scripts/invite-web.test.mjs
node scripts/check-native-config.mjs --dev        # ローカル設定 (exit 0 が正常)
git diff --check
```

成長・外観（Task 17）の全自動回帰は、通常Jestから実バックエンドの3 journey
(`app-journey`・`home-chat-journey`・`appearance-journey`) だけを除外し、
専用runnerの `all` で必ず再実行する。実測件数・実行時刻・cleanup証拠は
[検証記録](docs/testing/sns-identity.md)、適用順序・検証SQL・停止条件は
[移行・運用runbook](docs/operations/sns-identity.md)を参照する。§5.3の記録は当時の証拠として
書き換えない。

ストア配布まで確認する場合だけ、§4.2の6入力を用意して `node scripts/check-native-config.mjs` を別途実行する。
配布入力が不足している場合のexit 2は、ローカル動作の不合格とは区別する（配布準備は未完了）。

招待Webテストは入力なし／指定入力の設定を検証するため、`EXPO_NO_DOTENV=1` で手動操作用の `.env` 読み込みだけを無効にする。ファイルの削除・編集は不要。
既存pgTAPにはDB全体の件数を前提にするテストがあり、手動操作で友達や申請イベントがある通常DBでは失敗し得る。
データを消さずに検証する場合は、[検証記録の「分離DBで同じpgTAPを再実行する」](docs/testing/home-chat.md)を使う。

`scripts/test-local-backend.mjs` は `supabase status --output json` から接続情報を取得し、
実 Auth ユーザーを作って実 Edge Functions を叩く。キー類はメモリ内のみで、出力はすべてマスクされる。

`app/.env` を作らずに通常Jestを動かす場合は、次のコマンドで通常ローカルの公開値だけを子プロセスへ渡せる。
`app/.env` が存在する場合は既存journeyがその値を優先するため、statusと一致している必要がある。

```sh
node <<'NODE'
const { spawnSync } = require('node:child_process');
const { readSupabaseStatus, redact } = require('./scripts/lib/local-backend.cjs');
try {
  const status = readSupabaseStatus();
  if (status.API_URL !== 'http://127.0.0.1:54321') {
    throw new Error('通常 daily-chat / 54321 の起動状態を確認してください');
  }
  const result = spawnSync('npm', ['--prefix', 'app', 'test', '--', '--runInBand',
    '--testPathIgnorePatterns', 'home-chat-journey.test.tsx'], {
    stdio: 'inherit',
    env: { ...process.env, EXPO_PUBLIC_SUPABASE_URL: status.API_URL,
      EXPO_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(redact(error.message));
  process.exitCode = 1;
}
NODE
```

接続情報自体は表示しない。新chat journeyへ通常資格を渡したり、専用資格で旧テストを動かしたりしない。
通常Jestから除外した新journeyは専用 `--suite all` で必ず実行する。

### 5.3 記録済みの結果と未確認範囲

2026-10-29の最終回帰では、通常Jest **932件**、分離DBのpgTAP **5,100件**、Deno **168件**、既存backend **191件**、
専用chatのjourney **3件＋backend 10群**、専用環境テスト **11件**、招待Web **25件**が成功。型検査・ローカル設定検査・後片付けも成功。
通常DBのpgTAP失敗と `.env` を読み込んだ招待Webテストの失敗は、分離条件での成功とは分けて記録している。
途中のタイムアウトやDocker不調も[検証記録](docs/testing/home-chat.md)に残している。

上記の最終回帰時点では、`app/` の `npx expo install --check` は既存14依存のSDK 57パッチ更新を推奨して **exit 1** だった。
その後の依存更新は次節に記録する。§2.3の両OS手動確認は更新前の利用者報告であり、更新後の動作確認を示すものではない。

### 5.4 SDK 57内の依存更新（2026-10-29、SDK 58移行前の記録）

- Expoを **57.0.31**、関連パッケージをSDK 57の推奨パッチへ更新。React **19.2.3**、React Native **0.86.3**、Jest 29、TypeScript 6は維持する。
- Supabase JSをアプリ・Edge Functionsとも **2.118.0**、React Native Testing Libraryを **14.1.0**、Edgeのpakoを **3.0.3**へ更新。npm・Denoのlockfileも更新した。
- 間接依存の最新版がSDKと衝突するため、Reanimated **4.5.1** / Worklets **0.10.1**をSDK 57推奨版として明示的に固定。`test-renderer` はReact 19.2対応のreconcilerを使う **1.2.0**に固定する（1.3系はReact 19.3を要求する）。
- `npm ci`、`npm ls --all`、型検査、`expo install --check`、Expo Doctor **21/21**、iOS・Android向けJSバンドル生成、ローカルネイティブ設定検査が成功した。
- DBなしのJest **925件（54 suite）**、Deno **168件**、招待Web **25件**が成功。Jestには `act(...)` の警告が残る。今回のJest実行は以下のとおりで、実DBを使う2つのjourneyは除外した。

  ```sh
  npm --prefix app test -- --runInBand --testPathIgnorePatterns '(^|/)(app-journey|home-chat-journey)\.test\.tsx$'
  ```

- `npm audit` は **25件 → 19件（high 3 / moderate 3 / low 13、critical 0）**。Expo CLI経由の `zod`、`deepmerge`、Router経由の `decode-uri-component` に関連する警告が残る。互換性を崩す `npm audit fix --force` は実施していない。
- **更新後のネイティブビルド・実機操作・実DB統合テストは未確認**。ネイティブ依存が変わったため、§2.2の `npm run ios` / `npm run android` で開発ビルドを作り直してから再確認する。JSバンドル生成だけをネイティブビルド成功とは扱わない。

### 5.5 Expo SDK 58への移行（2026-10-29）

- Expo **58.0.21**、React **19.3.0**、React Native **0.88.1**へ更新。Expo関連・Reanimated **4.7.1**・Worklets **0.13.0**もSDK 58推奨版へ揃えた。Jest **30.5.2**、`jest-expo` **58.0.13**、`test-renderer` **1.3.0**とし、TypeScript 6は維持する。
- `File.write()` の非同期化に対応し、同期保存を約束するアダプターと開発用probeは **`writeSync()`**へ移行。UTF-8・base64・バイト列の即時保存とエラー伝播を検証する回帰テスト4件を追加した。
- React NativeのStrict TypeScript APIに合わせてスクロールref・リストcallbackの型を更新。Routerテストは `await renderRouter(...)` の結果を使う新APIへ移行した。
- UIKit scene lifecycleはSDK 58標準のため、不要になった `ios.enableSceneSupport` を削除。ローカルの `ios/`・`android/` は旧生成物を退避してから再生成し、Android SDKパス・debug keystore・ローカルXcode環境・既存のiOS署名teamを引き継いだ。退避先は `/private/var/folders/1l/g5bm30qs6mq6m4zd0hqj2y4r0000gn/T/opencode/yu-lu-sdk57-native-backup-S4T9j8`（この検証環境の一時ディレクトリ）。
- 同一manifest・lockfileをコピーしたクリーンな一時ディレクトリでの `npm ci` と `npm ls --all` が成功。アプリ本体でも依存関係検査・型検査・`expo install --check`・Expo Doctor **20/20**・iOS／Android向けJSバンドル生成・ローカルネイティブ設定検査が成功した。
- DBなしのJest **929件（55 suite）**と招待Web **25件**が成功した。Jestの `act(...)` 警告は残る。除外する実DB journeyとJest実行コマンドは§5.4と同じ。
- Androidのarm64 Debugネイティブビルドが成功（JDK 17、`:app:assembleDebug -PreactNativeArchitectures=arm64-v8a`）。APKは `app/android/app/build/outputs/apk/debug/app-debug.apk`。端末へのインストール・起動確認は行っていない。
- `npm audit` はSDK 57更新後の **19件 → 16件（high 3 / low 13、moderate・critical 0）**。Expo CLI経由の `zod` と `deepmerge` の警告が残る。`npm audit fix --force` は実施していない。
- **SDK 58での実機操作・実DB統合テストは未確認**。既存開発クライアントは再ビルド・再インストールし、§2.3の両OS手動確認を再実施する。別の作業環境にSDK 57の生成済み `ios/`・`android/` がある場合は、独自変更を退避してからSDK 58で再生成する。
- 移行根拠: [SDK 58リリースノート](https://expo.dev/changelog/sdk-58)、[Router移行ガイド](https://docs.expo.dev/router/migrate/sdk-57-to-58/)、[SDK 58 APIリファレンス](https://docs.expo.dev/versions/v58.0.0/)。

## 6. トラブルシューティング

| 症状 | 確認・対処 |
| --- | --- |
| Docker socketがない／Supabaseを起動できない | Docker Desktop／OrbStackを通常起動し、`docker info` が返るか確認。起動しない場合はそこで止め、データ消去やDB resetで直そうとしない |
| ホーム・友達一覧が503、`name resolution failed` | §1の `npx supabase functions serve` を起動。統合テスト終了後は手動用の関数プロセスを再起動する |
| dev launcherから進まない／Metro接続拒否 | `app/` でLAN向けMetroを起動し、端末からPCの8081へ届くか確認。localhostのIPv6のみの待受、VPN・ファイアウォール・OSのローカルネットワーク許可も調べる |
| Metroは開くがAuth・画像取得に失敗する | Supabaseの54321へも到達できるか、アプリURLとanon keyの組合せを確認。実機で127.0.0.1を使わない。401なら正規の再ログイン・OAuth設定を確認し、サービス資格を端末へ渡さない |
| Google／Appleログインから戻らない | プロバイダーの有効化・secret・許可済みcallbackとアプリの復帰URLを確認。本人のログイン・同意が必要。設定変更は対象環境の管理者が行う |
| 通常Jestのjourneyが設定不一致で失敗 | 通常54321環境と `app/.env` を照合する。ファイルがなければ§5.2の子プロセス起動を使用。専用5532x資格を流用しない |
| 専用テストがポート／lock衝突を報告 | 同じ専用runner・stack単体を並列実行していないか確認。中断資源の所有者・project IDを確認するまで、プロセス停止・lock削除・volume削除をしない |
| Androidで接続対象が見つからない | Android Studioで既存AVDを起動するか、USBデバッグを許可した端末を接続。`adb devices -l` で確認する |
| Androidエミュレータから通常localhostのSupabaseへ届かない | `"$HOME/Library/Android/sdk/platform-tools/adb" -e reverse tcp:54321 tcp:54321` で転送し、アプリを再読み込み。エミュレータ再起動後は再設定する。複数接続時は対象を明示する |
| Androidで `Unsupported class file major version 71`／SDK location不足 | 既存検証ではJava 27からJDK 17へ切替え、`ANDROID_HOME`を指定するとビルドできた。下のプロセス限定例を参照 |
| iOS実機でdeveloper disk imageをmountできない | 端末OSを扱えるXcode・デバイスサポート、Developer Mode、ペアリングを確認。署名の存在だけで実機操作成功とは扱わない |
| 今日の相手が確認中／次回参加／抽選失敗 | 通信障害と日次状態を区別する。友達成立直後の次回参加は正常。日次ジョブの04:00起動・毎分確認を[運用手順](docs/operations/home-chat.md)で確認し、手動SQLで対象を作らない |

macOSのAndroidビルド例（JDK 17・SDKがその場所にインストール済みの場合。システム設定は変更しない）:

```sh
JAVA_HOME="$(/usr/libexec/java_home -v 17)" \
ANDROID_HOME="$HOME/Library/Android/sdk" \
npm --prefix app run android
```

日次処理の再実行、04:05期限、サービス認証、予約適用・障害復旧は[ホーム・チャット運用](docs/operations/home-chat.md)を参照。
ライブラリ設定の確認先: [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/) / [Expo CLI](https://docs.expo.dev/more/expo-cli/)。
