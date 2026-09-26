# App Foundation / Friends UI — 実機検証結果 (living document)

このドキュメントは docs/sdd/plans/2026-09-25-app-foundation-friends-ui.md の実行計画に対する
実データ・実機検証の記録です。タスクごとに「コマンド・期待・実測」を追記していきます。
モックのみを成功の証拠にしないことがルールです。

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
