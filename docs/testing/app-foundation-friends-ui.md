# App Foundation / Friends UI — 実機検証結果 (living document)

このドキュメントは docs/sdd/plans/2026-09-25-app-foundation-friends-ui.md の実行計画に対する
実データ・実機検証の記録です。タスクごとに「コマンド・期待・実測」を追記していきます。
モックのみを成功の証拠にしないことがルールです。

---

## Task 19: 通知受信・画面更新・外部入口の統合 (2026-09-27 JST)

### 環境

| 項目 | 値 |
| --- | --- |
| Mac / Xcode | Xcode 27.0, macOS 27 |
| シミュレータ | iPhone 18 Pro / iOS 27.0 (UDID 7072095A-…、Boot済み)。**Simulator.app (GUI) はこの環境に存在しない** (`/Applications/Xcode.app/Contents/Developer/Applications/` 無し) — タップ入力が使えない |
| JS | Metro localhost:8081 稼働 (`/status` → 200)。実dev buildへTask 19のJSを流し込み `xcrun simctl launch 7072095A-… com.anonymous.app --initialUrl "exp+app://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"` で起動 |
| 入力手段 | **無** — GUI不在 + `idb` / `fb-idb` 未導入 + ヘッドレス運用 (タスク16と同じ制約) |

### JS層 (モック層 — MOCKED-LAYER)

```
$ npm --prefix app test -- --runInBand __tests__/notification-entry.test.tsx → 22 passed
$ npm --prefix app test -- --runInBand → 33 suites / 585 tests 全通過 (タスク19で +22)
$ npm --prefix app run typecheck    → 0 errors
```

- **権限拒否**: OSプロンプトは有効化ボタン (`friends-notify-enable`) の操作時のみ。起動・読込では prompt / トークン取得 / device-session 登録のどれも呼ばない。拒否時は `friends-notify-denied` を出し、トークン取得・登録はゼロ、`申請を確認` の入口は残存。
- **2端末**: 同一アカウントの別インストール (別SQLite) がそれぞれ device-session へ登録され device_id が分かれる。同一トークンの再有効化は transport を二度叩かず `alreadyRegistered` (冪等)。許可済みなら prompt を挟まない (`get` のみ)。
- **前景**: 抑止ハンドラが `{shouldShowBanner, shouldShowList, shouldPlaySound, shouldSetBadge}` すべて false (SDK 57 形状)。到着では `notify-in-app-notice` を表示し (タップ/5秒で消える)、`list_requests` の pending 件数を読み直して `friends-unread-count` を更新、**画面は移動しない** (移動はタップ時のみ)。
- **背景タップ**: `/friends/requests?tab=incoming&focus=<request_id>` へ遷移し `request-focus-badge` (通知から開いた申請) を表示。
- **終了状態 (cold)**: `getLastNotificationResponse` → 実行中応答と**同一の処理経路**。既読idはアカウント別SQLite (`notify.seen_ids`) に永続し、プロセス再起動後 (インメモリ破棄後) の同一通知は duplicate で再処理されない。
- **古い通知**: pending → 対象行へfocus、終了済み → `requests-entry-ended` 説明 + focus、期間切れ (一覧に無し) → `requests-entry-stale` 説明で**失敗しない**、検証不能 (オフライン) → 画面既存の状態へ。サーバ確認 (`list_requests`) はナビゲーション**より前**。
- **重複callback**: 同一通知の2回目は headless・実ルーターの両方で1回しかナビゲーションしない (サーバ状態が変わっていても再遷移・stale追記なし)。
- **招待/OAuth混同なし**: 通知の `url` ペイロードは `notification-carries-url` で拒否 (招待/OAuth経路へ流れない)、招待URL起動時は通知応答を種付けせず入口を奪わない、URLはパス優先分類でクエリに `code` が付いても型が反転しない、`/invitation*` `/auth/*` `/login` `/register` 中は通知エントリを保留。
- **未登録**: cold応答は登録画面で**既読化せず保持** → 登録完了後、サーバ確認を経て申請一覧へ (テストID: `requests-entry-ended` / `requests-entry-stale` / `request-focus-badge`)。
- **編集下書き**: 通知タップで `/friends/requests` へ移動しても `profile.edit` 下書き行は失われない。

### 実機試行 (実dev build + 実Metro — 実測できたこと)

手順: (1) Metro稼働確認 (`/status`=200) → (2) 実dev buildをTask 19のJSで launch → (3) ディープリンク `app:///friends` を openurl → (4) スクリーンショット取得。

```
$ xcrun simctl launch 7072095A-… com.anonymous.app --initialUrl "exp+app://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"
com.anonymous.app: 51186
$ xcrun simctl openurl 7072095A-… "app:///friends"   → iOS確認ダイアログ '"app" で開きますか？' が出現
```

| 検証項目 | 期待 | 実測 |
| --- | --- | --- |
| 実dev buildでのTask 19 JS起動 | クラッシュなく起動 | **起動成功 (pid 51186)**、Metroから新JSをロードしルートレイアウト (NotificationHost = 実expo-notifications import) まで到達、クラッシュ/デッドログなし — `docs/testing/screenshots/task-19/01-launch-login-guard.png` |
| 起動時にOS許可プロンプトが出ないこと | 出ない | 起動〜ログイン画面表示までの間、プロンプトは**発生していない** (01)。ただし有効化ボタンの押下自体は入力不能で未実施 (下記 device-pending) |
| `/friends` へのディープリンク | 友達タブへ遷移 | 系統の確認ダイアログで停止 — **タップ手段が無く先へ進めない** — `02-deeplink-confirm-dialog.png` |
| 認証状態 | セッションあり前提 | **セッション無効でログイン画面** (01) — 認証ガードが友達タブを遮断。実OAuth完了にもUI入力が必要でこの環境では完了不可 |

- 対応するJS層の検証は上記MOCKED-LAYERの22件。**実機で確認したのは「実dev buildがTask 19のJSでクラッシュなく起動し、起動時に許可プロンプトが出ないこと」のみ**。実プッシュの配信・タップ遷移は一切主張しない。

### device-pending (今回実測できない項目・理由)

| 検証項目 | 状態 | 理由・代替検証 |
| --- | --- | --- |
| 有効化ボタン押下 → 実OS許可プロンプト → 許可/拒否の実機挙動 | **DEVICE-PENDING** | この環境にSimulator.app GUIが無く (Xcode 27に同梱アプリが存在しない)、`idb` も未導入のためタップ入力が存在しない。加えてセッション無効で認証ガードを突破できず (実OAuthもUI入力が必要)、友達タブ自体に到達できない。jestでプロンプトが出る経路 (get→request) と拒否時のUI・入口残存を実測済み |
| 実pushトークン取得 (`getExpoPushTokenAsync`) | **DEVICE-PENDING** | `app/app.json` に `extra.eas.projectId` も `expo-notifications` プラグイン設定も無く、`app/eas.json` は未作成 (タスク21で作る予定)。**EAS資格情報が提供されていない**ためSDK 57がproject idを推定できずトークン取得は失敗する。jestではトークン失敗 → `token-unavailable` の国内語フォールバックと登録ゼロを検証済み |
| 実プッシュ配信 (2端末・前景/背景/終了状態) | **DEVICE-PENDING** | (1) 上記の資格情報欠如で送信側も受信側もトークンが無い、(2) **iOSシミュレータはAPNs受信不可**、(3) この環境に物理のiOS/Android端末が無い。Task 22の実機範囲に留める |
| 配信済み通知のタップ → エントリ遷移の実機挙動 | **DEVICE-PENDING** | 配信された通知が無いとタップが発生しない (上記に同じ)。応答経路はjestで cold / 背景タップ / 重複 / 未登録保持 / 古い通知 / 招待OAuth非混同 の全分岐を実測 |
| 前景受信時のOSバナー抑止とアプリ内案内の実機表示 | **DEVICE-PENDING** | 前景受信を作るには実配信が必要 (上記に同じ)。抑止ハンドラの戻り値 (全false) と案内・件数更新の配線はjestで実測 |

- 既知の無害なコンソール: ルートツリーを実際にjestで描画するスイートでは、`_layout → NotificationHost → expo-notifications` のimport連鎖により Expo Go の push 廃止に関する `console.warn` がスイート1件につき1回出る (実行結果に影響なし)。また `invitation-flow` の `act(...)` 環境エラー21件は**タスク19以前からベースラインと同数** (ワークチェックで増分ゼロを確認)。

---

## Task 16: プロフィール画像処理と永続化 (2026-09-26 JST)

### 環境

| 項目 | 値 |
| --- | --- |
| Mac / Xcode | Xcode 27.0, macOS 27 |
| ネイティブビルド | `npx expo run:ios --no-bundler` (Debug, dev client) — `expo-image-manipulator` 追加後に再ビルド成功 (0 errors、末尾のosascript警告はタスク8と同じ表示手順の失敗のみ) |
| シミュレータ | iPhone 18 Pro / iOS 27.0 (UDID 7072095A-…、ヘッドレス) |
| JS | Metro localhost:8081 (既存プロセス)。起動は `xcrun simctl launch <udid> com.anonymous.app --initialUrl "exp+app://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"` (タスク8と同じ手順) |
| プローブ | `app/src/media/avatarProbe.tsx` — `Documents/avatar-probe.enabled` 存在時のみ起動 (storage-probe と同じ方式・レンダリングは無し)。ヘッドレスでタップできないため、入力は埋め込みfixture (透過PNG 1600×1200 / EXIF Orientation=6 JPEG 320×240、`avatarProbeFixtures.ts`) を使用 |

### JS層 (モック層 — MOCKED-LAYER)

```
$ npm --prefix app test -- --runInBand src/media/avatar.test.ts        → 40 passed
$ npm --prefix app test -- --runInBand src/media/AvatarPicker.test.tsx →  6 passed
$ npm --prefix app test             → 31 suites / 540 tests 全通過 (タスク16で +46)
$ npm --prefix app run typecheck    → 0 errors
```

- **形式判定**: MIME別名 (`image/jpg`・パラメータ付き) 受理、MIME欠落時はファイル名→URI拡張子、**MIMEがあれば偽装拡張子より優先** (`.jpg` のGIFは拒否)、拒否文言に JPEG・PNG・HEIC を明記。
- **10MB境界**: ちょうど10MB受理 / +1byte拒否 (`media/images.ts` の `validImageSize` と同一値) / `fileSize` 欠落時はファイルシステム実サイズ。
- **ステージ順** decode → fit → flatten → encodeJpeg。**透過は必ずJPEGより前に白合成** (合成入力はgeometry適用後の画像)。EXIFはdecode後の寸法からgeometryを計算し二重回転しない (decodeは1回だけ)。
- **キャンセル**: `source=null` は読む・書く・消すすべての前で `canceled` を返す。UIではエラー表示なし・下書き変更なし・onChangeなし。
- **失敗で旧下書き保持**: decoder例外・透過合成失敗・ENOSPC (コミットコピー)・1024超過の出力・下書き書込み失敗のそれぞれで、下書き行と旧ファイルが不変。下書き書込み失敗時はコミット済みファイルをロールバック (参照と下書きは不変のまま)。
- **順序**: コミット→下書き (実呼び出し順をテストで固定)、コミット失敗時は下書き書込み自体が無い。差し替え成功時は旧stagedファイルを回収。
- **再起動復元**: DBを閉じて開き直すと同一参照を読込、破損した下書きbodyは「画像なし」に退避して例外にしない。
- **削除**: 下書き行を先に消してからファイルを削除 (削除失敗時は一時ファイル残存のみで参照切れにならない)。公開済み画像 (別の参照) は一切触らない。
- **UI配線**: カメラ権限拒否は説明のみでカメラを起動しない、形式拒否はエラー通知で表示、削除後は `onChange(null)` かつ削除ボタン無効化。

### 実機実測 (iOS・実ネイティブモジュール・実SQLite・実ファイルシステム)

手順: (1) フラグ配置→プロセス#1起動→ログ取得、(2) `simctl terminate` (rc=0・プロセス消滅確認) →プロセス#2起動→復元ログ取得、(3) 出力画像を端末からコピーして `sips` で画素確認、(4) 検証後にフラグ・ログ・fixture・プローブ画像を端末から削除し、フラグ無しで再起動して成果物が増えないことを確認。

```json
# プロセス#1
{"phase":"restore","draft":null,"draftExists":false,"draftBytes":0}
{"phase":"exif-decode","source":"320x240 jpeg, EXIF Orientation=6","width":240,"height":320,"normalized":true}
{"phase":"commit","status":"committed","width":1024,"height":1024,
 "relativePath":"images/__avatar_probe/070ef2e1-….jpg","bytes":27226,
 "stages":{"decode":{"ok":2},"fit":{"ok":2},"flatten":{"ok":1},"encodeJpeg":{"ok":1},"commit":{"ok":1}}}
# プロセス#2 (terminate rc=0 → プロセス消滅確認 → 再起動)
{"phase":"restore","draft":"images/__avatar_probe/070ef2e1-….jpg","draftExists":true,"draftBytes":27226}
```

| 検証項目 | 期待 | 実測 |
| --- | --- | --- |
| EXIF回転 (320×240, Orientation=6) のdecode寸法 | 240×320 | width 240 × height 320、`normalized: true` — **向き補正を実ネイティブで確認** |
| 透過PNG (1600×1200) の確定結果 | 1024×1024 JPEG | `committed`、**1024×1024**、27,226 bytes、`images/__avatar_probe/….jpg` |
| 出力の4隅画素 (透過だった箇所) | 白・不透明 | topLeft/topRight/bottomLeft/bottomRight すべて **(254,254,254)・alpha 255** (JPEG量子化による1の差のみ) |
| 出力の中央画素 | 画像内容が残る | **(219,40,40)** — fixtureの不透明赤コア (220,40,40)。白合成であって白紙ではないことの確認 |
| 終了→再起動後の読込み | 前回の下書き参照+実ファイル | terminate rc=0・プロセス消滅確認後、プロセス#2が `070ef2e1-….jpg` を復元、`draftExists: true`・27,226 bytes |
| 差し替え後の旧staged回収 | 旧ファイル削除 | 差し替え後に `images/__avatar_probe/` は新ファイル1件のみ |
| フラグ削除後の再起動 | プローブ無動作 | avatar-probe の成果物ゼロ (フラグゲート確認) |

- ステージ所要時間 (実機): decode 13〜42ms / fit 41〜43ms (二段) / flatten 68〜72ms / encode 4〜5ms / commit 5〜9ms。
- **検証中に判明し修正した点**: iOS の `UIGraphicsImageRenderer` は**画面スケールでラスタライズ**するため、1024² 要求のSVG合成が 3072² (3×) になり、最初の実行はコミット前検査で拒否された (全ネイティブステージは成功)。対処として合成PNGのIHDRから実寸を読む `pngDimensionsFromBase64` と、合成後に1024キャップを再適用するステージを追加 (`src/media/avatar.ts`)。iOS base64の改行は除去してから書き込む。修正後の同一環境で `committed` まで到達。

### device-pending (今回実測できない項目・理由)

| 検証項目 | 状態 | 理由・代替検証 |
| --- | --- | --- |
| OSピッカー/カメラUIでの撮影・選択 (正方形切り抜き画面) と実写真ライブラリの操作 | **DEVICE-PENDING** | Xcode 27ヘッドレスシミュレータはタップ入力が無くOSピッカーUIを操作できない。加えてAvatarPickerはタスク17で初めて画面へ配線され、本タスク時点で到達可能なルートが無い。jestではキャンセル・権限拒否・形式拒否・削除の配線を実測 |
| ピッカー出力そのものの向き (ピッカーがEXIFを焼き・タグを外すこと) | **DEVICE-PENDING** (ソース確認のみ) | ピッカーUIが操作不能なため実測不可。expo-image-picker のソースで iOS `fixOrientation()` / Android `copyExifData` が `TAG_ORIENTATION` を除外することを確認。本プローブはその「タグが付いていない/焼き済み」入力を扱うdecode段階を実機で確認 |
| Android の白背景合成・寸法・EXIF | **DEVICE-PENDING** | この環境にAndroidビルド/実機が無い (タスク14と同じ外部条件)。`SvgView.toDataURL(w,h)` は指定寸法のBitmapを使う実装 (ソース確認) で、合成も含め同一コードをjestで通している |
| 物理端末でのカメラ撮影 | **DEVICE-PENDING** | タスク21/22の実機パスへ |

- JS層の46件はすべてMOCKED-LAYERの下、**実機で白背景・寸法・再起動読込みを確認したのは上記のプローブ実測のみ**。モックを実機成功の証拠にはしていない。

---

## Task 15: 招待Web入口とドメイン関連付け (2026-09-26 JST)

**すべてローカル検証・未公開。** 実HTTPSドメイン・実bundle id・実署名・実ストアIDは
未提供のため、配信・関連付け・ストア遷移の実測は行っていない (手順のみ
docs/operations/app-foundation-friends-ui.md Task 15 節に記載)。
以下に現れた `example`/`example.test` 値は**テスト専用fixture**であり、公開値ではない。

### 検証コマンドと実測

```
$ node --test scripts/invite-web.test.mjs
ℹ tests 25  ℹ pass 25  ℹ fail 0   (exit 0)

$ node scripts/build-invite-web.mjs            # 値なし → 失敗 (期待どおり)
error: missing required invite web inputs: INVITE_ORIGIN, IOS_BUNDLE_ID,
APPLE_TEAM_ID, APP_STORE_ID, ANDROID_PACKAGE, ANDROID_CERT_SHA256. …   (exit 1)

$ node scripts/build-invite-web.mjs --test-config --out <tmp>
invite web build OK [TEST-ONLY (do not publish)]                      (exit 0)

$ npm --prefix app run typecheck   → 0 errors (app/app.config.ts を含む)
$ npm --prefix app test            → 29 suites / 494 tests 全通過 (増分なし)
$ cd app && npx expo config --type public  (INVITE_ORIGIN なし) → exit 0・追加なし+
  stderr「INVITE_ORIGIN not set — skipping …(no domain was invented)」
$ INVITE_ORIGIN=https://invite.invite-web.test npx expo config --type public → exit 0・
  ios.associatedDomains=['applinks:invite.invite-web.test'] +
  android.intentFilters(autoVerify, https, host同値, pathPrefix=/invitation, BROWSABLE/DEFAULT)
$ INVITE_ORIGIN=http://insecure.example npx expo config --type public → exit 1 (明確なエラー)
```

### `scripts/invite-web.test.mjs` の主な内容 (25件)

- **入力検証**: 6変数すべて欠落→一括列挙で失敗 / 部分欠落→残りのみ名指し /
  不正値 (http・path付きorigin・port・非bundle id・10桁以外のteam id・非数値store id・
  不正package・64桁でないSHA) で失敗。 originは正規化 (末尾スラッシュ除去)、
  SHAはコロン除去+小文字化。既定値・偽値の自動補完は一切なし。
- **出力検証**: `--test-config` で7ファイル生成 (TEST-ONLY-OUTPUT.txt 含む・
  DO NOT PUBLISH バナー)、実値相当envでの生成はマーカーなし。静的3ファイルは
  `invite-web/` の原文コピー。AASA `appID`/`paths: ['/invitation/*']`、assetlinks の
  `package_name` + `sha256_cert_fingerprints` が検証済み入力と一致 (JSON・末尾改行)。
- **app.js 安全性**: `.innerHTML` / `.outerHTML` / `insertAdjacentHTML(` /
  `document.write(` の使用ゼロ・`textContent` のみ (トークンをHTML挿入しない)。
- **実ページ (生成済み runtime-config + app.js を vm 実行)**:
  - Android: Play URL の `referrer` デコード値が `invitation=<urlencoded 32hex>` と
    完全一致 (Task 14 の `parseInstallReferrer` が読む形)。タップで遷移。
  - iOS: 読み込み時はコピーなし → タップ内で書込み → 成功後にのみ App Store へ遷移、
    失敗時は遷移せず再試行ボタン+URLの再開案内を表示、clipboard非対応も説明のみ。
  - runtime-config 欠落・不正トークン → 説明文を表示 (パネル非表示・トークン露出なし)。
  - テスト専用出力には日本語バッジ表示。
- **expo config 両状態**: 値なし→成功・domain追加なし (既存 app.json 値と
  `enableSceneSupport: true` 維持) / INVITE_ORIGINあり→両OSに同値反映 /
  不正値→非0で失敗。

### 未検証 (外部入力待ち・BLOCKEDではなく外部依存)

- 実HTTPS配信・associationファイルのリダイレクトなし・署名一致・実ストアURL・
  実Play referrer/実iOS貼り付けのE2E → 手順は運用手順書。**公開済みとは記録しない。**

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
