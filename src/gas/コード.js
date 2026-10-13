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

/** 配信先モード（管理画面のラジオボタン値） */
var DELIVERY_MODES = {
  guardian: '保護者のみ',
  student: '生徒のみ',
  both: '保護者＋生徒 両方'
};
var DELIVERY_MODE_DEFAULT = 'both';

/** LINE push 1回あたりの最大メッセージ数（API仕様） */
var LINE_MAX_MESSAGES_PER_PUSH = 5;

/** 共通画像の判定：ファイル名がアンダースコアで始まるJPG（例：_common1.jpg） */
var COMMON_IMAGE_PREFIX = '_';

/**
 * 配信対象の一覧を返す（管理画面から google.script.run で呼ばれる）。
 * プライバシー配慮のため、LINE_USER_ID の実値と fileId は返さず「有無(boolean)」のみ返す。
 * @param {string=} mode - 'guardian' | 'student' | 'both'（省略時 both）
 * @return {{targets: Object[], warnings: Object[], commons: Object[], summary: Object}}
 */
function getDeliveryTargets(mode) {
  var d = _computeDelivery(mode);
  return {
    targets: d.targets.map(_sanitizeRecord),
    warnings: d.warnings.map(_sanitizeRecord),
    commons: d.commons.map(function(c) { return { fileName: c.fileName }; }),
    summary: d.summary
  };
}

/**
 * 配信先モードを検証・正規化する。省略時は既定（both）。
 * @param {string=} mode
 * @return {string}
 */
function _normalizeMode(mode) {
  if (mode == null || mode === '') return DELIVERY_MODE_DEFAULT;
  if (!DELIVERY_MODES.hasOwnProperty(mode)) {
    throw new Error('配信先の指定が不正です: ' + mode);
  }
  return mode;
}

/**
 * 配信計算の中核（サーバー内部用。実IDと fileId を含む）。
 *
 * IMAGE_FOLDER_ID 内の全JPGを走査する。
 *   - 「_」で始まるJPG → 共通画像（個別照合の対象外。ファイル名の自然順で並べる）
 *   - それ以外のJPG    → ファイル名（拡張子除く）を生徒氏名として共有シート（Students）と照合
 *
 * 個別画像の分類：
 *   a) マッチ + 在籍TRUE + 家族の配信有効 + 選択した配信先にID1つ以上 → 配信対象  status='ok'
 *   b) マッチしない                          → 警告「対応表に氏名なし」          status='nomatch'
 *   e) 同名の生徒がStudentsに複数            → 警告「対応表に同名の生徒が複数」  status='dupname'
 *   c) 在籍FALSE                             → スキップ「在籍フラグFALSE」        status='notenrolled'
 *   f) 家族の配信有効フラグFALSE             → スキップ（家族全員）              status='familydisabled'
 *   d) 選択した配信先のIDがすべて空          → 警告「送信先ID未登録」            status='noid'
 *
 * 配信先モード：
 *   guardian … 保護者IDのみ / student … 生徒IDのみ / both … 両方
 *   空欄IDはその側だけスキップ（例：両方モードで生徒ID空 → 保護者にのみ届く）。
 *   スキップした側は studentSkipped / guardianSkipped でプレビューに表示する。
 *
 * 送信単位（sends）：
 *   同一 LINE_USER_ID には1回の配信にまとめる（重複除去）。
 *   兄弟で保護者IDが同じ場合は、その保護者宛の1回の配信に兄弟全員の個別画像を
 *   兄弟順位の順で含める（あいさつ文・共通画像は1回だけ）。
 *   summary.totalMessages = 送信先（ユニークID）数
 *   summary.pushCount     = LINE push の総回数（5件超は分割されるため ≧ totalMessages）
 *
 * @param {string=} mode
 * @return {{targets: Object[], warnings: Object[], commons: Object[], sends: Object[], mode: string, summary: Object}}
 */
function _computeDelivery(mode) {
  mode = _normalizeMode(mode);
  var wantStudent = (mode !== 'guardian');
  var wantGuardian = (mode !== 'student');

  var folder = DriveApp.getFolderById(_getRequiredProp('IMAGE_FOLDER_ID'));
  var recipients = _getRecipientsMap();

  var targets = [];
  var warnings = [];
  var commons = [];
  var jpgCount = 0;

  var files = folder.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    var parsed = _parseFileName(file.getName());
    if (!parsed) continue; // JPG以外はスキップ
    jpgCount++;

    // 共通画像（個別照合の対象外）
    if (_isCommonImageName(file.getName())) {
      commons.push({ fileName: file.getName(), fileId: file.getId() });
      continue;
    }

    var key = _normalizeName(parsed.base);
    var rec = recipients[key];

    var record = {
      name: rec ? rec.name : String(parsed.base).trim(),
      fileName: file.getName(),
      fileId: file.getId(),
      studentId: '',
      guardianId: '',
      hasStudentId: false,
      hasGuardianId: false,
      enrolled: false,
      familyFound: false,
      siblingOrder: 0,
      sendStudent: false,
      sendGuardian: false,
      studentSkipped: false,
      guardianSkipped: false,
      bundledWith: [],
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

    record.studentId = rec.studentId;
    record.guardianId = rec.guardianId;
    record.hasStudentId = rec.studentId !== '';
    record.hasGuardianId = rec.guardianId !== '';
    record.enrolled = rec.enrolled;
    record.familyFound = rec.familyFound;
    record.siblingOrder = rec.siblingOrder;

    // e) 同名の生徒が複数（どちらに送るべきか判断できないため配信しない）
    if (rec.duplicate) {
      record.status = 'dupname';
      record.message = '対応表に同名の生徒が複数';
      warnings.push(record);
      continue;
    }

    // c) 在籍FALSE
    if (!rec.enrolled) {
      record.status = 'notenrolled';
      record.message = '在籍フラグFALSE';
      warnings.push(record);
      continue;
    }

    // f) 家族の配信有効フラグFALSE（家族全員スキップ）
    if (rec.familyFound && !rec.familyEnabled) {
      record.status = 'familydisabled';
      record.message = '配信有効フラグFALSE（家族）';
      warnings.push(record);
      continue;
    }

    // 選択した配信先ごとの送信可否（空欄IDはその側だけスキップ）
    record.sendStudent = wantStudent && record.hasStudentId;
    record.sendGuardian = wantGuardian && record.hasGuardianId;
    record.studentSkipped = wantStudent && !record.hasStudentId;
    record.guardianSkipped = wantGuardian && !record.hasGuardianId;

    // d) 選択した配信先のIDがすべて空
    if (!record.sendStudent && !record.sendGuardian) {
      record.status = 'noid';
      record.message = '送信先ID未登録';
      warnings.push(record);
      continue;
    }

    // a) 配信対象（正常）
    // ※ sendCount（行ごとの送信通数）は送信単位の組み立て後に算出する。
    //    兄弟で共有する保護者宛てを各行で二重計上しないよう、
    //    各ユニークID（＝送信単位）を1つの行にのみ計上する（下の _buildSendUnits 後の処理）。
    record.status = 'ok';
    record.message = '配信対象';
    targets.push(record);
  }

  targets.sort(_byName);
  warnings.sort(_byName);
  commons.sort(function(a, b) { return _naturalCompare(a.fileName, b.fileName); });

  var sends = _buildSendUnits(targets, commons);

  // 兄弟まとめ表示用：同じ送信先に含まれる他の生徒名
  sends.forEach(function(s) {
    if (s.items.length < 2) return;
    s.items.forEach(function(item) {
      item.record.bundledWith = item.record.bundledWith.concat(
        s.items.filter(function(o) { return o !== item; }).map(function(o) { return o.record.name; })
      ).filter(function(n, i, arr) { return arr.indexOf(n) === i; });
    });
  });

  // 行ごとの送信通数（sendCount）：各送信先（ユニークID＝1送信単位）を、
  // その単位の先頭の行（items は兄弟順位→氏名でソート済み）にのみ1通計上する。
  // これにより Σ(行の送信通数) === sends.length === summary.totalMessages が常に成立し、
  // 兄弟で共有する保護者宛てが兄弟の各行に二重計上されることを防ぐ。
  // ※ 実際の配信（sends の中身・順序・分割）には影響しない表示専用の集計。
  sends.forEach(function(s) {
    if (s.items.length) s.items[0].record.sendCount += 1;
  });

  var pushCount = 0;
  sends.forEach(function(s) { pushCount += s.chunkCount; });

  return {
    targets: targets,
    warnings: warnings,
    commons: commons,
    sends: sends,
    mode: mode,
    summary: {
      mode: mode,
      modeLabel: DELIVERY_MODES[mode],
      deliverCount: targets.length,
      totalMessages: sends.length,
      pushCount: pushCount,
      commonCount: commons.length,
      warningCount: warnings.length,
      imageCount: jpgCount // フォルダ内JPG総数（共通画像含む。削除確認の枚数表示用）
    }
  };
}

/**
 * 配信対象から送信単位（ユニークな LINE_USER_ID ごと）を組み立てる。
 * 同一IDに複数の生徒が紐づく場合（兄弟の保護者など）は1単位にまとめ、
 * 個別画像は兄弟順位 → 氏名の順に並べる。
 * @param {Object[]} targets - 氏名順にソート済みの配信対象
 * @param {Object[]} commons - 自然順にソート済みの共通画像
 * @return {Object[]} { userId, items:[{record}], fileIds:string[], chunkCount:number }
 */
function _buildSendUnits(targets, commons) {
  var byId = {};
  var units = [];
  targets.forEach(function(t) {
    var ids = [];
    if (t.sendStudent) ids.push(t.studentId);
    if (t.sendGuardian && ids.indexOf(t.guardianId) === -1) ids.push(t.guardianId);
    ids.forEach(function(id) {
      var u = byId[id];
      if (!u) {
        u = { userId: id, items: [] };
        byId[id] = u;
        units.push(u);
      }
      if (!u.items.some(function(it) { return it.record.fileId === t.fileId; })) {
        u.items.push({ record: t });
      }
    });
  });

  var commonIds = commons.map(function(c) { return c.fileId; });
  units.forEach(function(u) {
    u.items.sort(function(a, b) {
      var d = a.record.siblingOrder - b.record.siblingOrder;
      return d !== 0 ? d : _byName(a.record, b.record);
    });
    u.fileIds = u.items.map(function(it) { return it.record.fileId; });
    u.commonIds = commonIds;
    // あいさつ文1 + 個別 + 共通 を5件ずつに分割した回数
    u.chunkCount = Math.ceil((1 + u.fileIds.length + commonIds.length) / LINE_MAX_MESSAGES_PER_PUSH);
  });
  return units;
}

/**
 * 共通画像のファイル名か（アンダースコア始まり）。
 * @param {string} fileName
 * @return {boolean}
 */
function _isCommonImageName(fileName) {
  return String(fileName).indexOf(COMMON_IMAGE_PREFIX) === 0;
}

/**
 * 自然順比較（_common2 < _common10）。
 * @param {string} a
 * @param {string} b
 * @return {number}
 */
function _naturalCompare(a, b) {
  var ra = String(a).match(/(\d+|\D+)/g) || [];
  var rb = String(b).match(/(\d+|\D+)/g) || [];
  for (var i = 0; i < Math.min(ra.length, rb.length); i++) {
    var x = ra[i], y = rb[i];
    if (x === y) continue;
    var nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    return x < y ? -1 : 1;
  }
  return ra.length - rb.length;
}

/**
 * 画面返却用に機微情報（LINE_USER_ID実値・fileId）を落としたコピーを返す。
 * @param {Object} r
 * @return {Object}
 */
function _sanitizeRecord(r) {
  return {
    name: r.name,
    fileName: r.fileName,
    hasStudentId: r.hasStudentId,
    hasGuardianId: r.hasGuardianId,
    enrolled: r.enrolled,
    familyFound: r.familyFound,
    sendStudent: r.sendStudent,
    sendGuardian: r.sendGuardian,
    studentSkipped: r.studentSkipped,
    guardianSkipped: r.guardianSkipped,
    bundledWith: r.bundledWith,
    sendCount: r.sendCount,
    status: r.status,
    message: r.message
  };
}

/**
 * 共有スプレッドシート line-recipients（RECIPIENTS_SPREADSHEET_ID）を読み、
 * 正規化氏名 → レコードの map を返す。列はヘッダ名で特定する（列順の変更に強い）。
 *   Families：家族ID | 宛名 | 配信区分 | 保護者LINE_USER_ID | 登録日 | 配信有効フラグ
 *   Students：生徒ID | 家族ID | 学年 | 生徒氏名 | 兄弟順位 | 在籍フラグ | 生徒LINE_USER_ID
 * Students を家族IDで Families と結合し、生徒ごとの保護者LINE_USER_ID を得る。
 * ※ 配信区分は参照しない（配信先は管理画面で毎回選択する）。
 * ※ 旧 SPREADSHEET_ID（schedule-line-data / Recipients シート）は参照しない。
 * @return {Object.<string, {name:string, studentId:string, guardianId:string, enrolled:boolean,
 *          familyFound:boolean, familyEnabled:boolean, siblingOrder:number, duplicate:boolean}>}
 */
function _getRecipientsMap() {
  var ss = SpreadsheetApp.openById(_getRequiredProp('RECIPIENTS_SPREADSHEET_ID'));

  // Families：家族ID → { guardianId, enabled }
  var families = {};
  var fam = _readSheetByHeader(ss, 'Families', ['家族ID', '保護者LINE_USER_ID', '配信有効フラグ']);
  fam.rows.forEach(function(row) {
    var fid = _trim(row[fam.col['家族ID']]);
    if (!fid) return;
    families[fid] = {
      guardianId: _trim(row[fam.col['保護者LINE_USER_ID']]),
      enabled: _isEnrolled(row[fam.col['配信有効フラグ']])
    };
  });

  // Students：正規化氏名 → レコード
  var map = {};
  var st = _readSheetByHeader(ss, 'Students',
    ['生徒ID', '家族ID', '生徒氏名', '兄弟順位', '在籍フラグ', '生徒LINE_USER_ID']);
  st.rows.forEach(function(row) {
    var name = row[st.col['生徒氏名']];
    if (name === '' || name == null) return;
    var key = _normalizeName(name);
    if (!key) return;
    if (map[key]) { map[key].duplicate = true; return; }
    var family = families[_trim(row[st.col['家族ID']])];
    var order = Number(row[st.col['兄弟順位']]);
    map[key] = {
      name: String(name).trim(),
      studentId: _trim(row[st.col['生徒LINE_USER_ID']]),
      guardianId: family ? family.guardianId : '',
      enrolled: _isEnrolled(row[st.col['在籍フラグ']]),
      familyFound: !!family,
      familyEnabled: family ? family.enabled : false,
      siblingOrder: (row[st.col['兄弟順位']] === '' || isNaN(order)) ? 999 : order,
      duplicate: false
    };
  });
  return map;
}

/**
 * シートを1行目ヘッダで読み、必須列の列番号と2行目以降のデータを返す。
 * ヘッダ照合は空白を無視する。
 * @param {Spreadsheet} ss
 * @param {string} sheetName
 * @param {string[]} required - 必須ヘッダ名
 * @return {{col: Object.<string, number>, rows: Array[]}}
 */
function _readSheetByHeader(ss, sheetName, required) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('共有スプレッドシートに「' + sheetName + '」シートが見つかりません。');
  }
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) {
    throw new Error('「' + sheetName + '」シートにヘッダ行がありません。');
  }
  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var header = values[0].map(function(h) { return _normalizeName(h); });
  var col = {};
  var missing = [];
  required.forEach(function(name) {
    var idx = header.indexOf(_normalizeName(name));
    if (idx === -1) missing.push(name); else col[name] = idx;
  });
  if (missing.length) {
    throw new Error('「' + sheetName + '」シートに列が見つかりません: ' + missing.join(', '));
  }
  return { col: col, rows: values.slice(1) };
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

// ============================================
// 【段階3】LINE配信（テスト配信・本配信）
// ============================================

/**
 * テスト配信：選択した配信先モードで組み立てた送信リストの「先頭1件分」を、
 * ADMIN_LINE_USER_ID（ふくちさん）宛にそのまま送る（兄弟まとめ・5件超の分割も本番と同じ）。
 * 全員には送らない。あいさつ文の冒頭に「🧪 テスト配信」を付与する。
 *
 * @param {string} greetingText - あいさつ文
 * @param {string=} mode - 'guardian' | 'student' | 'both'（省略時 both）
 * @return {{success:boolean, names?:string[], fileNames?:string[], commonCount?:number,
 *           pushCount?:number, modeLabel?:string, error?:string}}
 */
function testSendSchedule(greetingText, mode) {
  var greeting = _trim(greetingText);
  if (!greeting) {
    return { success: false, error: 'あいさつ文を入力してください。' };
  }

  var adminId = _getRequiredProp('ADMIN_LINE_USER_ID');

  var d = _computeDelivery(mode);
  if (d.sends.length === 0) {
    return { success: false, error: '配信対象がいません（テスト送信できません）。' };
  }

  var first = d.sends[0];
  var testGreeting = '🧪 テスト配信\n' + greeting;
  var chunks = _buildScheduleMessageChunks(testGreeting, first.fileIds, first.commonIds);
  var res = _pushLineMessageChunks(adminId, chunks);

  return {
    success: res.success,
    names: first.items.map(function(it) { return it.record.name; }),
    fileNames: first.items.map(function(it) { return it.record.fileName; }),
    commonCount: first.commonIds.length,
    pushCount: chunks.length,
    modeLabel: d.summary.modeLabel,
    error: res.success ? undefined : res.error
  };
}

/**
 * 本配信：選択した配信先モードで、送信先（ユニークな LINE_USER_ID）ごとに
 * 「あいさつ文 → 個別画像（兄弟がいれば兄弟順位順）→ 共通画像（ファイル名の自然順）」を送る。
 * 5メッセージを超える場合は複数回の push に分割する（あいさつ文は最初の push のみ）。
 *
 * 【重複除去】1つの LINE_USER_ID には1回の配信だけ（_buildSendUnits でまとめ済み）。
 *   - 送信通数 = 送信先数（getDeliveryTargets の totalMessages と一致）
 *
 * @param {string} greetingText - あいさつ文（必須）
 * @param {string=} mode - 'guardian' | 'student' | 'both'（省略時 both）
 * @return {{total:number, success:number, failed:number, errors:string[], targetCount:number,
 *           pushTotal:number, imageCount:number, commonCount:number, modeLabel:string}}
 */
function executeScheduleDelivery(greetingText, mode) {
  var greeting = _trim(greetingText);
  if (!greeting) {
    throw new Error('あいさつ文を入力してください（本配信には必須です）。');
  }

  var d = _computeDelivery(mode);
  if (d.sends.length === 0) {
    throw new Error('配信対象がいません。本配信を中止しました。');
  }

  var sends = d.sends;
  var total = sends.length;
  var success = 0;
  var failed = 0;
  var errors = [];
  var pushTotal = 0;

  for (var i = 0; i < sends.length; i++) {
    var s = sends[i];
    var label = s.items.map(function(it) { return it.record.name; }).join('・');
    var chunks = _buildScheduleMessageChunks(greeting, s.fileIds, s.commonIds);
    var res = _pushLineMessageChunks(s.userId, chunks);
    pushTotal += res.pushed;
    if (res.success) {
      success++;
    } else {
      failed++;
      errors.push(label + ': ' + (res.error || '不明なエラー'));
    }
    // レート制限緩和（最後の1件の後はスリープ不要）
    if (i < sends.length - 1) {
      Utilities.sleep(500);
    }
  }

  return {
    total: total,
    success: success,
    failed: failed,
    errors: errors,
    targetCount: d.targets.length,
    pushTotal: pushTotal,
    imageCount: d.summary.imageCount, // フォルダ内JPG総数（共通画像含む。削除確認の枚数表示用）
    commonCount: d.summary.commonCount,
    modeLabel: d.summary.modeLabel
  };
}

/**
 * 【段階4】配信済み画像の削除。
 * IMAGE_FOLDER_ID フォルダ内の JPG のみをゴミ箱へ移動する（復元可能）。
 * 共通画像（_common1.jpg 等）もJPGなので、個別画像と一緒に削除対象に含まれる。
 *
 * 安全策：
 *   - JPG（.jpg/.jpeg 等）以外のファイルは絶対に削除しない
 *   - フォルダそのものは削除しない（中身のJPGのみ）
 *   - ゴミ箱移動（setTrashed）なので完全削除ではない
 *
 * ※ 本配信成功後にのみ呼ばれる想定（UI側でボタン表示を制御）。
 *
 * @return {{deleted:number, failed:number, errors:string[]}}
 */
function deleteDeliveredImages() {
  var log = []; // 戻り値にも含める診断ログ（画面でも確認できるように）
  function L(msg) { Logger.log(msg); log.push(msg); }

  var folderId = _getRequiredProp('IMAGE_FOLDER_ID');
  L('▼ deleteDeliveredImages 開始');
  L('IMAGE_FOLDER_ID = ' + folderId);

  var folder;
  try {
    folder = DriveApp.getFolderById(folderId);
  } catch (e) {
    L('!! フォルダ取得に失敗: ' + _errStr(e));
    return { deleted: 0, failed: 0, errors: ['フォルダ取得失敗: ' + _errStr(e)], log: log };
  }
  L('フォルダ名 = ' + _safe(function() { return folder.getName(); }));

  // フォルダ内の全ファイルを列挙し、JPG判定の結果を1件ずつログ
  var jpgFiles = [];
  var allCount = 0;
  var files = folder.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    allCount++;
    var name = _safe(function() { return f.getName(); });
    var mime = _safe(function() { return f.getMimeType(); });
    var isJpg = !!_parseFileName(name);
    L('  [' + allCount + '] name="' + name + '" mime=' + mime + ' → JPG判定=' + isJpg);
    if (isJpg) jpgFiles.push(f);
  }
  L('フォルダ内 全ファイル数 = ' + allCount + ' / JPG対象数 = ' + jpgFiles.length);

  var deleted = 0;
  var failed = 0;
  var errors = [];
  for (var i = 0; i < jpgFiles.length; i++) {
    var jf = jpgFiles[i];
    var jname = _safe(function() { return jf.getName(); });
    var jid = _safe(function() { return jf.getId(); });
    var jowner = _safe(function() { var o = jf.getOwner(); return o ? o.getEmail() : '(取得不可)'; });
    L('  → 削除試行: name="' + jname + '" id=' + jid + ' owner=' + jowner);
    try {
      jf.setTrashed(true);
      deleted++;
      L('    ✓ setTrashed(true) 成功');
    } catch (e) {
      failed++;
      var msg = _errStr(e);
      errors.push(jname + ' (id=' + jid + '): ' + msg);
      L('    ✗ setTrashed 失敗: ' + msg);
    }
  }

  L('▲ 完了: deleted=' + deleted + ' failed=' + failed + ' allFiles=' + allCount + ' jpg=' + jpgFiles.length);
  return {
    deleted: deleted,
    failed: failed,
    errors: errors,
    allCount: allCount,
    jpgCount: jpgFiles.length,
    log: log
  };
}

/**
 * 例外を可能な限り詳細な文字列にする（message / name / stack）。
 * @param {*} e
 * @return {string}
 */
function _errStr(e) {
  if (e == null) return '(null)';
  var parts = [];
  if (e.name) parts.push(String(e.name));
  if (e.message) parts.push(String(e.message)); else parts.push(String(e));
  if (e.stack) parts.push('stack: ' + String(e.stack).split('\n').slice(0, 3).join(' | '));
  return parts.join(' / ');
}

/**
 * getter 等を安全に呼ぶ（例外時は理由を文字列で返す）。
 * @param {function} fn
 * @return {string}
 */
function _safe(fn) {
  try {
    var v = fn();
    return (v == null) ? '(null)' : String(v);
  } catch (e) {
    return '(取得エラー: ' + _errStr(e) + ')';
  }
}

/**
 * 「あいさつ文 → 個別画像 → 共通画像」のメッセージ列を組み立て、
 * LINE push 1回あたりの上限（5件）ごとに分割して返す。
 * あいさつ文は先頭なので、必ず最初の push にのみ含まれる。
 * 画像URLは段階1で確定した公開画像URL（lh3/thumbnail 直リンク）を使用する。
 * ※ ?image= はHTMLプレビューを返すためLINEには使えない。fileId から直URLを生成する。
 *
 * @param {string} greeting - 本文（テスト時は冒頭に🧪付与済み）
 * @param {string[]} fileIds - 個別画像の fileId（兄弟順位順）
 * @param {string[]} commonIds - 共通画像の fileId（ファイル名の自然順）
 * @return {Object[][]} LINE messages の配列（push 単位）
 */
function _buildScheduleMessageChunks(greeting, fileIds, commonIds) {
  var messages = [{ type: 'text', text: greeting }];
  fileIds.concat(commonIds || []).forEach(function(fileId) {
    var urls = _buildImageUrls(fileId);
    messages.push({
      type: 'image',
      originalContentUrl: urls.originalContentUrl,
      previewImageUrl: urls.previewImageUrl
    });
  });
  var chunks = [];
  for (var i = 0; i < messages.length; i += LINE_MAX_MESSAGES_PER_PUSH) {
    chunks.push(messages.slice(i, i + LINE_MAX_MESSAGES_PER_PUSH));
  }
  return chunks;
}

/**
 * 分割済みメッセージを1宛先へ順に push する。
 * 途中で失敗した場合は、順序が崩れないよう残りの push を中止する。
 * @param {string} userId
 * @param {Object[][]} chunks
 * @return {{success:boolean, pushed:number, error?:string}}
 */
function _pushLineMessageChunks(userId, chunks) {
  for (var i = 0; i < chunks.length; i++) {
    if (i > 0) Utilities.sleep(300);
    var res = _pushLineMessages(userId, chunks[i]);
    if (!res.success) {
      var where = chunks.length > 1 ? '（' + (i + 1) + '/' + chunks.length + '回目のpushで失敗。以降は未送信）' : '';
      return { success: false, pushed: i, error: (res.error || '不明なエラー') + where };
    }
  }
  return { success: true, pushed: chunks.length };
}

/**
 * LINE Messaging API の push で複数メッセージを1回のリクエストで送る。
 * @param {string} userId - 宛先 LINE_USER_ID
 * @param {Object[]} messages - LINE messages 配列（最大5件／API仕様）
 * @return {{success:boolean, status?:number, error?:string}}
 */
function _pushLineMessages(userId, messages) {
  var token = _getLineMessagingAccessToken();
  if (!token) {
    return { success: false, error: 'LINE_MESSAGING_CHANNEL_ACCESS_TOKEN 未設定' };
  }
  try {
    var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + token },
      payload: JSON.stringify({ to: userId, messages: messages }),
      muteHttpExceptions: true
    });
    var status = res.getResponseCode();
    if (status === 200) {
      return { success: true, status: status };
    }
    return {
      success: false,
      status: status,
      error: 'HTTP ' + status + ': ' + res.getContentText().substring(0, 200)
    };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

/**
 * LINE Messaging API のチャネルアクセストークンを取得。
 * @return {string}
 */
function _getLineMessagingAccessToken() {
  try {
    return String(
      PropertiesService.getScriptProperties()
        .getProperty('LINE_MESSAGING_CHANNEL_ACCESS_TOKEN') || ''
    ).trim();
  } catch (e) {
    return '';
  }
}
