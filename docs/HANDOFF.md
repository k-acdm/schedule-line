# 引き継ぎメモ（schedule-line）

## 最終更新
2026-09-16 ★ 段階1〜4 実装・動作確認完了。プロジェクト完成 ★

## プロジェクト概要
- 春日部アカデミーの「授業日程表」JPGを、生徒・保護者へ **LINE配信** するツール
- 数ヶ月に1回、日程表を更新するタイミングで使う運用
- Google Apps Script（GAS）+ clasp 運用。管理画面はGASのWebアプリ
- 姉妹プロジェクト `billing-line`（月次引き落とし通知のLINE配信）と同じ構成・運用ルール

## システム構成

```
[schedule-line-images フォルダ(Drive)]   生徒ごとの日程表JPG（ファイル名＝生徒氏名）
            │
            ▼
[schedule-line GAS (Webアプリ)]
   ├─ doGet ?image=氏名     … 画像のブラウザ確認用プレビュー（段階1）
   ├─ 管理画面(admin.html)  … あいさつ文入力／プレビュー／テスト・本配信／削除
   ├─ getDeliveryTargets    … 画像とRecipientsシートを照合（段階2）
   ├─ testSend/execute…     … LINE Messaging API で配信（段階3）
   └─ deleteDeliveredImages … 配信後にJPGをゴミ箱へ（段階4）
            │                         ▲
            ▼                         │
[schedule-line-data スプレッドシート]  │
   └─ Recipients シート ──────────────┘
            │
            ▼
[LINE Messaging API push] → 生徒・保護者のLINEへ「あいさつ文＋画像」
```

### 各段階の役割
| 段階 | 内容 | 主な関数 |
|---|---|---|
| 1 | 画像配信の仕組み | `_serveImage` / `_buildImageUrls` |
| 2 | Recipients照合・管理画面 | `getDeliveryTargets` / `_computeDelivery` |
| 3 | テスト配信・本配信 | `testSendSchedule` / `executeScheduleDelivery` / `_pushLineMessages` |
| 4 | 配信後の画像削除 | `deleteDeliveredImages` |

## 実運用フロー（数ヶ月に1回）

1. **生徒ごとの日程表JPGを作成**
   - ファイル名＝生徒氏名（例：`古内伶奈.jpg`）
   - **氏名にスペースを入れない**（照合はスペース無視だが、揃えておくと安心）
   - 拡張子は `.jpg` / `.jpeg`（大文字小文字は不問）
2. **`schedule-line-images` フォルダに置く**
   - フォルダは「リンクを知っている全員が閲覧可」に共有済みであること（配信URLが公開画像を返すため）
3. **管理画面を開く**（本番URL。`WEB_APP_URL` プロパティに記録済み）
4. **あいさつ文を入力**（テキストエリア。改行可）
5. **「配信対象プレビュー」で確認**
   - 配信対象◯名／送信予定◯通／警告◯件
   - 警告（対応表に氏名なし／在籍FALSE／送信先ID未登録）が無いか確認
6. **「🧪 テスト配信」で見え方確認**（先頭1名分がふくちさんのLINEにのみ届く）
7. **「🚀 本配信」**（全生徒＋保護者へ）
   - 事前確認ダイアログ → `confirm` → `prompt` に「配信」と入力、の多重確認
8. **配信成功後、「📁 配信済み画像を削除する」ボタンで画像をゴミ箱へ**
   - このボタンは本配信成功後にのみ表示される（うっかり削除防止）
   - ゴミ箱移動なので、必要なら復元可能

### 配信の通数ルール
- 各生徒の画像を、その生徒の **生徒本人ID＋保護者ID** の両方（空でないもの）へ送る
- 同一 LINE_USER_ID には全体を通して1回だけ（重複除去。登場順で最初の1回）
- 例：古内伶奈 → 本人ID(1通) + 保護者ID(1通) = 2通

## 環境情報

### リポジトリ
- URL：https://github.com/k-acdm/schedule-line
- Visibility：Public
- ブランチ：dev / main（dev で作業 → main にマージ）

### GASプロジェクト
- 名前：schedule-line
- スクリプトID：`1XahVQVkwZkGnKSffVKqV9EvkOiUgQ2dr-gPJPDDRL6sEWtBu895ml9gk`
- エディタURL：https://script.google.com/d/1XahVQVkwZkGnKSffVKqV9EvkOiUgQ2dr-gPJPDDRL6sEWtBu895ml9gk/edit
- 本番URL：スクリプトプロパティ `WEB_APP_URL` に記録（管理画面URL＝この末尾なしの `/exec`）
- clasp ログインアカウント：kasukabe.academy@gmail.com

### clasp 構成
- `.clasp.json` は `src/gas/` に配置（rootDir="" = src/gas がソースルート）
- clasp コマンドは `~/schedule-line/src/gas` で実行する
- ソースファイル：`コード.js`（サーバー）/ `admin.html`（管理画面）/ `appsscript.json`

### スプレッドシート（schedule-line-data）
- **Recipients シート**（照合対象）
  - A列：生徒氏名
  - B列：生徒LINE_USER_ID
  - C列：保護者LINE_USER_ID
  - D列：在籍フラグ（TRUE/FALSE。`TRUE`/`1`/`○`/`はい`/`在籍` を在籍とみなす）
  - 1行目はヘッダ、2行目以降がデータ

### スクリプトプロパティ一覧
| キー | 用途 |
|---|---|
| `SPREADSHEET_ID` | schedule-line-data のID（Recipientsシート） |
| `IMAGE_FOLDER_ID` | schedule-line-images フォルダのID |
| `LINE_MESSAGING_CHANNEL_ACCESS_TOKEN` | LINE送信用トークン（billing-lineと同じ値） |
| `ADMIN_LINE_USER_ID` | ふくちさんのLINE_USER_ID（テスト配信の宛先） |
| `WEB_APP_URL` | 本番Webアプリ URL（`?image=` 画像配信・管理画面） |
| `IMAGE_URL_METHOD` | 任意。`lh3`（既定）/ `thumbnail` を切替。未設定なら lh3 |

### oauthScopes（appsscript.json）
- `script.external_request`（LINE API 送信）
- `drive`（フォルダ読み取り＋配信後のJPGゴミ箱移動）
- `spreadsheets`（Recipients読み取り）

## 今回の重要な学び（次回困らないために）

1. **GASエディタは編集後F5リロードしないと旧コードを掴む**
   - `clasp push` した後、デプロイ前に必ずエディタをF5リロードして最新コードを確認する。
2. **`clasp push` 成功表示でもリモートHEADが旧版に戻ることがある**
   - 段階1で実際に発生。`clasp push` が「Pushed」と出てもリモートが旧版のままだった。
   - 疑わしいときは一時フォルダへ `clasp pull` して中身を検証する。
     （例：別ディレクトリに `.clasp.json` をコピー→`clasp pull`→grepで関数の有無を確認）
3. **スコープ変更後は再認証が必要**
   - 再認証ダイアログが出ない場合は、Google権限設定
     （https://myaccount.google.com/permissions）で schedule-line のアクセスを一旦削除
     → 関数を再実行すると再認証が強制される。
4. **画像URLの使い分け（重要）**
   - `?image=氏名`：GASが返すのは **HTMLプレビュー**（ブラウザ確認用）。**LINEには使えない**。
   - LINE配信用URL：`_buildImageUrls(fileId)` が返す **lh3 / thumbnail 直リンク**（本物のJPEGを返す）。
     - GASはContentServiceで画像バイナリを返せない・302リダイレクトもできないため、
       Google純正の公開画像エンドポイントを使う設計。
     - `IMAGE_URL_METHOD` プロパティで `lh3` ⇄ `thumbnail` を切替可能（再デプロイ不要）。
       LINEで画像が出ないときは `thumbnail` を試す。
   - 前提：画像フォルダが「リンクを知っている全員が閲覧可」で共有されていること。
5. **デプロイは「既存デプロイの編集 → 新バージョン」**
   - デプロイを管理 → 既存デプロイの鉛筆 → バージョン「新バージョン」→ デプロイ。
   - **新規デプロイは禁止**（URLが変わり `WEB_APP_URL` の再設定が必要になる）。
6. **Webアプリ設定「アクセスできるユーザー：全員」は必須**
   - 画像配信・LINE配信のため。変更しない。`appsscript.json` の
     `webapp.access: "ANYONE_ANONYMOUS"` も維持。

## 運用ルール（billing-line と共通）

### ⚠️ git add の注意
- `git add .` は必ず **`~/schedule-line` ルート**で実行する
- `src/gas` 配下で実行すると docs/HANDOFF.md が漏れる（billing-line で過去に事故あり）

### dev/main 切替
- **再開時**：`git checkout dev` → `git pull origin dev`
- **終了時**：`git pull origin dev` → `git checkout main` → `git merge dev` → `git push origin main` → `git checkout dev`

### 本番反映
1. `git pull origin dev`
2. `git checkout main` → `git merge dev` → `git push origin main`
3. `clasp push`（GAS変更時。`~/schedule-line/src/gas` で実行）
4. GASエディタをF5リロード →「デプロイを管理」→ 既存デプロイを編集 →「新バージョン」→ デプロイ
