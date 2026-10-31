# Daily Chat — 作品提出用 README

MBC U-20 NEXT PROGRAMMING CONTEST 2026 / アプリ（ソフトウェア）部門

## 1. 作品概要

**Daily Chat** は、友達との「毎日の会話のきっかけ」を作るスマートフォンアプリです。

毎日サーバーが送信相手（Send Target）と返信相手（Reply Target）を割り当てます。
ユーザーは送信相手にメッセージを送り、届いた相手には返信します。これを続けると
Streak（連続達成日数）が伸び、2人の会話が積み重なるほどチャット画面の見た目が
1日・7日・30日・60日・100日の節目で成長します。

「誰かに話しかけたいけれど、きっかけがない」「既読はつくのに会話が続かない」という
日常の小さな課題に対して、負担の少ない1対1のやり取りを毎日1回だけ用意することを
狙っています。友達はUser ID検索または招待リンク・QRコードから、申請と承認を経て成立します。

## 2. 主な機能

- Apple / Google によるOAuthログイン（メール・パスワードログインは持たない）
- User ID検索、友達申請・承認、招待リンク／QRコード（ディープリンク対応）
- 毎日04:00 JSTに切り替わる送信相手・返信相手の割り当て
- テキスト（10,000書記素まで）と画像（最大4枚）の非同期チャット
- オフライン時の送信予約、再接続・アプリ復帰・バックグラウンドでの自動同期
- 送信待ち／確認が必要／結果確認中の状態表示、重複しない再送
- 既読管理、未読バッジ、アプリ内の新着表示
- StreakとChat Growth（2人の累計会話日数）の記録と節目の演出
- ライト／ダークテーマ、文字サイズ拡大、読み上げ、動きの軽減への対応
- 友達成立後も、今日の割り当てがなく自由に会話できるチャット画面

## 3. 技術構成

| 層 | 使用技術 |
| --- | --- |
| モバイルアプリ | Expo SDK 58 / React Native 0.88 / React 19 / TypeScript / Expo Router |
| ローカル保存 | expo-sqlite（送信キュー、下書き、既読状態） |
| バックエンド | Supabase（PostgreSQL 17、Auth、Storage、Realtime、Edge Functions） |
| Edge Functions | Deno / TypeScript |
| 招待Web | 静的HTML・CSS・JavaScript |
| テスト | Jest / Testing Library / pgTAP / Deno Test / Node Test Runner |

## 4. 審査員の方向け：収録内容と確認方法

このZIPには、アプリ・バックエンド・招待Webの**ソースコードと素材**を収録しています。
ビルド済みアプリ（.ipa / .apk / .exe など）や `node_modules`、生成物は含めていません。
実際の動作は、別途提出する**作品説明動画（実行デモ）**で確認できます。

### 4.1 最短の起動方法（ローカルSupabase + 開発ビルド）

必要なもの: Node.js 22.13+ / 24.3+ / 26以降、Docker、Supabase CLI、Xcode または Android SDK。

```sh
# 1. バックエンド
npx supabase start
npx supabase migration up --local

# 2. Edge Functions（別ターミナル。アプリ利用中は起動したまま）
npx supabase functions serve

# 3. アプリの環境変数
cp app/.env.example app/.env
# `npx supabase status` の API URL と anon key を app/.env に設定する

# 4. アプリ
npm --prefix app ci
npm --prefix app run ios       # または npm --prefix app run android
```

- `app/.env` の `EXPO_PUBLIC_SUPABASE_URL` は `http://127.0.0.1:54321`、
  `EXPO_PUBLIC_SUPABASE_ANON_KEY` は `npx supabase status` の anon key を使います。
- 招待機能まで試す場合のみ `EXPO_PUBLIC_INVITE_ORIGIN`（HTTPSのorigin）を設定します。
- **OAuthの資格情報（Google Client Secret、Appleの秘密鍵など）は本ZIPに含めていません。**
  `supabase/config.toml` の Google クライアントIDもプレースホルダに置き換えています。
  審査環境でログインまで再現する場合は、Google Cloud / Apple Developer で
  ご自身のクライアントを用意し、`supabase/config.toml` の該当箇所とルートの `.env` に
  設定してください。ログインを含む一連の動作は提出動画で確認できます。
- 実機から接続する場合、`127.0.0.1` は端末自身を指すため、PCのLANアドレスに
  置き換える必要があります（詳細は `DEVELOPMENT.md` の「2.2 起動コマンド」）。

### 4.2 テスト

```sh
npm --prefix app run typecheck
npm --prefix app test -- --runInBand --testPathIgnorePatterns home-chat-journey.test.tsx
npx supabase test db
npx deno test --allow-env --allow-net --config supabase/functions/deno.json supabase/functions/tests
```

実バックエンドを伴う統合テストは `DEVELOPMENT.md` の「5. 動作確認と自動テスト」を参照してください。
DockerとローカルSupabaseの起動が必要です。

## 5. ディレクトリ構成

```text
DailyChat/
├── README.md                作品概要とクイックスタート
├── DEVELOPMENT.md           開発・検証の詳細
├── SUBMISSION.md            本ファイル
├── app/                     スマートフォンアプリ本体（Expo / React Native）
│   ├── src/
│   │   ├── app/             画面（Expo Router）
│   │   ├── auth/            ログイン・セッション
│   │   ├── daily/           日次の割り当て
│   │   ├── messages/        チャット
│   │   ├── sync/            オフライン送信キューと同期
│   │   ├── appearance/      Streak・Chat Growthの見た目
│   │   ├── invitations/     招待リンク・QR
│   │   ├── storage/         SQLite
│   │   └── ...
│   ├── __tests__/           画面・結合テスト
│   ├── assets/              アイコンなどの素材
│   └── package.json
├── supabase/
│   ├── migrations/          スキーマ、RLS、コマンド境界、集計SQL
│   ├── functions/           Edge Functions（Deno / TypeScript）
│   └── config.toml          ローカルSupabase設定
├── invite-web/              招待ランディング（静的サイトのソース）
├── scripts/                 ビルド・検証・テスト用スクリプト
└── docs/                    設計・運用手順・検証記録
```

`app/ios` と `app/android` は Expo の prebuild で生成されるため収録していません。
`npx expo prebuild` で再生成できます。

## 6. メインコード単体ファイル（フォームの「2-A」で別途提出）

特に工夫した3ファイルを、単体ファイルとして提出しています。

1. **`app/src/sync/queue.ts`** — オフライン送信キューの状態機械。
   送信の重複、順序、24時間の期限、応答喪失時の「確認が必要」、アプリ強制終了後の復旧を、
   SQLiteの単一トランザクションと冪等な操作IDで扱います。
2. **`app/src/messages/text.ts`** — Unicode 17.0 / UAX #29 に基づく書記素数の計算と入力検証。
   `Intl` や環境依存の正規表現を使わず、iOS・Android・Denoで同じ結果になるようにしています。
3. **`supabase/migrations/0023_chat_growth.sql`** — Chat Growthのサーバー側集計。
   会話・日付の主キーで同じ日の重複加算を防ぎ、RLSと権限剥奪でクライアントからの直接書き込みを
   許さず、表示用の段階だけを後段で制限します。

## 7. 設計上の工夫

- **サーバーを正とするコマンド境界**: クライアントは送信・既読・設定変更を
  Edge Function のコマンドとして送り、SQL側で本人性・関係世代・冪等性・検証記録を確定します。
  クライアントの自己申告（送信済み・既読・達成）をそのまま信用しません。
- **オフラインでも壊れない送信**: 送信は「入力 → 予約 → 送信 → 確定」の状態を持ち、
  再送しても同じ操作IDでサーバーが再生します。結果が不明な場合は自動で成功扱いせず、
  「確認が必要」としてユーザーに区別して見せます。
- **日付の境界を固定**: 日次の切り替えは端末時計ではなくサーバーの04:00 JSTで行い、
  抽選は04:05より前に確定させます。端末の時計変更や再取得で対象者が入れ替わりません。
- **表示と記録の分離**: StreakやChat Growthの見た目は、サーバーに記録された事実から導出します。
  開発用のプレビューは`__DEV__`限定で、実際の記録を書き換えません。
- **アクセシビリティ**: 文字サイズ、コントラスト、読み上げラベル、動きの軽減を画面ごとに確認し、
  文字倍率や画面幅が変わっても入力中の内容と選択中の相手を失わないようにしています。

## 8. 秘密情報・個人情報の扱い

- 実際の `.env`、Supabaseのanon key / service_role key、OAuthのクライアントシークレット、
  Appleの秘密鍵はZIPに含めていません。
- 環境変数は `app/.env.example`、`app/env/*.example`、ルートの `.env.example` の
  プレースホルダのみを収録しています。
- 本番SupabaseのプロジェクトURLや実在のアカウント情報は含めていません。
- テスト用のメールアドレスはすべて合成データ（`@example.com` など）です。
- 画像素材はアプリアイコン等の画像のみで、第三者の写真・フォント・音声素材は含めていません。

## 9. 生成AIの利用について

開発における生成AIの利用有無・モデル名・利用範囲は、応募フォームの設問
「開発における生成AIの利用有無」「AIを利用した範囲やその内容」に記載しています。
提出するコードは、いずれも内容を説明できる状態で確認・修正したものです。

## 10. ライセンス

アプリ本体のライセンスは `app/LICENSE` を参照してください。
本ZIPはコンテストの審査目的で提出するものです。
