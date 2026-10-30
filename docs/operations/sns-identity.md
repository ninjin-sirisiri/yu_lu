# 会話とストリークで育つ見た目 — 移行・運用runbook

対象: [設計](../sdd/specs/2026-10-30-sns-identity-design.md) /
[検証記録](../testing/sns-identity.md)。
**状態: ローカル専用環境で自動検証済み。本番デプロイ・本番push・外部ジョブ登録は未実施。**
この文書は承認済み環境へ適用するときの順序・検査・停止条件を定める。ここに書いた検査SQLは
読み取り専用で、そのまま実行できる形を基本とする。値を捏造するSQLや通常DBをresetする手順は置かない。

## 1. 変更セット

| 層 | 変更 | 備考 |
| --- | --- | --- |
| DB migration | `0023_chat_growth.sql`、`0024_streak_appearance.sql`、`0025_chat_appearance_settings.sql`、`0026_appearance_queries_realtime.sql` | 既存0001–0022は書き換えない。各ファイルは `begin; … commit;` |
| Edge Functions | `app-command` / `app-query` と `_shared/appearance-commands.ts`、`_shared/chat-queries.ts`、`_shared/commands.ts` | 既存の入力・応答キーを削除しない。新項目は追加のみ |
| アプリ | SQLite schema v3（`appearance_celebrations`）、新provider／画面／picker／演出 | 端末設定と演出台帳は端末内。他端末へ同期しない |
| 検証 | pgTAP 5ファイル、Deno appearance、`--suite appearance`、`appearance-journey` | 専用 `daily-chat-home-chat-test` / 55320–55329 |

新規の外部サービス、別の成長API、外部cron、新しい認証基盤は追加しない。

## 2. 適用順序（サーバー／Edge → アプリ）

**アプリを先に配布しない。** 旧アプリは新項目を無視して動けるが、新アプリは
`set_chat_appearance` と新しい読み取り項目をサーバーに要求する。順序を逆にすると設定変更と
見た目の取得が失敗する。

### 2.1 事前準備

1. 対象環境・プロジェクトID・承認者・実施windowを確認する。本番ならバックアップと復旧責任者を
   先に確定する。バックアップがない、承認がない、実施windowがない場合は**開始しない**。
2. 通常開発環境と本番を混同しない。ローカル検証は `daily-chat` / 54321系、専用検証は
   `daily-chat-home-chat-test` / 55320–55329。通常DBのresetは行わない。
3. 変更前の状態を読み取り専用で記録する（コンテナID、volume名、config SHA、migration version）。
   秘密値をログ・チャット・スクリーンショットへ出さない。
4. 新アプリの配布物とEdge Functionsの版を固定し、ロールバック可能な前版を保持する。

### 2.2 サーバー／Edge

1. **migrationを0023→0026の順で適用する。** ローカルでは承認済みのローカルスタックに対して
   `npx supabase migration up --local` を使う。本番は承認されたmigration適用ジョブ／CIを使い、
   このrunbookから本番pushを実行しない。`db reset` は使わない。
2. 0023は成長日と会話状態を作り、既存メッセージからバックフィルする。0024は本人の
   `streak_appearances` を作り、導入時現在値で初期化する。0025は共有設定コマンド、0026は
   読み取り契約とRealtime通知を追加する。
3. **Edge Functionsを先に配布する。** `app-command` / `app-query` と共有モジュールを、旧アプリの
   入力・応答を壊さない版で配布する。`set_chat_appearance` のpayload gateは
   `peer_id`・`friendship_epoch`・`preset_id` の3キーだけを受け、actorはJWTから決める。
4. 旧アプリ形状の送信・取得が通ることを確認してから、アプリ配布へ進む。

### 2.3 アプリ

1. 新アプリを配布する。初回起動でSQLite v3へのmigrationが走り、`appearance_celebrations` が
   追加される。migrationは1ファイル1トランザクションで、失敗時はDDLと `user_version` が戻る。
2. 初回canonical syncで、本人・各会話の基準を保存する。過去の節目は演出しない。
3. 設定変更、共有preset、演出、再起動、ログアウト、別アカウント分離を検証記録の順で確認する。
4. 旧cacheが残る端末では、新項目が欠けた観測を**確認中（モノクロ）**として扱い、0日確定や
   仮の獲得を作らない。数秒待っても確認中が続く場合は、通信・`app-query` の応答・
   `catalog_version` を確認する。cacheを手で消して直そうとしない。

## 3. ロックとバックフィル

### 3.1 ロック

- 成長・設定・関係変更・日次適用は既存の `command_boundary.lock_chat_lifecycle()` と
  lifecycle → pair → users → conversation の順に従う。この順序を逆にしない。
- 0023–0026の全migrationが `command_boundary.lock_chat_lifecycle()` を取る。0023・0024・0026は
  関連テーブルに `SHARE ROW EXCLUSIVE` も取り、バックフィル中に半端な状態を公開しない。
  送信・設定変更と同時に走らせない。
- 低トラフィックのwindowで適用する。lock待ちが運用上のしきい値を超えたら、killや
  lock削除で押し切らず、いったん停止して原因を確認する。

### 3.2 成長のバックフィル

- 既存の `messages` のうち、会話・04:00 JST日付・送信者でまとめ、**2人以上の送信者がいる日**
  だけを `chat_growth_days` へ挿入する。withdrawn後も受付事実（`accepted_at`）は残す。
- 挿入できた日だけ累計を増やす。既存の `chat_growth_days` との衝突では増やさない。
- `chat_appearance_state.growth_days` は日別row数から設定する。既存値より小さい値へは戻さない。
  選択preset・`settings_revision` は書き換えない。
- 物理的に残っていない履歴は推測しない。現在の本文検証で古い受付を無効化しない。
- 会話の識別は `conversation_id` で、`friendship_epoch` では分割しない。同日の友達解除・再成立でも
  同じ会話の同じ日は1日として扱う。
- 再実行（`command_boundary.initialize_chat_growth()`）はmissing rowの追加と、既存累計が
  日別row数より小さい場合の修復だけを行う。**加算の二重適用・巻き戻し・preset初期化をしない。**

### 3.3 本人状態のバックフィル

- `command_boundary.initialize_streak_appearances()` は、導入時点の `streaks.current_count` を
  0〜100へclampした値を `earned_days` の初期値にする。`streaks` がない本人は0。
- 過去最高をメッセージ・割当・`last_achieved_key` から作らない。導入前の不明な最高値を捏造しない。
- 新規profileは0で開始する。`earned_days` は0〜100の単調非減少で、現在streakがリセットしても下げない。
- 再実行は**missing rowだけを挿入**し、既存の `earned_days`・`appearance_version` を上書きしない。
  現在streakが100を超えても、`earned_days` の上限は100、現在値は従来どおり100超を保持する。
- 日付順の結果適用では各途中値の最大を採る。復旧処理の最後が0でも、途中で29へ達していれば
  `earned_days=29` を保持し、表示は7日段階になる。最終値だけを保存して7へ切り下げない。

## 4. 導入時の現在値と初回基準

### 4.1 本人の導入時現在値

- 初期 `earned_days = clamp(現在のstreak, 0, 100)`。0日なら0、29日なら29、100日以上なら100。
- 現在streakとearned_daysは別物である。現在0日・earned 29日は「獲得済み：7日段階」と表示し、
  「29日段階」「あと1日」とは表示しない。次の30日段階までは現在streakで30日を達成する。
- 100日段階獲得後は最大段階到達と表示し、架空の次の節目を作らない。

### 4.2 アプリの初回基準

- 本人・各会話の最初の正規同期を基準としてSQLiteへ保存する。基準時点以下の節目は演出しない。
  新端末・再インストール・初めて取得する会話も同じ。
- 0日の会話を正規取得した場合も、相手単位の基準を保存する。最初の送信で `conversation_id` が
  作られても基準を作り直さない。これにより、その後の1日達成を新しい節目として扱える。
- 旧cacheの項目欠落・未確認の仮0日では基準を作らない。未知version／presetは解釈せず、
  最後に確認した表示、なければ安全なモノクロへfallbackする。
- 演出記録の保存に失敗したら、その回は再生しない。成長の確定・表示や会話を止めない。
  消費の一括保存が失敗した場合は両方とも未消化のまま残す。
- 控えめ・オフ・種類別停止中は候補を積まない。再開時は種類ごとの再開世代を1回だけ進め、
  停止中に進んだ分を後からまとめて再生しない。通常の再起動・前景復帰では世代を進めない。
- ログアウトでは本文・画像・下書き・通常cacheを削除し、演出台帳と端末設定だけを明示的な例外として
  保持する。別アカウントから参照しない。

## 5. 障害時の動作

| 障害 | あるべき動作 | 確認方法 |
| --- | --- | --- |
| DB内の成長更新失敗 | メッセージ受付を含む同一トランザクションをロールバックする。受付済みにしない | `appearance-growth.test.sql` の rollback 節、送信結果の再確認 |
| 送信の通信切断・応答紛失 | 未受付と断定せず、同じclient key／operation IDで結果を確認する。新IDで自動再送しない | 既存の送信outbox、backendの再送検査 |
| 成長状態の取得失敗・オフライン | 最後の確定表示を維持する。未取得ならモノクロの確認中。0日へ変換しない | `observations.test.ts`、画面の確認中表示 |
| 共有設定の結果不明 | 元のoperation ID・元のpayloadを保持して確認する。解決まで別の変更を自動発行しない | `sharedSettings.test.ts`、`appearance-picker.test.tsx`、backendのlost response |
| 設定の同ID再実行 | サーバーは保存済み結果を返し、再適用しない。同じIDでpayloadが違えば409 | §6.3のoperation log検査、backendのreplay |
| 関係世代の失効 | その変更を403として扱い、新しい世代の変更へ自動変換しない | backendのunfriend/re-friend、設定SQL |
| 未対応のversion／preset | 実行せず、最後の確定表示またはモノクロへfallback。本文・下書きを消さない | `contracts.test.ts`、`appearance-layout.test.tsx` |
| 演出記録の読込失敗 | 演出を開始しない。成長の確定・表示は続ける | `celebrations.test.ts` |
| 演出記録の保存失敗 | 両方の演出を開始せず、未消化のまま残す。次回の正規syncで再判定 | `celebrations.test.ts` の consume failure |
| 停止設定の保存失敗 | その起動中だけメモリ内の選択を維持し、保存失敗と再試行を表示する。保存済みと偽らない | `preferences.test.tsx` |
| 空会話 | 設定保存だけで会話を作ることは許容するが、一覧・ホームへは最初の実送信まで出さない | backend、`appearance-queries.test.sql` |
| 旧cacheの項目欠落 | 確認中として扱い、0日・獲得済みを捏造しない | §4.2 |

### 5.1 共有設定の結果不明から回復する手順（アプリ操作）

1. pickerに「結果確認中」が出たら、新しいpresetを選び直さない。元のoperation IDとpayloadが
   端末に保存されている。
2. 「結果を確認」で**同じoperation ID**を再送する。アプリは新しいIDを生成しない。
3. サーバーが初回受付済みなら保存済み結果を返す。未受付ならそのIDで初回受付になる。
4. 成功後も、成功応答の値を現在設定として直接上書きせず、確定queryを再取得する。
5. 同じIDでpayloadが違う場合は409。新しいIDでやり直さず、表示されたエラーと元の記録を確認する。
6. 関係世代が失効している場合は403。新しい関係の変更へ自動変換しない。

## 6. 検証SQL（そのまま実行する）

以下は原則としてDB所有者（`postgres`）で実行する。`command_boundary` はクライアントroleから
revokeされているため、anon／authenticatedでは検査できない。本番では承認された読み取り専用
SQLコンソールを使い、結果に本文・画像・認証情報を含めない。

### 6.1 migration・table・RLS・privilege・通知対象

```sql
-- 1) 適用済みmigration（0023〜0026の4行が返ること）
select version
from supabase_migrations.schema_migrations
where version in ('0023','0024','0025','0026')
order by version;

-- 2) テーブルとRLS（4行、rls_enabled=true）
select n.nspname as schema_name, c.relname as table_name,
       c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('chat_growth_days','chat_appearance_state',
                    'streak_appearances','chat_updates')
order by 1,2;

-- 3) クライアント／サービスroleの直接権限
--    期待: すべてfalse。例外は chat_updates の authenticated SELECT だけtrue。
select t.table_name, r.role_name,
       has_table_privilege(r.role_name, format('public.%I', t.table_name), 'SELECT') as can_select,
       has_table_privilege(r.role_name, format('public.%I', t.table_name), 'INSERT') as can_insert,
       has_table_privilege(r.role_name, format('public.%I', t.table_name), 'UPDATE') as can_update,
       has_table_privilege(r.role_name, format('public.%I', t.table_name), 'DELETE') as can_delete
from (values ('chat_growth_days'),('chat_appearance_state'),
             ('streak_appearances'),('chat_updates')) t(table_name)
cross join (values ('anon'),('authenticated'),('service_role')) r(role_name)
order by 1,2;

-- 4) PUBLICへのgrant（0行が期待値）
select c.oid::regclass as table_name, a.privilege_type
from pg_class c
cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
where c.oid in ('public.chat_growth_days'::regclass,
                'public.chat_appearance_state'::regclass,
                'public.streak_appearances'::regclass,
                'public.chat_updates'::regclass)
  and a.grantee = 0
order by 1,2;

-- 5) RLS policy（chat_growth_days/chat_appearance_state/streak_appearancesは0行、
--    chat_updatesは chat_updates_self の1行）
select tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('chat_growth_days','chat_appearance_state',
                    'streak_appearances','chat_updates')
order by 1,2;

-- 6) Realtime publication。chat_updatesだけが公開され、元テーブルは公開されない
select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
  and schemaname = 'public'
order by 1,2;

select count(*) as published_source_tables
from pg_publication_tables
where pubname = 'supabase_realtime'
  and schemaname = 'public'
  and tablename in ('chat_growth_days','chat_appearance_state','streak_appearances');
-- 期待: 0

-- 7) 端末ローカルの appearance_celebrations はサーバーに存在しない
select count(*) as device_local_table_in_server
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'appearance_celebrations';
-- 期待: 0

-- 8) 新状態のトリガー（chat_updates_* が各3本、初期化が各1本。
--    streaks_streak_appearance は INSERT/UPDATE のため information_schema では2行）
select event_object_table, trigger_name, event_manipulation
from information_schema.triggers
where trigger_schema = 'public'
  and (
    (event_object_table in ('chat_growth_days','chat_appearance_state','streak_appearances')
      and trigger_name like 'chat_updates_%')
    or (event_object_table = 'conversations' and trigger_name = 'conversations_chat_appearance_state')
    or (event_object_table = 'profiles' and trigger_name = 'profiles_streak_appearance')
    or (event_object_table = 'streaks' and trigger_name = 'streaks_streak_appearance')
  )
order by 1,2,3;
```

`appearance_celebrations` は端末SQLite（`app.db`）のv3 migrationで作る。端末側は次のSQLite SQLで
確認できる（サーバーのPostgresへは流さない）。

```sql
-- 端末SQLite。期待: user_version=3、テーブルが1行、name/body/image列を持たない
pragma user_version;
select name from sqlite_master where type = 'table' and name = 'appearance_celebrations';
pragma table_info(appearance_celebrations);
select account_id, kind, subject_id, baseline_days, consumed_milestone
from appearance_celebrations
order by account_id, kind, subject_id;
```

### 6.2 日別row数と累計の照合

```sql
-- 会話ごとの日別row数と累計。mismatchが0行であること。
select c.conversation_id,
       count(g.daily_key)::integer as daily_rows,
       coalesce(s.growth_days, -1) as cumulative_growth,
       (s.conversation_id is null) as missing_state,
       coalesce(s.growth_days, -1) - count(g.daily_key)::integer as difference
from public.conversations c
left join public.chat_growth_days g on g.conversation_id = c.conversation_id
left join public.chat_appearance_state s on s.conversation_id = c.conversation_id
group by c.conversation_id, s.growth_days, s.conversation_id
having s.conversation_id is null
    or s.growth_days <> count(g.daily_key)::integer
order by c.conversation_id;

-- 全体の合計でも照合する（期待: 2列が一致）
select (select count(*) from public.chat_growth_days) as total_daily_rows,
       (select coalesce(sum(growth_days), 0) from public.chat_appearance_state) as total_cumulative;

-- 重複日・孤立row（主キー／FKにより通常0件）
select conversation_id, daily_key, count(*) as duplicates
from public.chat_growth_days
group by 1,2
having count(*) > 1;

select count(*) as orphan_growth_days
from public.chat_growth_days g
left join public.conversations c on c.conversation_id = g.conversation_id
where c.conversation_id is null;
```

### 6.3 `set_chat_appearance` の操作logとrevision

```sql
-- 未決着の設定操作（0行が期待値。あればtransaction不整合として停止）
select count(*) as unsettled_appearance_operations
from command_boundary.operation_log
where kind = 'set_chat_appearance'
  and settled_at is null;

-- 同じactor+operation IDの重複（主キーにより0行）
select actor_id, operation_id, count(*) as duplicates
from command_boundary.operation_log
where kind = 'set_chat_appearance'
group by 1,2
having count(*) > 1;

-- 会話ごとの最新settled結果と現在stateの一致（0行が期待値）
with logged as (
  select l.actor_id, l.operation_id, l.settled_at,
         (l.result->>'conversation_id')::uuid as conversation_id,
         (l.result->>'settings_revision')::bigint as logged_revision,
         l.result->>'selected_preset_id' as logged_selected
  from command_boundary.operation_log l
  where l.kind = 'set_chat_appearance'
    and l.result is not null
    and l.result ? 'conversation_id'
    and l.result ? 'settings_revision'
), latest as (
  select distinct on (conversation_id) *
  from logged
  order by conversation_id, logged_revision desc, settled_at desc
)
select l.conversation_id, l.operation_id, l.logged_revision,
       s.settings_revision as current_revision,
       l.logged_selected as logged_selected,
       s.selected_preset_id as current_selected
from latest l
left join public.chat_appearance_state s on s.conversation_id = l.conversation_id
where s.conversation_id is null
   or s.settings_revision is distinct from l.logged_revision
   or s.selected_preset_id is distinct from l.logged_selected;

-- 受付済み操作数とrevisionの整合（0行が期待値）
with logged as (
  select (l.result->>'conversation_id')::uuid as conversation_id,
         (l.result->>'settings_revision')::bigint as logged_revision
  from command_boundary.operation_log l
  where l.kind = 'set_chat_appearance'
    and l.result is not null
    and l.result ? 'conversation_id'
    and l.result ? 'settings_revision'
)
select l.conversation_id,
       count(*) as accepted_operations,
       max(l.logged_revision) as max_logged_revision,
       s.settings_revision as current_revision
from logged l
left join public.chat_appearance_state s on s.conversation_id = l.conversation_id
group by l.conversation_id, s.settings_revision
having s.settings_revision is null
    or max(l.logged_revision) <> s.settings_revision
    or count(*) > s.settings_revision;
```

### 6.4 本人のearned_daysと現在streak

```sql
-- 欠落・範囲外・現在streakより低いearned_days（0行が期待値）
select p.user_id,
       coalesce(s.current_count, 0) as current_streak,
       a.earned_days,
       a.appearance_version
from public.profiles p
left join public.streaks s on s.user_id = p.user_id
left join public.streak_appearances a on a.user_id = p.user_id
where a.user_id is null
   or a.earned_days not between 0 and 100
   or a.appearance_version <> 1
   or a.earned_days < least(greatest(coalesce(s.current_count, 0), 0), 100);

-- 件数（profilesとappearance_rowsが一致し、missing_rows=0）
select count(*) as profiles,
       count(a.user_id) as appearance_rows,
       count(*) filter (where a.user_id is null) as missing_rows
from public.profiles p
left join public.streak_appearances a on a.user_id = p.user_id;
```

`earned_days > current_streak` はリセット後の保持として正常である。上の検査は「現在値より
低いのに保持されていない」場合だけを異常とする。0〜100の範囲とversionも同時に見る。

### 6.5 専用環境の所有権・cleanup

専用スタックが起動中のときだけ、そのDB（`daily-chat-home-chat-test`）で実行する。通常DBには流さない。

```sql
-- fixtureのAuthユーザー（cleanup後は0）
select count(*) as fixture_auth_users
from auth.users
where email like 'chat-%@example.test';

-- 成長stateと日別rowの孤立（0が期待値）
select count(*) as growth_without_state
from public.chat_growth_days g
left join public.chat_appearance_state s on s.conversation_id = g.conversation_id
where s.conversation_id is null;

select count(*) as state_without_conversation
from public.chat_appearance_state s
left join public.conversations c on c.conversation_id = s.conversation_id
where c.conversation_id is null;

select count(*) as unsettled_operations
from command_boundary.operation_log
where settled_at is null;
```

スタック停止後の所有資源は、読み取り専用のシェル確認で行う。

```sh
# 専用コンテナ・volume（出力がなければclean）
docker ps -a --format '{{.Names}}' | grep '_daily-chat-home-chat-test$' || echo 'clean: no dedicated containers'
docker volume ls --format '{{.Name}}' | grep '_daily-chat-home-chat-test$' || echo 'clean: no dedicated volumes'

# 専用ポート（何もLISTENしていなければclean）
lsof -nP -iTCP:55320-55329 -sTCP:LISTEN || echo 'clean: dedicated ports free'

# lock・一時ディレクトリ・プロセス
test ! -e "${TMPDIR:-/tmp}/opencode/.daily-chat-home-chat-test.lock" && echo 'clean: no lock'
find "${TMPDIR:-/tmp}/opencode" -maxdepth 1 -name 'daily-chat-home-chat-test-*' -print
pgrep -fl 'test-chat-backend|supabase functions serve' || echo 'clean: no runner/serve process'

# 通常状態（通常stackは起動・停止しない。前後のスナップショットと比較する）
git diff --exit-code -- supabase/config.toml
test ! -e app/.env && echo 'app/.env absent'
docker ps -a --format '{{.ID}} {{.Names}}' | grep '_daily-chat$'
```

専用runnerが失敗した場合、所有者・project ID・lockの持ち主が確認できるまで、コンテナ停止・
volume削除・lock削除をしない。他のプロセスの資源を流用しない。

## 7. ロールバックと停止条件

### 7.1 停止条件（1つでも該当したらアプリ配布へ進まない）

- migrationが失敗した、または0023–0026の適用が4件揃っていない。
- §6.1でRLS・privilege・publication・triggerの期待値が崩れている。
- §6.2で日別row数と累計のmismatchが1件でもある。
- §6.3で未決着operation、revision不一致、選択preset不一致がある。
- §6.4でearned_daysの欠落・範囲外・現在値割れがある。
- 旧アプリ形状の送信・取得が失敗する、または新Edgeで旧クライアントが壊れる。
- 通常DBのreset、本番push、外部job登録が必要になる（このrunbookの範囲外。承認を得る）。
- 専用環境のcleanupが完了しない、通常コンテナ・config・`.env`が変化した。

### 7.2 ロールバック

- **migration**: 各ファイルは `begin; … commit;`。失敗時はそのファイルの変更を残さず停止する。
  適用済みmigrationを手で削除・改変しない。破壊的なdownは用意せず、必要な修正は承認済みの
  前方修正migrationで行う。バックアップからの復旧は対象環境の責任者が判断する。
- **Edge Functions**: 旧版へ戻せる。DBは追加のみなので、旧Edge＋旧アプリは動く。新アプリだけが
  残る状態でEdgeを旧版へ戻すと `set_chat_appearance` が失敗するため、アプリ配布も止める。
- **アプリ**: 前版ビルドへ戻す場合は、端末SQLiteがv3へ上がっていることに注意する。v3を知らない
  旧ビルドは `SchemaVersionError` でDBを開けない。v3適用済み端末へ旧ビルドを配る場合は、
  端末データ消去（下書き・演出台帳・設定が消える）を通常のロールバックとして扱わず、
  前方修正ビルドを優先する。
- **状態の復元**: 日別row・累計・earned_daysを手SQLで捏造しない。バックフィル関数の再実行は
  missing rowの追加と累計の修復だけを行い、既存値を下げない。

### 7.3 やってはいけないこと

- 通常開発DB・本番DBの `supabase db reset`、`drop schema`、volume削除。
- 通常プロジェクトの `supabase stop`、他作業のコンテナ・lock・volumeの停止／削除。
- 承認なしの本番push、本番デプロイ、外部cron／ジョブ登録。
- 専用stackコマンドの並列実行、通常資格と専用資格の混用。
- 適用済みmigrationの書き換え、既存の応答キーの削除、anon key以外の秘密値のアプリ混入。
- 手SQLで成長日・earned_days・preset・revisionを直接作る／書き換える。
- renderer・HTML試作・ビルド成功を、両OSのネイティブ描画・読み上げの合格として扱う。
- `app/.env` や端末DBを、秘密・本文・画像を含んだままリポジトリやログへ出す。

## 8. 適用後の確認と記録

1. §6のSQLを適用直後とアプリ配布後に実行し、結果を日時・commit・環境とともに残す。
2. 旧アプリ形状の送信、共有preset、結果不明の同ID確認、空会話の非表示を実HTTPで確認する。
3. アプリの初回起動で`appearance_celebrations`がv3で作られ、初回基準が保存されることを確認する。
4. ログアウト後に通常データが消え、演出台帳・端末設定だけが残ることを確認する。
5. 両OSの見た目・操作・VoiceOver／TalkBack・動き軽減・性能は、[検証記録](../testing/sns-identity.md)の
   **未確認**欄をTask 18の証拠で埋めるまで完了扱いにしない。
6. 本番反映の可否は、このrunbookの成功とは別の承認で決める。本番反映・外部job登録は未実施である。
