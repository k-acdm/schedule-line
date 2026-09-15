# 引き継ぎメモ（schedule-line）

## 最終更新
2026-09-15 ★ 初期セットアップ完了 ★

## プロジェクト概要
- 春日部アカデミーの「授業日程表」をLINE配信するツール
- Google Apps Script（GAS）+ clasp 運用
- 姉妹プロジェクト `billing-line`（月次引き落とし通知のLINE配信）と同じ構成・運用ルール
- GASソース：`src/gas/`（コード.js、appsscript.json ほか。HTML等は今後追加）

## 現状
- ✅ フォルダ構成作成（src/gas/、docs/）
- ✅ git init・リモート設定（https://github.com/k-acdm/schedule-line.git）
- ✅ clasp create で standalone GASプロジェクト作成
- ✅ 雛形ファイル作成（doGet のみ）
- 🔜 実装（授業日程表の取込・プレビュー・LINE配信）は次段階

## 環境情報

### リポジトリ
- URL：https://github.com/k-acdm/schedule-line
- Visibility：Public
- ブランチ：dev / main（dev で作業 → main にマージ）

### GASプロジェクト
- 名前：schedule-line
- スクリプトID：`1XahVQVkwZkGnKSffVKqV9EvkOiUgQ2dr-gPJPDDRL6sEWtBu895ml9gk`
- エディタURL：https://script.google.com/d/1XahVQVkwZkGnKSffVKqV9EvkOiUgQ2dr-gPJPDDRL6sEWtBu895ml9gk/edit
- 本番URL：（初回デプロイ後に記入）
- clasp ログインアカウント：kasukabe.academy@gmail.com

### clasp 構成
- `.clasp.json` は `src/gas/` に配置（rootDir="" = src/gas がソースルート）
- clasp コマンドは `~/schedule-line/src/gas` で実行する

### git 設定
- user.name：k-acdm
- user.email：k-academy@mbr.nifty.com

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
4. GASエディタで「デプロイを管理」→ 既存デプロイを編集 →「新バージョン」→ デプロイ

### ⚠️ GAS Webアプリ設定（恒久ルール）
- Webアプリ設定「アクセスできるユーザー：**全員**」は必須
  （LINE Webhook 受信・画像/日程表の配信のため）
- 変更してはいけない
- `appsscript.json` 側でも `webapp.access: "ANYONE_ANONYMOUS"` を維持

## 今後の実装メモ
- oauthScopes は実装に応じて追加予定（画像配信・LINE送信・Drive・Spreadsheet 等）
  - 現状は最小限（`script.external_request` のみ）
- 実装は billing-line（`~/billing-line/src/gas/`）を参考にしてよい
