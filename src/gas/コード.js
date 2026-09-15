/**
 * schedule-line
 * 春日部アカデミー 授業日程表 LINE配信ツール
 *
 * 段階1：画像配信の仕組み
 *
 * 【重要な設計上の事実】
 * GAS の Web アプリは画像バイナリを直接配信できない。
 *   - ContentService は image/jpeg などの MIME を設定できない（テキスト系のみ）
 *   - HtmlService は HTML しか返せない
 *   - doGet から 302 リダイレクト（Location ヘッダ）も出せない
 * そのため「LINE の originalContentUrl に GAS の ?image= URL を指定して
 * バイナリを流す」ことは原理的に不可能。
 *
 * 代わりに、Google 純正の画像配信エンドポイント（HTML を挟まず本物の JPEG を返す）を
 * 画像 URL として使う。GAS の役割は「氏名 → fileId → 公開画像URL の解決」。
 *   - lh3      : https://lh3.googleusercontent.com/d/{fileId}=w{width}
 *   - thumbnail: https://drive.google.com/thumbnail?id={fileId}&sz=w{width}
 * どちらを使うかはスクリプトプロパティ IMAGE_URL_METHOD で切替（既定 lh3）。
 *
 * 【前提】対象JPGを含むフォルダ（IMAGE_FOLDER_ID）は
 *        「リンクを知っている全員が閲覧可」に共有しておくこと。
 *        （fileId は推測不能なので実質的な保護＝標準的な LINE 画像配信の運用）
 */

/** 画像URL方式の既定値・パラメータ（スクリプトプロパティで上書き可） */
var IMAGE_URL_DEFAULT_METHOD = 'lh3'; // 'lh3' | 'thumbnail'
var IMAGE_ORIGINAL_WIDTH = 2048;      // originalContentUrl 用の最大幅（10MB以内に収める）
var IMAGE_PREVIEW_WIDTH = 240;        // previewImageUrl 用の幅（軽量プレビュー）
var IMAGE_EXTENSIONS = ['jpg', 'jpeg']; // 許容拡張子（大小文字は無視）

/**
 * Webアプリのエントリポイント
 * @param {Object} e - リクエストパラメータ
 * @return {HtmlOutput|TextOutput}
 */
function doGet(e) {
  e = e || {};
  var params = e.parameter || {};

  // 【段階1】画像配信（ブラウザ確認用プレビュー）※この分岐を壊さないこと
  if (params.image) {
    return _serveImage(params.image);
  }

  // 【段階2】管理画面
  return HtmlService.createHtmlOutputFromFile('admin')
    .setTitle('schedule-line 授業日程表配信')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * ?image=氏名 のハンドラ。
 * IMAGE_FOLDER_ID から氏名に一致する JPG を探し、
 * 解決した公開画像URLをブラウザ確認できるプレビューHTMLを返す。
 *
 * ※ これは「ブラウザで画像が見えるか」の確認用。
 *    LINE はサーバー側で URL をフェッチするため、最終的な LINE 表示可否は
 *    実際に配信して確認する必要がある（ただしこのURLが本物のJPEGを返せば
 *    LINE でもほぼ表示される）。
 *
 * @param {string} imageName - 氏名（拡張子なし想定）
 * @return {HtmlOutput|TextOutput}
 */
function _serveImage(imageName) {
  var file = _findImageFile(imageName);
  if (!file) {
    return ContentService
      .createTextOutput('404 Not Found: 「' + imageName + '」に一致する画像が見つかりません。')
      .setMimeType(ContentService.MimeType.TEXT);
  }

  var fileId = file.getId();
  var urls = _buildImageUrls(fileId);
  var method = _getImageMethod();

  var html =
    '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + _escapeHtml(imageName) + ' - schedule-line</title></head>' +
    '<body style="font-family:sans-serif;margin:0;padding:16px;background:#f7f7f7;">' +
    '<div style="max-width:900px;margin:0 auto;">' +
    '<p style="color:#555;font-size:13px;margin:0 0 8px;">' +
    'ファイル名: <b>' + _escapeHtml(file.getName()) + '</b> ／ 方式: <b>' + method + '</b></p>' +
    '<img src="' + urls.originalContentUrl + '" alt="' + _escapeHtml(imageName) + '" ' +
    'style="max-width:100%;height:auto;border:1px solid #ddd;background:#fff;display:block;">' +
    '<p style="color:#555;font-size:13px;margin:12px 0 4px;">' +
    'この画像が上に表示されていれば、URL は本物の JPEG を返しています（LINE でもほぼ表示可）。' +
    '<br>下のリンクを新しいタブで開き、Google Drive の HTML ページではなく' +
    '「画像そのもの」が表示されることを確認してください。</p>' +
    '<ul style="font-size:13px;line-height:1.8;">' +
    '<li>originalContentUrl: <a href="' + urls.originalContentUrl + '" target="_blank" rel="noopener">' +
    urls.originalContentUrl + '</a></li>' +
    '<li>previewImageUrl: <a href="' + urls.previewImageUrl + '" target="_blank" rel="noopener">' +
    urls.previewImageUrl + '</a></li>' +
    '</ul>' +
    '</div></body></html>';

  return HtmlOutput_(html);
}

/**
 * IMAGE_FOLDER_ID のフォルダから、氏名に一致する JPG ファイルを探す。
 *   - 照合はスペース無視（半角・全角）
 *   - 拡張子 .jpg / .jpeg（大小文字無視）を許容。imageName には拡張子を含まない想定
 * @param {string} imageName
 * @return {File|null}
 */
function _findImageFile(imageName) {
  var folderId = _getRequiredProp('IMAGE_FOLDER_ID');
  var target = _normalizeName(imageName);
  if (!target) return null;

  var folder = DriveApp.getFolderById(folderId);
  var files = folder.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    var parsed = _parseFileName(file.getName());
    if (!parsed) continue; // 許容拡張子でない
    if (_normalizeName(parsed.base) === target) {
      return file;
    }
  }
  return null;
}

/**
 * fileId から LINE 用の画像URL（原寸・プレビュー）を生成する。
 * send 側（段階2以降）はこの関数の戻り値をそのまま LINE image メッセージに使う。
 * @param {string} fileId
 * @return {{originalContentUrl: string, previewImageUrl: string}}
 */
function _buildImageUrls(fileId) {
  var method = _getImageMethod();
  return {
    originalContentUrl: _imageUrl(method, fileId, IMAGE_ORIGINAL_WIDTH),
    previewImageUrl: _imageUrl(method, fileId, IMAGE_PREVIEW_WIDTH)
  };
}

/**
 * 方式・fileId・幅から画像URLを組み立てる。
 * @param {string} method - 'lh3' | 'thumbnail'
 * @param {string} fileId
 * @param {number} width
 * @return {string}
 */
function _imageUrl(method, fileId, width) {
  if (method === 'thumbnail') {
    return 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w' + width;
  }
  // 既定: lh3（外部フェッチャに最も確実）
  return 'https://lh3.googleusercontent.com/d/' + fileId + '=w' + width;
}

/**
 * 使用する画像URL方式を取得（スクリプトプロパティ IMAGE_URL_METHOD で上書き可）。
 * @return {string} 'lh3' | 'thumbnail'
 */
function _getImageMethod() {
  var m = PropertiesService.getScriptProperties().getProperty('IMAGE_URL_METHOD');
  return (m === 'thumbnail') ? 'thumbnail' : IMAGE_URL_DEFAULT_METHOD;
}

/**
 * ファイル名を base / ext に分解。許容拡張子でなければ null。
 * @param {string} name
 * @return {{base: string, ext: string}|null}
 */
function _parseFileName(name) {
  var dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  var base = name.substring(0, dot);
  var ext = name.substring(dot + 1).toLowerCase();
  if (IMAGE_EXTENSIONS.indexOf(ext) === -1) return null;
  return { base: base, ext: ext };
}

/**
 * 氏名の正規化：前後・途中の空白（半角スペース・全角スペース U+3000・その他空白）を除去。
 * 「古内伶奈」と「古内　伶奈」を同一視するため。
 * @param {string} s
 * @return {string}
 */
function _normalizeName(s) {
  if (s == null) return '';
  return String(s).replace(/[\s　]/g, '');
}

// ============================================
// 【段階2】配信対象の照合
// ============================================

/**
 * 配信対象の一覧を返す（管理画面から google.script.run で呼ばれる）。
 *
 * IMAGE_FOLDER_ID 内の全JPGを走査し、ファイル名（拡張子除く）を生徒氏名として
 * Recipients シートと照合（氏名はスペース無視）。以下に分類する。
 *   a) JPGあり + マッチ + 在籍TRUE + ID1つ以上 → 配信対象（正常）      status='ok'
 *   b) JPGあり + マッチしない                    → 警告「対応表に氏名なし」 status='nomatch'
 *   c) JPGあり + マッチ + 在籍FALSE              → スキップ「在籍フラグFALSE」status='notenrolled'
 *   d) JPGあり + マッチ + 在籍TRUE + ID両方空     → 警告「送信先ID未登録」   status='noid'
 *
 * 送信予定通数：生徒本人ID・保護者ID（空でないもの）を重複除去したユニークID数。
 *   - 各生徒の sendCount は当該生徒内のユニーク数
 *   - summary.totalMessages は配信対象（正常）全体でのユニークID数（全体重複除去）
 *
 * ※ プライバシー配慮のため、LINE_USER_ID の実値は返さず「有無(boolean)」のみ返す。
 *
 * @return {{targets: Object[], warnings: Object[], summary: Object}}
 */
function getDeliveryTargets() {
  var folder = DriveApp.getFolderById(_getRequiredProp('IMAGE_FOLDER_ID'));
  var recipients = _getRecipientsMap();

  var targets = [];
  var warnings = [];
  var globalIds = {}; // 配信対象全体のユニークID集合

  var files = folder.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    var parsed = _parseFileName(file.getName());
    if (!parsed) continue; // JPG以外はスキップ

    var key = _normalizeName(parsed.base);
    var rec = recipients[key];

    var record = {
      name: rec ? rec.name : String(parsed.base).trim(),
      fileName: file.getName(),
      hasStudentId: false,
      hasGuardianId: false,
      enrolled: false,
      sendCount: 0,
      status: '',
      message: ''
    };

    // b) マッチしない
    if (!rec) {
      record.status = 'nomatch';
      record.message = '対応表に氏名なし';
      warnings.push(record);
      continue;
    }

    record.hasStudentId = rec.studentId !== '';
    record.hasGuardianId = rec.guardianId !== '';
    record.enrolled = rec.enrolled;

    // c) 在籍FALSE
    if (!rec.enrolled) {
      record.status = 'notenrolled';
      record.message = '在籍フラグFALSE';
      warnings.push(record);
      continue;
    }

    // d) ID両方空
    if (rec.studentId === '' && rec.guardianId === '') {
      record.status = 'noid';
      record.message = '送信先ID未登録';
      warnings.push(record);
      continue;
    }

    // a) 配信対象（正常）
    var ids = {};
    if (rec.studentId !== '') { ids[rec.studentId] = true; globalIds[rec.studentId] = true; }
    if (rec.guardianId !== '') { ids[rec.guardianId] = true; globalIds[rec.guardianId] = true; }
    record.sendCount = Object.keys(ids).length;
    record.status = 'ok';
    record.message = '配信対象';
    targets.push(record);
  }

  targets.sort(_byName);
  warnings.sort(_byName);

  return {
    targets: targets,
    warnings: warnings,
    summary: {
      deliverCount: targets.length,
      totalMessages: Object.keys(globalIds).length,
      warningCount: warnings.length
    }
  };
}

/**
 * Recipients シートを読み、正規化氏名 → レコードの map を返す。
 *   A:生徒氏名 B:生徒LINE_USER_ID C:保護者LINE_USER_ID D:在籍フラグ
 * @return {Object.<string, {name:string, studentId:string, guardianId:string, enrolled:boolean}>}
 */
function _getRecipientsMap() {
  var ss = SpreadsheetApp.openById(_getRequiredProp('SPREADSHEET_ID'));
  var sheet = ss.getSheetByName('Recipients');
  if (!sheet) {
    throw new Error('スプレッドシートに「Recipients」シートが見つかりません。');
  }
  var map = {};
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return map; // ヘッダのみ／空

  var values = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
  for (var i = 0; i < values.length; i++) {
    var name = values[i][0];
    if (name === '' || name == null) continue;
    map[_normalizeName(name)] = {
      name: String(name).trim(),
      studentId: _trim(values[i][1]),
      guardianId: _trim(values[i][2]),
      enrolled: _isEnrolled(values[i][3])
    };
  }
  return map;
}

/**
 * 在籍フラグの解釈。boolean true / "TRUE" / "1" / "○" / "はい" / "在籍" を在籍とみなす。
 * @param {*} v
 * @return {boolean}
 */
function _isEnrolled(v) {
  if (v === true) return true;
  if (v === false || v == null || v === '') return false;
  return /^(true|1|yes|y|○|はい|在籍)$/i.test(String(v).trim());
}

/**
 * セル値を文字列トリム（null安全）。
 * @param {*} v
 * @return {string}
 */
function _trim(v) {
  return String(v == null ? '' : v).trim();
}

/**
 * name 昇順ソート用コンパレータ。
 */
function _byName(a, b) {
  return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
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

/**
 * 必須スクリプトプロパティ取得（未設定なら例外）。
 * @param {string} key
 * @return {string}
 */
function _getRequiredProp(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) {
    throw new Error('スクリプトプロパティ「' + key + '」が設定されていません。');
  }
  return v;
}

/**
 * HTML エスケープ。
 * @param {string} s
 * @return {string}
 */
function _escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
