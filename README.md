# Daily Chat — 開発環境 README

スマホアプリ (Expo 57) + ローカル Supabase + 招待 Web のモノレポ。
詳細な運用手順は `docs/operations/app-foundation-friends-ui.md`、
検証記録は `docs/testing/app-foundation-friends-ui.md` を参照。この README は
**起動方法と環境変数**のみをまとめた入口。

ホーム・チャットの追加分: [検証結果と実機の未完了項目](docs/testing/home-chat.md) /
[日次ジョブ・サービス認証・復旧手順](docs/operations/home-chat.md)。旧計画の記録は上書きしない。
Task22は実機・本人認証後の手動確認が未完了のため **BLOCKED**。Docker不応答は復旧済み。自動回帰の実結果は検証記録を参照。本番デプロイ・外部ジョブ登録は未実施。

## 構成

| ディレクトリ | 内容 |
| --- | --- |
| `app/` | Expo 57 / RN 0.86.3 アプリ本体 (`package.json` の `scripts` が起動定義) |
| `supabase/` | ローカル Supabase 設定・マイグレーション・Edge Functions |
| `invite-web/` | 招待ランディングの静的サイト (ソースのみ。`dist/` はビルド生成・git 管理外) |
| `scripts/` | 招待 Web ビルド・ローカル統合テスト・ネイティブ設定チェッカー |

## 前提条件

- Node.js (リポジトリは Node 22.12+ を要求。実測: v26.7.0 / npm 11.19.0)
- Docker 起動中 (ローカル Supabase 用)
- Supabase CLI (実測: 2.118.0)
- iOS ビルド: Xcode / `xcrun simctl`。Android ビルド: 接続デバイス or AVD
- Edge Function の単体テスト用に Deno (実行形は `npx deno test ...`。本環境未導入でも他は動く)

## 1. ローカルバックエンド (Supabase) の起動

すべてリポジトリルートで実行。

```sh
# 初回 / Docker イメージ取得後
npx supabase start

# 起動確認 (API_URL / ANON_KEY / SERVICE_ROLE_KEY を JSON で取得。
# キーは表示・コピペせず、テストランナーはこの出力をメモリ内でのみ使う)
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

```sh
cp app/.env.example app/.env
```

ローカル開発では `app/.env` の URL / anon key を
`npx supabase status` の値と**完全一致**させる (不一致だと journey テストが起動時に拒否する)。

```sh
EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
EXPO_PUBLIC_SUPABASE_ANON_KEY=<supabase status の ANON_KEY>
```

値が無い状態で起動すると、アプリはプレースホルダを作らず**明確なエラー表示で停止**する
(`src/backend/client.ts` の `SupabaseConfigError`)。

### 2.2 起動コマンド (`app/package.json` の定義どおり)

```sh
cd app
npm install

# Metro 開発サーバー (全インターフェースで待つ。--localhost は IPv6 のみ bind され
# 実機接続で失敗することがあるため --port 8081 を使う)
npx expo start --port 8081

# ネイティブ開発ビルド (実機・シミュレータ。Metro を同梱して起動する)
npx expo run:ios [--device <UDID>]
npx expo run:android [--device]

# Web 確認用
npx expo start --web

# 型検査 / テスト
npm run typecheck
npm test -- --runInBand
```

`npx expo run:ios` が成功すると dev client が入り、Metro バンドルでログイン画面まで到達できる。
Android は接続デバイス / AVD が無いと `No Android connected device found` で止まる (正常なブロッカー表示)。

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
node --test scripts/invite-web.test.mjs
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
| `SUPABASE_SERVICE_ROLE_KEY` | サービス専用関数の Bearer 資格 (`request-expiry` / `notification-dispatch` / `friendship-admin` 等) | エンドユーザー JWT・匿名呼び出しは 401。未設定ならフェイルクローズ |
| `EXPO_ACCESS_TOKEN` | `notification-dispatch` の Expo 実送信資格 | 未設定でも安全動作 (配送行の生成のみ。送信バッチはクレームせず通信ゼロ) |

### 4.4 `supabase/config.toml` の `env(...)` 参照 (値は書かない)

`SUPABASE_AUTH_EXTERNAL_APPLE_SECRET` (Apple OAuth secret)・
`SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN`・`OPENAI_API_KEY` (Studio AI)・
`S3_HOST` / `S3_REGION` / `S3_ACCESS_KEY` / `S3_SECRET_KEY`。
いずれもリポジトリに平文で書かず CI・ローカル環境から供給する。

### 4.5 未提供の外部入力 (このリポジトリでは設定できない)

Apple Team ID / Service ID / `.p8`、Google OAuth Client ID・Secret、
本番 Supabase URL・key、実招待ドメイン・署名、`EXPO_ACCESS_TOKEN`、EAS アカウント・署名資格。
提供前は実 OAuth 往復・ストア配布・実プッシュ送信は実行できない
(一覧は `docs/operations/...` の「未提供の外部入力」節)。

## 5. 検証コマンド (全体回帰)

```sh
npm --prefix app test -- --runInBand --testPathIgnorePatterns home-chat-journey.test.tsx
npm --prefix app run typecheck
npx supabase test db
npx deno test --allow-env --allow-net --config supabase/functions/deno.json supabase/functions/tests
node scripts/test-local-backend.mjs --suite all   # 個別: command-boundary / registration / requests / discovery / invitations / profile-publication / notifications
node scripts/test-chat-backend.mjs --suite all    # 新chat backend + journeyを専用5532xスタックで両方実行
node --test scripts/invite-web.test.mjs
node scripts/check-native-config.mjs --dev        # ローカル設定 (exit 0 が正常)
node scripts/check-native-config.mjs              # 配布準備 (6入力提供まで exit 2 が正常な失敗)
git diff --check
```

`scripts/test-local-backend.mjs` は `supabase status --output json` から接続情報を取得し、
実 Auth ユーザーを作って実 Edge Functions を叩く。キー類はメモリ内のみで、出力はすべてマスクされる。

通常Jestの既存 `app-journey` は通常ローカル環境と一致する公開URL/anon keyが必要。
`app/.env` が無い場合はstatusから実値を子プロセス環境に供給し、ファイルを編集しない
（[検証記録](docs/testing/home-chat.md)参照）。新chat journeyへ通常資格を渡したり、
専用資格で旧テストを動かしたりしない。通常Jestから除外した新journeyは最後の専用 `--suite all` で必ず実行する。
