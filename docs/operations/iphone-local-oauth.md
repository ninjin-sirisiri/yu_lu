# iPhone実機からローカルGoogle OAuthを確認する

`127.0.0.1` はiPhone自身。USB接続でもMacへ自動転送されない。
アプリのAPI接続先をMacのLANアドレスに変えても、Googleの戻り先がループバックのままだとログインを完了できない。

## 公開する範囲

```text
アプリ → MacのLAN IP:54321 → Google
Google → 一時HTTPSトンネル → 127.0.0.1:54330/auth/v1/callback
       → ローカルSupabase → app://auth/callback → アプリ
```

`scripts/oauth-callback-proxy.mjs` は **GET `/auth/v1/callback` だけ**を転送する。
DB API・Storage・Functions・Auth管理API・Studioは転送しない。
リクエストの認証ヘッダーやCookieも転送せず、認可コード・stateをログへ出さない。
転送先は固定の `127.0.0.1:54321`。コールバックのリダイレクトを追わず、アプリへ返す。

トンネル事業者を経由して認可コード・stateを送る開発用構成であり、本番運用には使わない。
**Supabaseの54321・54322・54323やMetroをそのままトンネルへ接続しない。**

## 起動・設定

1. `app/` で専用プロキシとCloudflare Quick Tunnelをまとめて起動する。
   このターミナルを残す。`Ctrl+C` で両方が終了する。

   ```sh
   cd app
   npm run tunnel
   ```

2. `cloudflared` が見つからない場合は、一度インストールしてから再実行する。

   ```sh
   brew install cloudflared
   ```

   `CLOUDFLARED_BIN=/path/to/cloudflared npm run tunnel` でバイナリを指定することもできる。
   初期設定時に検証・取得した一時バイナリが残っていれば、PATH上のものが無い場合に利用する。
   自動インストール・`.env` 書き換え・Supabase再起動は行わない。
   54330が使用中なら既存プロセスを停止せずエラーになる。既存のプロキシ／トンネルを終了してから起動する。

   表示された `https://<一時名>.trycloudflare.com` が今回のorigin。
   停止・再起動すると別のURLになるため、以下の設定をやり直す。

3. **ルートの `.env`**（`app/.env` ではない）に追加または更新する。既存の秘密値を上書きしない。

   ```dotenv
   SUPABASE_AUTH_EXTERNAL_GOOGLE_REDIRECT_URI=https://<一時名>.trycloudflare.com/auth/v1/callback
   ```

   Google Client Secretは既存の `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET` を使う。
   `.env` はGit管理外。秘密値や認可コード入りURLをチャットへ貼らない。

4. Google Cloud Console → Google Auth Platform → Clients → 対象の **Web application** を開く。
   `supabase/config.toml` のGoogle `client_id` と一致するクライアントを選び、
   **Authorized redirect URIs（承認済みのリダイレクトURI）**に上記の完全なURLを追加して保存する。
   JavaScript originsや、アプリ復帰用 `app://auth/callback` の欄とは別。
   既存のループバックURIは削除しなくてよい。

5. Supabaseの設定を反映する。`stop` はデータを保持する。`--no-backup` やDB resetは使わない。

   ```sh
   npx supabase stop
   npx supabase start
   ```

6. iPhoneとMacを同じ信頼できるLANへ接続する。`app/` でMacの実際のLAN IPを指定してMetroを起動する。

   ```sh
   EXPO_PUBLIC_SUPABASE_URL=http://<MacのLAN IP>:54321 npx expo start --dev-client --lan --port 8081
   ```

   開発ビルドを新しいMetroのURLから開き、Googleログインを最初からやり直す。
   途中のブラウザURLの再利用や認可コードの手動コピーはしない。

## 検証と終了

- `node --test scripts/oauth-callback-proxy.test.mjs` で、転送・遮断・タイムアウトを確認できる。
- トンネルの `/rest/v1/`・`/storage/v1/`・`/functions/v1/`・`/auth/v1/admin/users` は404になる。
- `redirect_uri_mismatch` はGoogleの登録URIとSupabaseのURIの不一致。スキーム・ホスト・パスまで完全一致させる。
- 実機でアプリへ復帰し、ログイン後の画面まで進めることが最終確認。プロキシのテストだけを実機成功と扱わない。
- 検証後はトンネルとプロキシを `Ctrl+C` で停止する。Google側の一時URIを削除し、ルート `.env` の
  `SUPABASE_AUTH_EXTERNAL_GOOGLE_REDIRECT_URI` を `http://127.0.0.1:54321/auth/v1/callback` に戻してSupabaseを再起動する。
- トンネル停止だけでも外部からの接続は止まるが、設定を戻すまではGoogle実機ログインが失敗する。

参考: [Supabase Google OAuth](https://supabase.com/docs/guides/auth/social-login/auth-google) /
[Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
