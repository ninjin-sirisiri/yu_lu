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

## 未提供の外部入力 (このリポジトリでは設定できないもの)

| 入力 | 用途 | 提供待ちの影響 |
| --- | --- | --- |
| Apple Team ID / Service ID / `.p8` 秘密鍵 | Sign in with Apple | Apple実ログイン不可 (providers.apple=false) |
| Google OAuth Client ID/Secret | Google ログイン | Google実ログイン不可 |
| 本番 Supabase URL / publishable key | アプリ接続 | 本番ビルド起動不可 (明確なエラーで停止) |
| 実運用 scheme / HTTPS招待ドメイン / 署名 | リンク・関連付け (Task 15) | ストア配布前の検証不可 |

提供されたら: 上記の秘密値を環境変数に投入 → プロバイダを `enabled = true` に →
コールバックURLをallow-listへ → docs/testing の手順で実OAuth成功・取消・callback中断を実施する。
