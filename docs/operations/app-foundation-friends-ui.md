# App Foundation / Friends UI — 運用・外部設定手順

このドキュメントは OAuth・通知・リンク・定期処理などの **外部入力を伴う設定** を扱います。
秘密値はコミットせず必ず環境変数で供給します。検証済み/未検証の記録は
docs/testing/app-foundation-friends-ui.md を参照。

---

## OAuth (Apple / Google) — Task 10

### アプリ側の公開設定 (app/.env)

```sh
EXPO_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<publishable/anon key>
```

- テンプレート: `app/.env.example`。値なしで起動した場合は本アプリは
  **明確なエラー表示**で停止する (プレースホルダ値は絶対に作らない)。
- `EXPO_PUBLIC_` 接頭辞の値はバンドルへ **平文で入り公開可能** なものだけを使う。
  Apple/Google のクライアントシークレット等はここに入れない。

### Supabase 側: メール登録の無劮化 (必須)

アプリは Apple・Google のみでログインするため、メール登録は無効化する。

- **ローカル (in-repo)**: `supabase/config.toml`

  ```toml
  [auth.email]
  enable_signup = false   # ← メールプロバイダの登録を無効化
  # OAuth 登録はグローバルの [auth] enable_signup = true で維持
  ```

  実測 (`docs/testing/app-foundation-friends-ui.md` Task 10):
  `POST /auth/v1/signup` → `400 email_provider_disabled`、
  `GET /auth/v1/settings` → `"external": {"email": false}`。
  注意: 現行のローカルCLIではこのフラグはメールプロバイダ全体 (ログイン含む) を無効化するため、
  ローカル統合ハーネス (`scripts/test-local-backend.mjs`) はメール+パスワードではなく
  ローカル署名JWT (実 `GET /auth/v1/user` で検証) を使う。

- **本番 (Supabase ダッシュボード)**: Authentication → Sign In / Providers → Email を
  無効化、または Email provider の "Allow new user signups" を OFF。グローバルの
  "Allow new user signups" は **ON のまま** (Apple/Google の新規登録に必要)。

### Supabase 側: コールバックURL (redirect) の allow-list

OAuth 往復後、Auth はこの URL へリダイレクトする。許可リストに無いと拒否される。

```toml
# supabase/config.toml
[auth]
additional_redirect_urls = ["https://127.0.0.1:3000", "app://auth/callback", "exp://*/--/auth/callback"]
```

- `app://auth/callback` は app.json の `scheme: "app"` + `expo-auth-session` の
  `makeRedirectUri({ path: 'auth/callback' })` の結果。
- **本番**: ダッシュボードの Authentication → URL Configuration → Redirect URLs に
  実運用 scheme のコールバック (例 `your-app://auth/callback`) を**正確に**登録する。
- Android のインストールリファラ経由の招待リンク (Task 15) は別系統 — OAuth の
  redirect allow-list と混同しない。

### Supabase 側: OAuth プロバイダの秘密値 (環境変数で供給)

`supabase/config.toml` は値を**参照だけ**し、秘密は環境変数から読む:

```toml
[auth.external.apple]
enabled = false            # 秘密値を投入後に true へ
client_id = ""             # Apple Team の Service ID / bundle に紐づく Client ID
# secret は env(SUPABASE_AUTH_EXTERNAL_APPLE_SECRET) 形式の参照のみ。
# 値そのものをリポジトリへ書かないこと。
```

- `SUPABASE_AUTH_EXTERNAL_APPLE_SECRET` 等を CI/ローカルの環境変数で供給する。
  **リポジトリに平文で書かない** (`env(...)` 参照のまま運用)。
- Apple: Apple Developer で Sign in with Apple を有効化し、Service ID・Key ID・Team ID・
  秘密鍵 (`.p8`) を Supabase へ設定。Google: Cloud Console の OAuth Client
  (Web/Android/iOS) と本番コールバックURLを登録し、Client ID/Secret を設定。
- これらは**未提供の外部入力**。投入前は実OAuth往復は実行できない (実機検証の
  ブロック状況は docs/testing を参照)。

### 検証コマンド (ローカル)

```sh
# メール登録が無効であること
curl -s -X POST "$SUPABASE_URL/auth/v1/signup" -H "apikey: $ANON" \
  -H 'content-type: application/json' \
  -d '{"email":"probe@example.com","password":"Sup3rSecret!"}'
# → {"error_code":"email_provider_disabled","msg":"Email signups are disabled"}

# allow-list が実Authプロセスに反映されていること
docker inspect "$(docker ps --format '{{.Names}}' | grep auth | head -1)" \
  --format '{{range .Config.Env}}{{println .}}{{end}}' | grep URI_ALLOW_LIST
```

---

## 招待Web・ドメイン関連付け (Task 15) — 確認手順 (未公開)

この節は**手順書**である。実値 (HTTPS招待ドメイン・実bundle id・実署名等) はこのリポジトリに
存在せず、**何一つ公開・配信済みではない**。実測結果は
docs/testing/app-foundation-friends-ui.md (Task 15) を参照。

### 必要な外部入力 (環境変数・6つすべて必須・既定値なし)

| 変数 | 内容 |
| --- | --- |
| `INVITE_ORIGIN` | HTTPS招待ドメインのorigin (例 `https://invite.example.com`) |
| `IOS_BUNDLE_ID` | iOS bundle id (逆DNS) |
| `APPLE_TEAM_ID` | Apple Developer Team ID (10桁) |
| `APP_STORE_ID` | App Store の数値ID |
| `ANDROID_PACKAGE` | Android application id |
| `ANDROID_CERT_SHA256` | Play署名証明書のSHA-256 (64桁hex・コロン可) |

- ビルドは不足・不正で必ず失敗し、足りない変数名を全部挙げる (疑似値は絶対に作らない)。
- アプリ側の `EXPO_PUBLIC_INVITE_ORIGIN` は **同じorigin** にすること。
  `app/app.config.ts` は両者が食い違うとエラーにする (片方だけでも可)。
  ローカルでは `app/.env` に `INVITE_ORIGIN=...` を追記する (expo CLIが.envを読む)。

### ビルドと検証コマンド

```sh
# 実値 (環境変数を供給済み) — 出力は invite-web/dist/ (git管理外)
node scripts/build-invite-web.mjs --out invite-web/dist

# 検証専用 (.test ドメインのfixture・TEST-ONLY-OUTPUT.txt 付き・公開禁止)
node scripts/build-invite-web.mjs --test-config --out invite-web/dist-test

# 自動検証
node --test scripts/invite-web.test.mjs
cd app && npx expo config --type public   # 値なしなら追加なしで成功
```

出力: `index.html` / `app.js` / `styles.css` / `runtime-config.js` (生成) /
`apple-app-site-association` / `.well-known/assetlinks.json`。
 associationファイルは公開識別子のみ (秘密値なし)。

### HTTPS配信の確認手順

1. 出力ディレクトリを `INVITE_ORIGIN` の配信元ルートに設置する
   (`/apple-app-site-association` と `/.well-known/assetlinks.json` がルート基準のパスで解決されること)。
2. `/invitation/<32桁hex>` は `index.html` を返す (招待ページのフォールバック)。
   associationの2ファイルはフォールバック・書き換えの対象外にする
   (HTMLに書き換わると失格)。
3. 確認:

```sh
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' \
  https://<domain>/invitation/0123456789abcdef0123456789abcdef
# → 200 text/html
```

### リダイレクトなしの関連付けファイル確認手順

```sh
# 200・リダイレクト先が空 (301/302/307/308 でないこと)
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<domain>/apple-app-site-association
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<domain>/.well-known/assetlinks.json
# → 各行が "200 " (redirect_url 空)、content-type は application/json

# 配信ボディがビルド出力と一致すること (改ざん・古いファイルの残存を検出)
diff <(curl -sS https://<domain>/apple-app-site-association) invite-web/dist/apple-app-site-association
diff <(curl -sS https://<domain>/.well-known/assetlinks.json) invite-web/dist/.well-known/assetlinks.json
```

- Appleはルートと `/.well-known/apple-app-site-association` の両方を試す。
  ホスト側で `.well-known` 版を出す場合は **同じボディをコピー**して同期すること
  (生成物はルート用1ファイル)。

### 署名一致の確認手順

- **Android**: `ANDROID_CERT_SHA256` が次のいずれと完全一致すること (コロン・大小文字は
  ビルドが正規化済み)。
  - Play Console → 「テストと公開」→ キーと資格情報 の SHA-256
  - 配布物そのもの: `keytool -printcert -jarfile app-release.aab` の SHA256
- **iOS**: `apple-app-site-association` の `appID` = `<APPLE_TEAM_ID>.<IOS_BUNDLE_ID>` が、
  App Store Connect /署名プロビジョニングの実bundle id・実Team IDと一致すること。

### 実ストアURLの確認手順

1. `https://apps.apple.com/app/id<APP_STORE_ID>` をブラウザで開き、掲載アプリとIDが一致するか。
2. `https://play.google.com/store/apps/details?id=<ANDROID_PACKAGE>` を開き、パッケージ一致を確認。
3. **referrer実測**: 招待URLからのGoogle Play遷移→インストール後、アプリが
   `invitation=<enc>` を読み取れることを確認 (Task 14 の Install Handoff。実機・実Play配信でのみ可)。
4. **iOS実測**: 招待URLを開く → ボタンでコピー → App Store遷移 → インストール後、
   アプリ内で貼り付け (Task 14) が通ること。コピー失敗時は遷移せず、再試行と
   リンク再開方法が表示される (ページ実装は `node --test` で検証済み)。

### 実値が揃うまで

- `node scripts/build-invite-web.mjs` は失敗し続ける (**正しい挙動**)。
- `--test-config` の出力は検証専用。`TEST-ONLY-OUTPUT.txt` を消して公開する行為は禁止。
  公開確認は上記手順を実値で通したときだけ行う。

---

## 定期処理の認証済み定期呼び出し (Task 18) — request-expiry / notification-dispatch

`request-expiry` (申請・招待の期限切れ処理) と `notification-dispatch`
(通知イベント → 端末への配信ワーカー) は **サービス専用** の Edge Function。
プラットフォームの verify_jwt がプロジェクト署名の Authorization を要求し、
関数内の `requireServiceCall` がさらに `Bearer <service key>` を要求する
(資格が未設定ならフェイルクローズ)。エンドユーザー JWT・匿名呼び出しは 401。
資格は必ず環境変数から供給し、リポジトリに書かないこと。

### 設定手順

1. **スケジューラ登録** (pg_cron / Supabase Scheduler / 外部 cron):
   - `request-expiry`: 1日1回以上 (期限判定はサーバー時刻なので遅れても挙動は不変)。
   - `notification-dispatch`: 5〜15分間隔。**二重起動はDBのclaim行が吸収する**
     (先にclaimした実行だけが処理し、負けた実行は `dispatch busy` と応じて
     何も生成しない)。オーバーラップ呼び出しは安全。
   - `functions deploy` とスケジュール設定はこのworktreeの外 (CI/実環境) で行う。
2. **実送信の資格**: `notification-dispatch` が Expo へ実際に送るのは
   `EXPO_ACCESS_TOKEN` (EASアクセストークン) が設定されているときだけ。
   **未設定でも安全に動作する**: イベントの配送行は生成 (キューため) されるが、
   送信バッチはクレームせず、ネットワーク呼び出しはゼロ。
   トークンは環境変数で供給しコミットしない。
3. **端末登録** (`device-session`) はユーザー JWT で呼ぶ通常のエンドポイント
   (Task 19 のクライアントが担当)。スケジューラ設定は不要。

### 検証コマンド

```sh
# DB層: スキーマ・権利・二重起動claim・生成冪等・失効トークン・再処理 (pgTAP)
npx supabase test db

# 関数層 (オフライン): ペイロードgate・本文がpublicフィールドのみ・Expoアダプタ分類
npx deno test --allow-env --allow-net --config supabase/functions/deno.json \
  supabase/functions/tests/notifications.test.ts

# 実HTTP統合: 端末登録 (複数端末/失効/無権限)・dispatchのclaim・配送生成
node scripts/test-local-backend.mjs --suite notifications
node scripts/test-local-backend.mjs --suite all        # 全スイート

# 認証された定期呼び出しの手動確認 (資格は npx supabase status --output json から
# シェル環境へ読み込む。値はログに表示しない)
curl -sS -X POST "$SUPABASE_URL/functions/v1/request-expiry" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
# → 200 "expiry ok"

curl -sS -X POST "$SUPABASE_URL/functions/v1/notification-dispatch" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
# → 200 "dispatch ok" (claim保持中は 200 "dispatch busy")

curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  "$SUPABASE_URL/functions/v1/notification-dispatch"
# → 401 (Bearerなし)

curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  "$SUPABASE_URL/functions/v1/notification-dispatch" \
  -H "Authorization: Bearer $ANON_KEY"
# → 401 (エンドユーザー資格は不可)
```

通知の内容は event_type・相手の表示名・種別ごとの定型文のみ (private な
進捗・連続記録は送らない)。拒否と招待リンク自体の期限切れはイベント自体を
記録しないため配送行が生成されない。

---

## 未提供の外部入力 (このリポジトリでは設定できないもの)

| 入力 | 用途 | 提供待ちの影響 |
| --- | --- | --- |
| Apple Team ID / Service ID / `.p8` 秘密鍵 | Sign in with Apple | Apple実ログイン不可 (providers.apple=false) |
| Google OAuth Client ID/Secret | Google ログイン | Google実ログイン不可 |
| 本番 Supabase URL / publishable key | アプリ接続 | 本番ビルド起動不可 (明確なエラーで停止) |
| 実運用 scheme / HTTPS招待ドメイン / 署名 | リンク・関連付け (Task 15) | ストア配布前の検証不可 (手順は上記「招待Web・ドメイン関連付け」節) |
| `EXPO_ACCESS_TOKEN` (EASアクセストークン) | notification-dispatch のExpo実送信 (Task 18) | 未設定でも配送行の生成のみで安全動作 (送信バッチはクレームしない)。設定後は実プッシュ送信が可能 |

提供されたら: 上記の秘密値を環境変数に投入 → プロバイダを `enabled = true` に →
コールバックURLをallow-listへ → docs/testing の手順で実OAuth成功・取消・callback中断を実施する。
