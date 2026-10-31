# 台本の確認記録

対象は `content/narration.md` です。新規作成の台本として、`yomiyasu` の台詞・脚本向けの指針を参照しました。

## 今回の改訂

- アプリ名を `Yu_Lu`、読み上げを `ユール` に変更しました。字幕と図の表示は英字、音声はカタカナの読みを分けて指定しています。変更した2文以外の文言は変えていません。
- 現在の記録は `20261031T114449Z-9861dd84`、最終稿のSHA-256は `d3ead5ed3a93…` です。lintは候補0件、差分の意味リスク候補は0件でした。
- yomiyasu-check: executed via=run run=20261031T114449Z-9861dd84 attempt=1 final=sha256:d3ead5ed3a93 mode=rewrite doc_type=script checks=lint,diff meaning_risk=0
- 以下は前回までの改訂履歴です。

## 変えたところ

- 「相手を見つけるための入り口」を「相手を見つけられます」に改め、操作を具体的に書きました。
- 未収録の成長プレビューを収録したように述べていた草案を、仕様上の節目の説明へ改めました。

## 事実の確かめ

- 資料はリポジトリの `CONTEXT.md`、`README.md`、`app/src/appearance/catalog.ts` です。
- 静的検査の数値候補は、1・7・30・60日の節目と朝4時でした。`CONTEXT.md` のChat Growthの定義と `catalog.ts` の `APPEARANCE_MILESTONES`、`README.md` の「今日の達成を確認する」にある04:00 JSTと読み比べ、値を残しました。
- 個人の連続日数とふたりの累計日数は区別しました。会話が増える効果や利用者の実績は主張していません。
- 今後の検証方針は提案段階の文章です。開発者本人の意図との読み合わせが必要です。

## 確認の記録

- 書き手: 決めていない／読み手: 決めていない／場面: script（指定された台本用途）
- 実行した検査: lint、資料との照合、最終稿の照合
- 実行しなかった検査: diff（新規作成のため）、全編の人手による試聴
- 見直し候補: 最終稿 0件（件数は点数ではない。読みやすさの合格を示すものではない）
- yomiyasu-check: executed via=verify run=20261031T095117Z-e93382ec attempt=1 final=sha256:489048c18cc1 mode=compose doc_type=script checks=lint,materials meaning_risk=5 replay=skipped
