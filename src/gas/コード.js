/**
 * schedule-line
 * 春日部アカデミー 授業日程表 LINE配信ツール
 *
 * ※ 雛形。中身は次段階で実装。
 */

/**
 * Webアプリのエントリポイント（雛形）
 * @param {Object} e - リクエストパラメータ
 * @return {HtmlOutput|TextOutput}
 */
function doGet(e) {
  return HtmlOutput_(
    '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>schedule-line</title></head>' +
    '<body style="font-family:sans-serif;padding:24px;">' +
    '<h1>schedule-line</h1>' +
    '<p>春日部アカデミー 授業日程表 LINE配信ツール（セットアップ完了・実装はこれから）</p>' +
    '</body></html>'
  );
}

/**
 * HtmlOutput 生成ヘルパー
 * @param {string} html
 * @return {HtmlOutput}
 */
function HtmlOutput_(html) {
  return HtmlService.createHtmlOutput(html)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
