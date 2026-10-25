// ============================================================
//  HR 系統 · 打卡雲端中繼（Google Apps Script Web App）
// ------------------------------------------------------------
//  部署方式：
//   1. 開一個新的 Google 試算表（這會是打卡雲端資料庫，含 12 個月分頁）。
//   2. 上方「擴充功能」→「Apps Script」→ 把本檔全部內容貼進 Code.gs，
//      並「新增」一個檔案命名 PunchPage.html（內容來自 PunchPage.html），
//      兩個檔案都要在同一個 Apps Script 專案裡。
//   3. 部署 → 新增部署 → 選「網頁應用程式」：
//        執行身分 = 我（me）
//        存取權   = 任何人（包括匿名）  ← 才能讓店內手機跨域打卡
//   4. 部署完成會拿到一個 .../exec 網址：
//        - 員工手機「開這個網址」＝打卡頁（https，GPS 直接可用）。
//        - 主系統「填這個網址」＝從雲端讀取打卡資料。
//
//  結構：
//    試算表分頁＝「員工」(編號/姓名/PIN/狀態/離職日) ＋ 「1月」..「12月」(各 14 欄打卡紀錄)
//                ＋ 「排班-YYYY-MM」(各 35 欄月曆寬格式；一月一分頁，有排才建)
//                ＋ 「請假」(單一分頁 13 欄；序號為唯一 key)
//                ＋ 「加班」(單一分頁 16 欄，與請假同構；序號為唯一 key)
//                ＋ 「補休」(單一分頁 13 欄；階段三 2026-09-26，序號為唯一 key)。
//    打卡依「時間戳」的月份自動落入對應分頁；讀取時 12 個分頁全部合併。
//    排班以「整月覆蓋」寫入（主檔按下上傳＝該月完整重寫），手機端讀取顯示。
//    請假/加班由手機端員工申請 → 雲端分頁 → 主檔讀取並核准/退回寫回（加班另有「已刪除」狀態）。
//    覆蓋採「分塊」：第一批 start!=false 才 clear＋寫表頭，其餘批次接續寫。
//    原因：/exec 的 URL 有長度上限（約 8,000 字元），整月排班一次送會被截斷。
//    ⚠ 寫入一律經 setNumberFormat("@") 轉純文字：否則表頭 "1" 會變 1.0，
//      且年月 "2026-09" 會被試算表當日期存成序列值（如 46266）→ 覆核與手機顯示全錯。
//    寫入兩條路徑（主系統補登／更正）：
//      - doGet?op=addpunch / addpunches（JSONP，主路徑，會回 {ok,id,skipped} 讓前端確認）
//      - doPost?op=addpunch（no-cors POST，後備；回應為 opaque，前端無法確認）
//    員工名單寫入（setemps）全欄一律存為純文字，避免 PIN 0123 被轉成數字 123、
//      也讓「離職日」保持 "YYYY-MM-DD"（手機端據此把離職員工的班表只顯示到離職日）。
//    ⚠ 修改本檔後必須在 Apps Script「部署 → 管理部署 → 編輯 → 版本：新版本 → 部署」，
//      否則 /exec 仍會跑舊版程式（常見症狀：按了上傳卻沒進雲端）。
//      appendPunch 以「紀錄編號」去重，兩條路徑可安全重試。
// ============================================================

// 版本標記：改動本檔時務必更新，health 端點會回傳，供主程式/前端判斷線上跑的是新版還是舊版。
const GAS_VERSION = "2026-09-26-applywin2";
const SHEET_EMPS  = "員工";
const PUNCH_COLS  = ["紀錄編號","時間戳","員工編號","姓名","類型","緯度","經度","距離","判定","來源","補登人","補登時間","補登原因","修正對象"];
// 2026-09-21(emp5)：EMP_COLS 由 4 欄增為 5 欄，新增「離職日」。
//   手機端靠它把離職員工的班表「只顯示到離職日」（最後排班日＝離職日）。
//   舊分頁的表頭由 ensureEmpHeader() 自我修復補上；值仍要按主系統「上傳員工名單到雲端」才會寫入。
const EMP_COLS    = ["員工編號", "姓名", "PIN", "狀態", "離職日"];
// 排班分頁：月曆寬格式（1~31 日各一欄），與主檔 exportSchedule() 的表頭完全一致。
// 分頁名「排班-YYYY-MM」以「排班-」開頭 → 不會被 readPunches() 的「1月..12月」掃到。
const SCHED_COLS  = ["年月","員工編號","姓名"]
  .concat(Array.from({length:31}, function(_,i){ return String(i+1); }))
  .concat(["備註"]);
// 「必須以純文字寫入」的欄位＝年月（避免被當日期存成序列值 46266）＋日欄 1~31
// （表頭 "1" 若變數字 1.0，主檔/手機端以欄名取值就會全部 undefined）。
// 不含「員工編號」（必為非數字代碼字串）與「姓名/備註」（中文），
// 強制 String() 只會增加無謂的型別轉換。此常數同時供 D 段驗證引用。
const DAY_COLS    = ["年月"].concat(Array.from({length:31}, function(_,i){ return String(i+1); }));
const SCHED_TAB   = "排班-";     // 分頁名前置詞

// 請假：單一分頁「請假」（全月份 append，不每月一分頁；序號為唯一 key）。
// 欄位順序＝主檔 LEAVE_COLS、手機端提交欄位三者完全一致（見 verify_leavecloud.js 契約）。
const LEAVE_TAB   = "請假";
const LEAVE_COLS  = ["序號","員工編號","姓名","假別","起始日","結束日","開始時間","結束時間","時數","狀態","申請時間","處理時間","處理備註"];

// 加班申請：單一分頁「加班」（與請假完全同構；序號為唯一 key）。
// 欄位順序＝主檔 OT_COLS、手機端提交欄位三者完全一致（見 verify_otcloud.js 契約）。
// 狀態值：申請中／核准／退回／已刪除（已刪除＝核准後作廢，列保留供稽核，時數回到未核准逾時）。
// 補償方式：加班費／加班補休。
const OT_TAB   = "加班";
const OT_COLS  = ["序號","員工編號","姓名","加班日期","開始時間","結束時間","時數","補償方式","事由",
                  "狀態","申請時間","處理時間","處理備註","刪除時間","刪除備註",
                  "休息時數"];   // 2026-09-25 新增：選填（小時）；刻意放「最右」＝既有分頁欄位不位移（舊列視為 0）
const OT_DATE_COLS  = ["加班日期"];                            // → yyyy-MM-dd
const OT_STAMP_COLS = ["申請時間","處理時間","刪除時間"];        // → yyyy-MM-dd HH:mm:ss
const OT_WINDOW_DAYS = 7;   // 加班日起 7 天內須提出申請（加班申請期限）；以伺服器日期為準。❗手機端 PunchPage 同名常數須同步

// 補休（逐筆帳；階段三 2026-09-26）：單一分頁「補休」，與加班鏈同構。
// 每筆「加班補休」核准後由主檔產生（主檔算 折現權數〔加權時數〕/到期日/基準時薪 後寫入本端；可休時數＝時數 1:1）；
// 到期（加班日＋6個月）折現與 FIFO 扣抵由主檔薪資計算時處理，本端只存授權記錄。
// 狀態值：有效／已折現／已刪除（已刪除＝該筆加班被刪除，列保留供稽核）。
const COMP_TAB       = "補休";
const COMP_COLS      = ["序號","員工編號","姓名","加班日","產生日","到期日","時數","加權時數","基準時薪","狀態","折現日期","折現金額","已用權數"];
const COMP_DATE_COLS = ["加班日","產生日","到期日","折現日期"];   // → yyyy-MM-dd

// 由「時間戳」(YYYY-MM-DD ...) 推分頁名；無效則退回目前月份
function monthTab(dateStr){
  let m = null;
  if(dateStr && typeof dateStr === "string"){
    const mm = dateStr.match(/^\s*(\d{4})[-/](\d{1,2})/);
    if(mm) m = parseInt(mm[2], 10);
  }
  if(!m || m < 1 || m > 12) m = new Date().getMonth() + 1;
  return m + "月";
}

function getSS(){ return SpreadsheetApp.getActiveSpreadsheet(); }

// 自我修復「員工」分頁表頭：早期版本只有 3 欄（編號/姓名/PIN），
// 若舊分頁沿用至今，即使新版程式已部署，表頭也不會自動變新欄數（因為 ensureSheets 原本只在
// 分頁不存在時才寫表頭）。這裡在每次 ensureSheets 時檢查，只要表頭與 EMP_COLS 不符就補正，
// 讓「狀態」「離職日」欄立刻出現（值仍需靠 setemps 上傳寫入）。讀寫失敗不阻斷主要流程。
function ensureEmpHeader(sh){
  try{
    const n = EMP_COLS.length;
    const row1 = sh.getRange(1, 1, 1, n).getValues()[0] || [];
    let same = true;
    for(let i = 0; i < n; i++){
      if(String(row1[i] == null ? "" : row1[i]).trim() !== EMP_COLS[i]){ same = false; break; }
    }
    if(!same) sh.getRange(1, 1, 1, n).setNumberFormat("@").setValues([EMP_COLS.slice()]);
  }catch(err){ /* 表頭補正失敗不影響主要流程 */ }
}

function ensureSheets(){
  const ss = getSS();
  let emps = ss.getSheetByName(SHEET_EMPS);
  if(!emps){ emps = ss.insertSheet(SHEET_EMPS); emps.appendRow(EMP_COLS); }
  else { ensureEmpHeader(emps); }          // 舊分頁自我修復表頭（補上「狀態」「離職日」欄）
  for(let m = 1; m <= 12; m++){
    const name = m + "月";
    let sh = ss.getSheetByName(name);
    if(!sh){ sh = ss.insertSheet(name); sh.appendRow(PUNCH_COLS); }
  }
}

// ---------- 排班（雲端中繼；一月一分頁，整月覆蓋） ----------
function isValidYm(ym){
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym == null ? "" : ym).trim());
  if(!m) return false;
  const mm = parseInt(m[2], 10);
  return mm >= 1 && mm <= 12;
}
function schedTab(ym){ return SCHED_TAB + String(ym == null ? "" : ym).trim(); }

// 取（必要時建立）該月排班分頁；分頁名以「排班-」開頭，ensureSheets 不會預建。
function ensureSchedSheet(ym){
  if(!isValidYm(ym)) return null;
  ensureSheets();                       // 順手確保「員工」＋ 12 個月分頁存在
  const ss = getSS(), name = schedTab(ym);
  let sh = ss.getSheetByName(name);
  if(!sh){ sh = ss.insertSheet(name); sh.appendRow(SCHED_COLS); }
  return sh;
}
// 防禦：早期版本曾讓「年月」被試算表當日期存成序列值（如 46266）。
// 讀回時一律正規化為 YYYY-MM，避免前端覆核／手機顯示拿到無意義的數字。
function normYm(v, fallback){
  if(v instanceof Date && !isNaN(v.getTime())){
    return Utilities.formatDate(v, "Asia/Taipei", "yyyy-MM");
  }
  const s = String(v == null ? "" : v).trim();
  if(/^\d{4}-\d{2}$/.test(s)) return s;
  if(/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 7);
  const n = Number(s);
  if(isFinite(n) && n > 20000 && n < 80000){            // Excel 日期序列值
    const ms = (n - 25569) * 86400000;                  // 25569 = 1970-01-01 的序列值
    const d = new Date(ms);
    if(!isNaN(d.getTime())) return Utilities.formatDate(d, "Asia/Taipei", "yyyy-MM");
  }
  return fallback || "";
}

// ---------- 申請窗口（月結）守門：2026-09-26 需求定案，2026-09-27 改動態 ----------
// ❗❗**總開關（2026-09-27 起改為動態）**：改讀 `ScriptProperties`（雲端真鎖狀態），
//   由本機「設定頁 → 🔒 月結鎖定」開關經 `setMonthClose` 端點切換，**免 redeploy**。
//   ScriptProperties 未設定 → 視同 `false`（測試期不限制）。本機 `State.monthClose` 從主檔「設定」分頁讀取，兩邊需一致。
//   啟用後規則：資料所屬月份 M 的「次月 5 日（發薪日）」00:00 起，該月不得再寫入（含員工手機端）。
//   `var` 仍保留 → 測試可直接覆寫全域 `MONTH_CLOSE_ENABLED` 驗證守門邏輯。
function getMonthCloseEnabled(){
  try { var p = PropertiesService.getScriptProperties().getProperty("MONTH_CLOSE_ENABLED"); }
  catch(e){ p = null; }
  return p === "true";
}
var MONTH_CLOSE_ENABLED = getMonthCloseEnabled();
function setMonthClose(enabled){
  var v = (enabled === true || enabled === "true" || enabled === 1 || enabled === "1");
  try { PropertiesService.getScriptProperties().setProperty("MONTH_CLOSE_ENABLED", v ? "true" : "false"); } catch(e){}
  MONTH_CLOSE_ENABLED = v;   // 本次執行立即生效（下一個請求會從 ScriptProperties 重讀）
  return { ok:true, enabled: v };
}
// ========== 寫入權杖守門（2026-10-25 新增；**選用，預設不啟用**）==========
// 目的：`doGet`/`doPost` 的寫入 op（排班上傳、核准/退回、匯入員工、月結鎖定…）
//       原本**匿名可呼叫**——只要知道 /exec 網址就能改資料。
// 機制：GAS 指令碼屬性 `WRITE_TOKEN` 一旦設定，所有寫入 op 必須帶相同的 `tok` 才放行。
//   · `WRITE_TOKEN` **未設定（空字串）→ 不啟用**，行為與舊版完全相同（不會弄壞現有部署）。
//   · 啟用方式：Apps Script → 專案設定 → 指令碼屬性 → 新增 `WRITE_TOKEN`＝自訂長亂數。
//   · 前端對應：主系統「設定 → 雲端中繼設定 → 雲端寫入權杖」填同一組值（存本機瀏覽器）。
// 範圍限制（重要）：
//   · 手機端走 `google.script.run`（直接呼叫函式），**不經過這裡**，因此不受權杖影響；
//     員工寫入的防線是 PIN 驗證，而不是共用權杖（共用權杖會寫在手機頁 HTML 裡，等於公開）。
//   · 權杖走網址 query（JSONP 只能用 GET）→ 會留在瀏覽器歷史與伺服器日誌，
//     故它是「擋掉不知情的掃描者」而非「抗攔截的加密憑證」。
var WRITE_OPS_ = { setschedule:1, addleave:1, setleave:1, addot:1, setot:1,
                   adcomp:1, setcomp:1, addpunch:1, addpunches:1, setemps:1, setMonthClose:1 };
function getWriteToken(){
  try { return PropertiesService.getScriptProperties().getProperty("WRITE_TOKEN") || ""; }
  catch(e){ return ""; }
}
/* 回傳 null＝放行；回傳物件＝拒絕對象（呼叫端直接輸出）。
   got 可能來自 query（doGet）或 payload（doPost）。 */
function writeDenied_(got){
  var need = getWriteToken();
  if(!need) return null;                       // 未設定 → 不啟用（相容）
  if(String(got == null ? "" : got) === need) return null;
  return { ok:false, error:"寫入被拒：缺少或錯誤的寫入權杖（tok）。" +
           "請在主系統「設定 → 雲端中繼設定 → 雲端寫入權杖」填入與 GAS 指令碼屬性 WRITE_TOKEN 相同的值。" };
}

// 月結鎖定（MONTH_CLOSE_ENABLED）規則（啟用時）：資料所屬月份 M 的「次月 5 日（發薪日）」00:00 起，該月一律不得再寫入（薪資已發放）。
//   · 判定用「**資料所屬日期**」，不是「送出當下」——
//       9/20 的加班在 10/6 送出 → 擋（9 月已關）；10/3 的加班在 10/6 送出 → 放行（10 月窗口開到 11/4）。
//   · 只擋「申請／補登／排班上傳」等寫入；核准／退回／折現（setLeave／setOt／setComp）**不擋**。
//   · ❗OT_WINDOW_DAYS（加班日起 N 天申請期限）**仍保留**，兩條規則並存；
//     需求方 2026-09-26 指示「先維持不限制，等完成再決定是否由本規則取代」。
//   · 認不出日期時**不擋**（該由欄位驗證另行擋掉），避免誤鎖正常資料。
function applyCloseDeadline(dateStr){
  // 回傳「該日期所屬月份」的次月 5 日 00:00 時間戳；無法解析回 null（＝不擋）。
  // 接受 "YYYY-MM-DD…" 或 "YYYY-MM"（排班的年月）；其餘（空值／Excel 序號已由 leaveCellStr 正規化）一律 null。
  const s = leaveCellStr(dateStr, false);
  const m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/.exec(String(s == null ? "" : s).trim());
  if(!m) return null;
  const y = parseInt(m[1], 10), mo = parseInt(m[2], 10);
  if(!(y >= 1900 && y <= 2200) || !(mo >= 1 && mo <= 12)) return null;
  const ny = (mo === 12) ? y + 1 : y;
  const nm = (mo === 12) ? 1 : mo + 1;
  const mm = (nm < 10 ? "0" : "") + nm;
  return new Date(ny + "-" + mm + "-05T00:00:00").getTime();
}
function isApplyClosed(dateStr, nowMs){
  if(!MONTH_CLOSE_ENABLED) return false;          // 總開關關閉＝測試期不限制（目前）
  const dl = applyCloseDeadline(dateStr);
  if(dl == null) return false;
  const now = (nowMs == null) ? new Date().getTime() : nowMs;
  return now >= dl;
}
// 統一的拒寫回應（前端可直接讀 ym 顯示；不 throw，維持各函式「回物件」的既有契約）
function applyClosedErr(dateStr){
  const s = String(leaveCellStr(dateStr, false) == null ? "" : leaveCellStr(dateStr, false)).trim();
  const m = /^(\d{4})-(\d{1,2})/.exec(s);
  const ym = m ? (m[1] + "-" + ((parseInt(m[2], 10) < 10 ? "0" : "") + parseInt(m[2], 10))) : "";
  return { ok:false, closed:true, ym:ym,
           error:"該月（" + (ym || s) + "）申請已截止（薪資已發放），無法寫入。" };
}

function readSchedule(ym){
  if(!isValidYm(ym)) return [];
  const sh = getSS().getSheetByName(schedTab(ym));
  if(!sh) return [];
  const data = sh.getDataRange().getValues();
  const rows = [];
  for(let i = 1; i < data.length; i++){
    const r = data[i];
    const o = {};
    SCHED_COLS.forEach(function(c, j){ o[c] = (r[j] == null ? "" : r[j]); });
    const id = String(o["員工編號"] == null ? "" : o["員工編號"]).trim();
    const nm = String(o["姓名"] == null ? "" : o["姓名"]).trim();
    if(!id && !nm) continue;   // 完全空白列才略過；「班別定義列」（員工編號留空、姓名放代碼）要保留給手機頁解析
    o["年月"] = normYm(o["年月"], ym);                   // 還原被轉成數字的年月
    rows.push(o);
  }
  return rows;
}
// 整月覆蓋（支援分塊）：第一批 start=true 才 clear＋寫表頭，之後的批次 append。
// 為何要分塊：Apps Script /exec 的 URL 有長度上限（約 8,000 字元），
// 10 人 × 31 天的排班經 URL 編碼後會超過 8,400 字元 → 被截斷 → JSON 解析失敗 → 靜默寫成空表。
function writeSchedule(ym, rows, opts){
  if(!isValidYm(ym)) return { ok:false, error:"年月格式須為 YYYY-MM" };
  if(isApplyClosed(ym)) return applyClosedErr(ym);   // 月結守門：已發薪的月份不得再上傳排班
  const sh = ensureSchedSheet(ym);
  if(!sh) return { ok:false, error:"無法建立排班分頁" };
  const list = Array.isArray(rows) ? rows : [];
  const start = !opts || opts.start !== false;   // 預設 true＝單次呼叫即整月覆蓋（相容舊行為）
  if(start) sh.clear();
  const head = start ? [SCHED_COLS.slice()] : [];
  const body = [];
  list.forEach(function(r){
    if(!r) return;
    const id = String(r["員工編號"] == null ? "" : r["員工編號"]).trim();
    const nm = String(r["姓名"] == null ? "" : r["姓名"]).trim();
    // 完全空白列才略過；員工編號留空的「班別定義列」（姓名欄放代碼）要保留，
    // 否則手機頁讀回後無法解析代碼→名稱/時段（見主檔 buildSchedAoa 上傳的定義列）。
    if(!id && !nm) return;
    body.push(SCHED_COLS.map(function(c, j){
      let v = r[c];
      if(v == null) v = "";
      if(j === 0) v = isValidYm(v) ? String(v).trim() : ym;   // 年月一律用本次上傳的 ym
      // 日欄（1~31）與年月：純文字；其餘欄位（員工編號/姓名/備註）不強制轉型，
      // 保留原值語意（見下方 DAY_COLS 說明與 D 段驗證）。
      if(DAY_COLS.indexOf(c) >= 0) return String(v);
      return v;
    }));
  });
  const out = head.concat(body);

  // ★關鍵★ 一律用 getRange().setNumberFormat("@").setValues() 寫入：
  //   · 表頭 "1"~"31" 不會被試算表轉成數字 1.0~31.0
  //   · 年月 "2026-09" 不會被當日期解析成序列值 46266
  //   · 用「列號定位」而非 appendRow，分塊寫入不會因空列而錯位
  if(out.length){
    const row0 = start ? 1 : Math.max(1, sh.getLastRow() + 1);
    sh.getRange(row0, 1, out.length, SCHED_COLS.length)
      .setNumberFormat("@")
      .setValues(out);
  }
  return { ok:true, ym:ym, tab:schedTab(ym), n:body.length, start:start };
}

// ---------- 請假（雲端中繼；單一分頁「請假」，全月份 append） ----------
// 單一分頁、以「序號」為唯一 key（不每月一分頁，避免像打卡那樣 12 個月分頁膨脹）。
// 寫入兩條路徑（與打卡一致）：JSONP addleave（主路徑，回 {ok,id,skipped} 可確認）
//                          ＋ doPost addleave（no-cors 後備，回應 opaque）。
// 序號去重 → 手機重送安全。核准/退回由主檔 setleave 用序號定位該列改狀態。
function ensureLeaveSheet(){
  const ss = getSS();
  let sh = ss.getSheetByName(LEAVE_TAB);
  if(!sh){ sh = ss.insertSheet(LEAVE_TAB); sh.appendRow(LEAVE_COLS); }
  return sh;
}
// 讀取：全部分頁內容；帶 empFilter（員工編號）只回該員（手機「我的請假」用）。
// 2026-09-22(leave4)：**日期/時間值一律先正規化成字串再回傳**。
//   動機：試算表會把寫入的「2026-09-22 10:25:11」自動轉成日期時間值，getValues() 讀回是
//   Date → 經 JSONP 序列化就成了「2026-09-22T02:25:11.000Z」，前端畫面直接顯示這串 UTC ISO，
//   而且跨日會位移（16:00Z 之後的日期退一天）。這裡統一以 Asia/Taipei 輸出，
//   前端（主檔／手機）拿到的就是可直接顯示、可直接比對的牆鐘字串。
const LEAVE_DATE_COLS = ["起始日","結束日"];                              // → yyyy-MM-dd
const LEAVE_STAMP_COLS = ["申請時間","處理時間"];                          // → yyyy-MM-dd HH:mm:ss
// 跨 realm 也有效的 Date 判定（`v instanceof Date` 在 vm／iframe 等跨環境會失效；
// 主檔端同名為 isDateObj，兩邊用同一招）
function isDateVal(v){ return Object.prototype.toString.call(v) === "[object Date]"; }
function leaveCellStr(v, withTime){
  if(v == null || v === "") return "";
  if(isDateVal(v)){
    if(isNaN(v.getTime())) return "";
    return Utilities.formatDate(v, "Asia/Taipei", withTime ? "yyyy-MM-dd HH:mm:ss" : "yyyy-MM-dd");
  }
  const s = String(v).trim();
  if(!s) return "";
  if(/^\d+$/.test(s)){                                   // Excel 日期序號（1 = 1900-01-01）
    const n = Number(s);
    if(n > 20000 && n < 80000){
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
      return Utilities.formatDate(d, "Asia/Taipei", withTime ? "yyyy-MM-dd HH:mm:ss" : "yyyy-MM-dd");
    }
  }
  return s;                                              // 已是字串：原樣（含時間也保留）
}
// 2026-09-22(leave5)：員工編號比對加正規化 normEid()——
//   動機：雲端「員工」分頁的員工編號若從 Excel 複製時帶入零寬字元（\u200B-\u200D\uFEFF）
//   或大小寫差異，手機驗證（同源比對）會通過，但拿去比對「請假」分頁（乾淨值）就永遠查不到
//   （症狀＝診斷工具用字面 E002 查得到、手機「我的請假」永遠查無）。
function normEid(s){
  return String(s == null ? "" : s)
    .replace(/[\u200B-\u200D\uFEFF\s]/g, "")   // 去零寬字元＋所有空白
    .toUpperCase();
}
function readLeaves(empFilter){
  const sh = getSS().getSheetByName(LEAVE_TAB);
  if(!sh) return [];
  const data = sh.getDataRange().getValues();
  const f = empFilter ? normEid(empFilter) : "";          // 過濾值正規化
  const rows = [];
  for(let i = 1; i < data.length; i++){
    const r = data[i];
    const o = {}; LEAVE_COLS.forEach((c, j) => o[c] = (r[j] == null ? "" : r[j]));
    const id = String(o["員工編號"] == null ? "" : o["員工編號"]).trim();
    if(!id && !String(o["序號"] || "").trim()) continue;     // 完全空白列才略過
    if(f && normEid(id) !== f) continue;                     // 正規化後比對（零寬/空白/大小寫差異不影響）
    LEAVE_DATE_COLS.forEach(c => o[c] = leaveCellStr(o[c], false));
    LEAVE_STAMP_COLS.forEach(c => o[c] = leaveCellStr(o[c], true));
    rows.push(o);
  }
  return rows;
}
function leaveNowStamp(){
  return Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
}
// 以「序號」去重：兩條寫入路徑可安全重試（手機網路抖動重送不會產生重複列）。
// 2026-09-22(leave3)：加守門——沒有「序號」或「員工編號」一律拒寫。
//   動機：主檔曾以物件（非 JSON 字串）呼叫 JSONP addleave，GAS safeJson 解析失敗回 {}，
//   這裡照樣 appendRow 一整列空白並回 ok:true → 前端顯示成功、雲端卻查不到（手機「我的請假」空白）。
// 2026-09-22(leave4)：改用**列號定位 ＋ setNumberFormat("@")** 寫入（不再 appendRow）。
//   動機：appendRow 會讓試算表「自動猜型別」，把「2026-09-22 10:25:11」存成日期時間值，
//   讀回變 Date → 前端顯示成 UTC ISO。整列設成純文字後，日期/時間/前導零都原樣保留。
function appendLeave(rec){
  if(typeof rec === "string") rec = safeJson(rec, {});
  rec = rec || {};
  const no = String(rec["序號"] || "").trim();
  const eid = String(rec["員工編號"] || "").trim();
  if(!no)  return { ok:false, error:"請假紀錄缺少序號，未寫入雲端。" };
  if(!eid) return { ok:false, error:"請假紀錄缺少員工編號，未寫入雲端。" };
  if(isApplyClosed(rec["起始日"])) return applyClosedErr(rec["起始日"]);   // 月結守門
  const sh = ensureLeaveSheet();
  const data = sh.getDataRange().getValues();
  for(let i = 1; i < data.length; i++){
    if(String(data[i][0] == null ? "" : data[i][0]).trim() === no) return { ok:true, id:no, skipped:true };
  }
  const row0 = Math.max(2, sh.getLastRow() + 1);          // 第 1 列是表頭
  sh.getRange(row0, 1, 1, LEAVE_COLS.length)
    .setNumberFormat("@")
    .setValues([LEAVE_COLS.map(c => (rec[c] != null ? String(rec[c]) : ""))]);
  return { ok:true, id:no, skipped:false };
}
// 核准/退回：用序號定位該列，寫回「狀態」＋「處理時間」＋「處理備註」（退回理由）。
// 處理時間/備註先設純文字格式，避免「2026-09-22 10:25:11」被自動轉成日期時間值。
function setLeave(no, status, note){
  const sh = getSS().getSheetByName(LEAVE_TAB);
  if(!sh) return { ok:false, error:"找不到請假分頁" };
  const data = sh.getDataRange().getValues();
  const sIdx = LEAVE_COLS.indexOf("狀態");
  const tIdx = LEAVE_COLS.indexOf("處理時間");
  const nIdx = LEAVE_COLS.indexOf("處理備註");
  for(let i = 1; i < data.length; i++){
    if(String(data[i][0] == null ? "" : data[i][0]).trim() === String(no).trim()){
      sh.getRange(i+1, sIdx+1).setNumberFormat("@").setValue(status == null ? "" : String(status));
      sh.getRange(i+1, tIdx+1).setNumberFormat("@").setValue(leaveNowStamp());
      sh.getRange(i+1, nIdx+1).setNumberFormat("@").setValue(note == null ? "" : String(note));
      return { ok:true, id:no, status:status };
    }
  }
  return { ok:false, error:"找不到序號 " + no };
}

// ---------- 加班（雲端中繼；單一分頁「加班」，全月份 append） ----------
// 與請假鏈完全同構（設計規格《加班申請制_設計規格.md》§五）。
// 服務端守門（輕量）：序號/員工編號/加班日期/時數必填＋「加班日起申請期限」（OT_WINDOW_DAYS＝7 天）
//   以**伺服器日期**為準（手機時鐘不準也不影響；未來日期＝預先申請，不受限）。
// 與排班時段的重疊檢查在**手機端**送出前做（格子解析邏輯已存在手機頁；
//   本端點本無驗證，真正的把關是主檔核准 UI——核准權在僱主）。
/* 自我修復「加班」分頁表頭：既有分頁（15 欄）不會自己長出新欄位，
   只要表頭與 OT_COLS 不符就整列覆寫。新欄一律加在「最右」→ 既有資料列不位移
   （舊列的第 16 欄＝空白，讀取時以 Number||0 視為 0）。讀寫失敗不阻斷主流程。 */
function ensureOtHeader(sh){
  try{
    const last = Math.max(sh.getLastColumn ? sh.getLastColumn() : 0, OT_COLS.length);
    const hdr = sh.getRange(1, 1, 1, last).getValues()[0].map(v => String(v == null ? "" : v).trim());
    if(OT_COLS.some((c, j) => hdr[j] !== c))
      sh.getRange(1, 1, 1, OT_COLS.length).setValues([OT_COLS]);
  }catch(e){ /* 表頭修復失敗不影響讀寫 */ }
}
function ensureOtSheet(){
  const ss = getSS();
  let sh = ss.getSheetByName(OT_TAB);
  if(!sh){ sh = ss.insertSheet(OT_TAB); sh.appendRow(OT_COLS); }
  else { ensureOtHeader(sh); }
  return sh;
}
// 讀取：全部分頁內容；帶 empFilter（員工編號）只回該員（手機「我的加班」用）。
// 日期/時間值一律先正規化成字串再回傳（與 readLeaves 同一套 leaveCellStr，
// 避免試算表把日期存成 Date/序號後，JSONP 序列化成 UTC ISO 字串）。
function readOts(empFilter){
  const sh = getSS().getSheetByName(OT_TAB);
  if(!sh) return [];
  const data = sh.getDataRange().getValues();
  const f = empFilter ? normEid(empFilter) : "";
  const rows = [];
  for(let i = 1; i < data.length; i++){
    const r = data[i];
    const o = {}; OT_COLS.forEach((c, j) => o[c] = (r[j] == null ? "" : r[j]));
    const id = String(o["員工編號"] == null ? "" : o["員工編號"]).trim();
    if(!id && !String(o["序號"] || "").trim()) continue;     // 完全空白列才略過
    if(f && normEid(id) !== f) continue;                     // 正規化後比對（與 readLeaves 同招）
    OT_DATE_COLS.forEach(c => o[c] = leaveCellStr(o[c], false));
    OT_STAMP_COLS.forEach(c => o[c] = leaveCellStr(o[c], true));
    rows.push(o);
  }
  return rows;
}
function appendOt(rec){
  if(typeof rec === "string") rec = safeJson(rec, {});
  rec = rec || {};
  const no  = String(rec["序號"] || "").trim();
  const eid = String(rec["員工編號"] || "").trim();
  if(!no)  return { ok:false, error:"加班申請缺少序號，未寫入雲端。" };
  if(!eid) return { ok:false, error:"加班申請缺少員工編號，未寫入雲端。" };
  const dstr = leaveCellStr(rec["加班日期"], false);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(dstr)) return { ok:false, error:"加班日期格式須為 YYYY-MM-DD。" };
  if(isApplyClosed(dstr)) return applyClosedErr(dstr);   // 月結守門（先於 OT_WINDOW_DAYS；後者仍保留）
  const hrs = Number(rec["時數"]);
  if(!isFinite(hrs) || hrs <= 0) return { ok:false, error:"加班時數須大於 0，未寫入雲端。" };
  const restRaw = rec["休息時數"];                        // 選填：0 或正數（小時）；留空＝0
  const restH = Number(restRaw);
  if(restRaw != null && String(restRaw).trim() !== "" && (!isFinite(restH) || restH < 0))
    return { ok:false, error:"休息時數須為 0 或正數，未寫入雲端。" };
  // 7 天窗口：today 與 dstr 都用同一種方式解析成當地 00:00，日差計算不受時區設定影響（台灣無日光節約）。
  const today = leaveNowStamp().slice(0, 10);
  const diff = new Date(today + "T00:00:00").getTime() - new Date(dstr + "T00:00:00").getTime();
  if(diff > OT_WINDOW_DAYS * 86400000)
    return { ok:false, error:"已超過加班日起 " + OT_WINDOW_DAYS + " 天的申請期限（" + dstr + "）。" };
  const sh = ensureOtSheet();
  const data = sh.getDataRange().getValues();
  for(let i = 1; i < data.length; i++){
    if(String(data[i][0] == null ? "" : data[i][0]).trim() === no) return { ok:true, id:no, skipped:true };
  }
  const row0 = Math.max(2, sh.getLastRow() + 1);          // 第 1 列是表頭
  sh.getRange(row0, 1, 1, OT_COLS.length)
    .setNumberFormat("@")
    .setValues([OT_COLS.map(c => (rec[c] != null ? String(rec[c]) : ""))]);
  return { ok:true, id:no, skipped:false };
}
// 核准/退回：寫「狀態＋處理時間＋處理備註」；刪除（status="已刪除"）：寫「狀態＋刪除時間＋刪除備註」。
// 已刪除的列**保留**在分頁（稽核軌跡）；核准時數只認「核准」狀態；刪除後員工可重新申請同一時段。
function setOt(no, status, note){
  const sh = getSS().getSheetByName(OT_TAB);
  if(!sh) return { ok:false, error:"找不到加班分頁" };
  const st = String(status == null ? "" : status).trim();
  if(["申請中","核准","退回","已刪除"].indexOf(st) < 0)
    return { ok:false, error:"不支援的狀態：" + st };
  const data = sh.getDataRange().getValues();
  const sIdx  = OT_COLS.indexOf("狀態");
  const isDel = (st === "已刪除");
  const tIdx  = OT_COLS.indexOf(isDel ? "刪除時間" : "處理時間");
  const nIdx  = OT_COLS.indexOf(isDel ? "刪除備註" : "處理備註");
  for(let i = 1; i < data.length; i++){
    if(String(data[i][0] == null ? "" : data[i][0]).trim() === String(no).trim()){
      sh.getRange(i+1, sIdx+1).setNumberFormat("@").setValue(st);
      sh.getRange(i+1, tIdx+1).setNumberFormat("@").setValue(leaveNowStamp());
      sh.getRange(i+1, nIdx+1).setNumberFormat("@").setValue(note == null ? "" : String(note));
      return { ok:true, id:no, status:st };
    }
  }
  return { ok:false, error:"找不到序號 " + no };
}

// ---------- 補休（雲端中繼；單一分頁「補休」，與加班鏈同構） ----------
// 主檔核准「加班補休」時，先算好 折現權數〔加權時數〕/到期日/基準時薪 再寫入本端（本端不具薪資資料，
// 故不自己計算這些欄位）。讀取/寫入規格與 readOts/appendOt/setOt 完全一致。
function ensureCompSheet(){
  const ss = getSS();
  let sh = ss.getSheetByName(COMP_TAB);
  if(!sh){ sh = ss.insertSheet(COMP_TAB); sh.appendRow(COMP_COLS); }
  return sh;
}
function readComps(empFilter){
  const sh = getSS().getSheetByName(COMP_TAB);
  if(!sh) return [];
  const data = sh.getDataRange().getValues();
  const f = empFilter ? normEid(empFilter) : "";
  const rows = [];
  for(let i = 1; i < data.length; i++){
    const r = data[i];
    const o = {}; COMP_COLS.forEach((c, j) => o[c] = (r[j] == null ? "" : r[j]));
    const id = String(o["員工編號"] == null ? "" : o["員工編號"]).trim();
    if(!id && !String(o["序號"] || "").trim()) continue;     // 完全空白列才略過
    if(f && normEid(id) !== f) continue;                     // 正規化後比對
    COMP_DATE_COLS.forEach(c => o[c] = leaveCellStr(o[c], false));
    rows.push(o);
  }
  return rows;
}
function appendComp(rec){
  if(typeof rec === "string") rec = safeJson(rec, {});
  rec = rec || {};
  const no  = String(rec["序號"] || "").trim();
  const eid = String(rec["員工編號"] || "").trim();
  if(!no)  return { ok:false, error:"補休紀錄缺少序號，未寫入雲端。" };
  if(!eid) return { ok:false, error:"補休紀錄缺少員工編號，未寫入雲端。" };
  if(isApplyClosed(rec["加班日"])) return applyClosedErr(rec["加班日"]);   // 月結守門
  const sh = ensureCompSheet();
  const data = sh.getDataRange().getValues();
  for(let i = 1; i < data.length; i++){
    if(String(data[i][0] == null ? "" : data[i][0]).trim() === no) return { ok:true, id:no, skipped:true };
  }
  const row0 = Math.max(2, sh.getLastRow() + 1);          // 第 1 列是表頭
  sh.getRange(row0, 1, 1, COMP_COLS.length)
    .setNumberFormat("@")
    .setValues([COMP_COLS.map(c => (rec[c] != null ? String(rec[c]) : ""))]);
  return { ok:true, id:no, skipped:false };
}
// 折現/刪除：寫「狀態」＋（已折現時）「折現日期＋折現金額」。cash＝折現金額（由主檔算好傳入）。
function setComp(no, status, note, cash){
  const sh = getSS().getSheetByName(COMP_TAB);
  if(!sh) return { ok:false, error:"找不到補休分頁" };
  const st = String(status == null ? "" : status).trim();
  if(["有效","已折現","已刪除"].indexOf(st) < 0) return { ok:false, error:"不支援的狀態：" + st };
  const data = sh.getDataRange().getValues();
  const sIdx  = COMP_COLS.indexOf("狀態");
  const cdIdx = COMP_COLS.indexOf("折現日期");
  const cmIdx = COMP_COLS.indexOf("折現金額");
  for(let i = 1; i < data.length; i++){
    if(String(data[i][0] == null ? "" : data[i][0]).trim() === String(no).trim()){
      sh.getRange(i+1, sIdx+1).setNumberFormat("@").setValue(st);
      if(st === "已折現"){
        sh.getRange(i+1, cdIdx+1).setNumberFormat("@").setValue(leaveNowStamp().slice(0, 10));
        sh.getRange(i+1, cmIdx+1).setNumberFormat("@").setValue(cash == null ? "" : String(cash));
      }
      return { ok:true, id:no, status:st };
    }
  }
  return { ok:false, error:"找不到序號 " + no };
}

// ---------- 內部資料存取 ----------
function readEmps(){
  const sh = getSS().getSheetByName(SHEET_EMPS);
  if(!sh) return [];
  const data = sh.getDataRange().getValues();
  return data.slice(1).map(r => {
    const o = {}; EMP_COLS.forEach((c, i) => o[c] = r[i]); return o;
  }).filter(o => o["員工編號"]);
}
// 對外（匿名可讀）用的員工名單：**剔除 PIN 欄**，只回「是否已設 PIN」。
// PIN 是手機打卡的登入憑證，不可隨名單一起外送（code review 問題2）。
function readEmpsPublic(){
  return readEmps().map(o => {
    const c = {};
    EMP_COLS.forEach(k => { if(k !== "PIN") c[k] = o[k]; });
    c["hasPin"] = !!String(o["PIN"] == null ? "" : o["PIN"]).trim();
    return c;
  });
}
// 伺服器端驗證「員工編號＋PIN」；正確才回 { ok:true, emp:{員工編號,姓名} }（不含 PIN）。
// 手機端登入／打卡改走這裡，前端不再持有全店 PIN 清單。
function verifyEmpPin(eid, pin){
  const id = normEid(eid);
  const p  = String(pin == null ? "" : pin).trim();
  if(!id || !p) return { ok:false, error:"請輸入員工編號與 PIN" };
  const hit = readEmps().find(o => normEid(o["員工編號"]) === id);
  if(!hit) return { ok:false, error:"員工編號或 PIN 錯誤" };
  const real = String(hit["PIN"] == null ? "" : hit["PIN"]).trim();
  if(!real) return { ok:false, error:"此員工尚未設定 PIN，請洽管理員" };
  if(real !== p) return { ok:false, error:"員工編號或 PIN 錯誤" };
  return { ok:true, emp:{ "員工編號":hit["員工編號"], "姓名":hit["姓名"] } };
}
function writeEmps(rows){
  const sh = getSS().getSheetByName(SHEET_EMPS);
  sh.clear(); sh.appendRow(EMP_COLS);     // 整批覆寫：先清空再寫（重送安全、不會殘留舊員工）
  const list = rows || [];
  if(!list.length) return;
  const vals = list.map(r => EMP_COLS.map(c => (r[c] != null ? r[c] : "")));
  if(typeof sh.getRange === "function"){
    // 全欄一律「純文字」格式：否則 PIN `0123` 會被試算表自動轉成數字 123，
    // 手機端 String(PIN)!=="0123" → 員工明明打對卻登入失敗。
    // 「離職日」同理：保持 "YYYY-MM-DD" 文字，手機端才能直接比對年月。
    sh.getRange(2, 1, vals.length, EMP_COLS.length).setNumberFormat("@").setValues(vals);
  } else {
    vals.forEach(v => sh.appendRow(v));
  }
}
function appendPunch(rec){
  if(isApplyClosed(rec && rec["時間戳"])) return applyClosedErr(rec && rec["時間戳"]);   // 月結守門：已發薪的月份不得再補登打卡
  const tab = monthTab(rec && rec["時間戳"]);
  const sh = getSS().getSheetByName(tab);
  if(!sh) return { ok:false, tab:tab, error:"找不到分頁 " + tab };
  const no = String((rec && rec["紀錄編號"]) || "").trim();
  // 以「紀錄編號」去重：主系統寫入會先試 JSONP、失敗才退回 POST，
  // 去重後即使兩條路徑都送出（或回應遺失後重試）也不會產生重複列 → 寫入具冪等性。
  if(no && existsPunchNo(sh, no)) return { ok:true, tab:tab, id:no, skipped:true };
  sh.appendRow(PUNCH_COLS.map(c => (rec && rec[c] != null ? rec[c] : "")));
  return { ok:true, tab:tab, id:no, skipped:false };
}
// 該分頁是否已有此「紀錄編號」（用 getDataRange，離線 mock 也能驗證）
function existsPunchNo(sh, no){
  const data = sh.getDataRange().getValues();
  for(let i = 1; i < data.length; i++){
    if(String(data[i][0] == null ? "" : data[i][0]).trim() === no) return true;
  }
  return false;
}
// 參數為 JSON 字串時的寬容解析（GET 端點用）
function safeJson(s, dflt){
  try{
    const v = JSON.parse(s == null ? "" : String(s));
    return (v == null ? dflt : v);
  }catch(err){ return dflt; }
}
function readPunches(){
  const out = [];
  for(let m = 1; m <= 12; m++){
    const sh = getSS().getSheetByName(m + "月");
    if(!sh) continue;
    const data = sh.getDataRange().getValues();
    data.slice(1).forEach(r => {
      const o = {};
      PUNCH_COLS.forEach((c, i) => {
        let v = r[i];
        // 時間戳 / 補登時間 在試算表內部是 Date（UTC），回傳前轉成台灣時間文字，
        // 避免前端把 UTC 當本地時間顯示而偏移 8 小時（修 2026-09-19 時區 bug）。
        if((c === "時間戳" || c === "補登時間") && v instanceof Date){
          v = Utilities.formatDate(v, "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
        }
        o[c] = v;
      });
      if(o["紀錄編號"]) out.push(o);
    });
  }
  return out;
}

// 由 ym（YYYY-MM）推分頁名（「3月」）；無效退回目前月份
function monthTabFromYm(ym){
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym == null ? "" : ym).trim());
  let mo = m ? parseInt(m[2], 10) : new Date().getMonth() + 1;
  if(!mo || mo < 1 || mo > 12) mo = new Date().getMonth() + 1;
  return mo + "月";
}
// 手機「我的打卡」：員工查自己某年某月的打卡（PIN 已在手機端 verifyEmp 把關，
// 這裡再按員工編號過濾、且只讀該月單一分頁，絕不把全店打卡吐到前端）。
// 日期一律轉台灣時間文字（與 readPunches 同一套時區處理）。
function readPunchesByEmp(empId, ym){
  if(!empId || !isValidYm(ym)) return [];
  const sh = getSS().getSheetByName(monthTabFromYm(ym));
  if(!sh) return [];
  const data = sh.getDataRange().getValues();
  const f = normEid(empId);
  const rows = [];
  for(let i = 1; i < data.length; i++){
    const r = data[i];
    const o = {};
    PUNCH_COLS.forEach((c, j) => {
      let v = r[j];
      if((c === "時間戳" || c === "補登時間") && v instanceof Date){
        v = Utilities.formatDate(v, "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
      }
      o[c] = v;
    });
    const id = normEid(o["員工編號"]);
    if(!id) continue;
    if(id !== f) continue;          // 只看自己
    rows.push(o);
  }
  return rows;
}

// ---------- 對外：google.script.run（打卡頁用） ----------
function getEmps(){ ensureSheets(); return readEmpsPublic(); }
function getPunches(){ ensureSheets(); return readPunches(); }
function addPunch(rec){ ensureSheets(); appendPunch(rec); return { ok:true, id:(rec && rec["紀錄編號"]) }; }
function setEmps(rows){ ensureSheets(); writeEmps(rows); return { ok:true }; }
// 手機打卡頁讀取整月排班（全店可見，不驗身分、不與打卡比對）
function getSchedule(ym){
  ensureSheets();
  return { ym:String(ym == null ? "" : ym).trim(), rows:readSchedule(ym) };
}
// 手機打卡頁請假：員工送出申請（append，序號去重）／查詢自己的請假；主檔核准/退回
function leaveGetAll(){ ensureSheets(); ensureLeaveSheet(); return readLeaves(); }
function leaveGetMy(empId){ ensureSheets(); ensureLeaveSheet(); return readLeaves(empId); }
// 手機「我的打卡」：員工查自己某年某月（PIN 把關在 caller 端，這裡只照員工編號過濾）
function getPunchesMy(empId, ym){ ensureSheets(); return readPunchesByEmp(empId, ym); }
function leaveAdd(rec){ ensureSheets(); return appendLeave(rec || {}); }
function leaveSet(no, status, note){ ensureSheets(); return setLeave(no, status, note); }
// 手機打卡頁加班：員工送出申請（append，序號去重）／查詢自己的加班；主檔核准/退回/刪除
function otGetAll(){ ensureSheets(); ensureOtSheet(); return readOts(); }
function otGetMy(empId){ ensureSheets(); ensureOtSheet(); return readOts(empId); }
function otAdd(rec){ ensureSheets(); return appendOt(rec || {}); }
function otSet(no, status, note){ ensureSheets(); return setOt(no, status, note); }
// 補休：主檔核准「加班補休」後寫入授權記錄；主檔薪資計算時折現/刪除
function compGetAll(){ ensureSheets(); ensureCompSheet(); return readComps(); }
function compGetMy(empId){ ensureSheets(); ensureCompSheet(); return readComps(empId); }
function compAdd(rec){ ensureSheets(); return appendComp(rec || {}); }
function compSet(no, status, note, cash){ ensureSheets(); return setComp(no, status, note, cash); }

// ---------- 對外：HTTP 端點（主系統讀取 / 舊版寫入） ----------
function doGet(e){
  const op = (e && e.parameter && e.parameter.op) || "";
  // 寫入類 op 須通過寫入權杖（GAS 指令碼屬性 WRITE_TOKEN 未設定＝不啟用，行為同舊版）
  if(WRITE_OPS_[op]){
    const denied = writeDenied_(e && e.parameter && e.parameter.tok);
    if(denied) return jsonpOut(e, denied);
  }
  if(op === "health"){
    let ssName = "";
    try { ssName = getSS().getName(); } catch(err) { ssName = ""; }   // 回傳綁定的試算表檔名，讓主系統測試連線時能確認連到哪個檔案
    // 寫入權杖狀態（只回布林，不回權杖本身）：tokOn＝雲端是否已啟用；tokOk＝本次帶的 tok 是否正確（未啟用時為 null）
    const _wt = getWriteToken();
    const _tokOn = !!_wt;
    const _tokOk = _tokOn ? (String((e && e.parameter && e.parameter.tok) || "") === _wt) : null;
    return jsonpOut(e, { ok:true, time:new Date().toISOString(), v:GAS_VERSION, empCols:EMP_COLS.length, empColsList:EMP_COLS.slice(), otCols:OT_COLS.length, compCols:COMP_COLS.length, name:ssName, tokOn:_tokOn, tokOk:_tokOk });
  }
  if(op === "emps"){ ensureSheets(); return jsonpOut(e, readEmpsPublic()); }
  // 手機登入驗證：員工編號＋PIN 交由伺服器比對（前端不再取得 PIN 清單）
  if(op === "verify"){ ensureSheets(); return jsonpOut(e, verifyEmpPin(e.parameter.eid, e.parameter.pin)); }
  if(op === "punches"){ ensureSheets(); return jsonpOut(e, readPunches()); }
  // ---- 排班（雲端中繼）：主檔上傳整月、手機端／主檔讀取整月 ----
  if(op === "getschedule"){ ensureSheets(); return jsonpOut(e, readSchedule(e.parameter.ym)); }
  if(op === "setschedule"){
    ensureSheets();
    const rows = safeJson(e.parameter.rows, []);
    // start=0（或 false）＝這是後續分塊，不要清空分頁
    const st = e.parameter.start;
    const isStart = !(st === "0" || st === "false");
    return jsonpOut(e, writeSchedule(e.parameter.ym, Array.isArray(rows) ? rows : [], { start:isStart }));
  }
  // ---- 請假（雲端中繼）：主檔讀取全部 / 手機只讀自己；手機送出申請；主檔核准/退回 ----
  if(op === "getleave"){
    ensureSheets(); ensureLeaveSheet();
    return jsonpOut(e, readLeaves(e.parameter.emp));
  }
  if(op === "addleave"){
    ensureSheets();
    return jsonpOut(e, appendLeave(safeJson(e.parameter.record, {}) || {}));
  }
  if(op === "setleave"){
    ensureSheets();
    return jsonpOut(e, setLeave(e.parameter.no, e.parameter.status, e.parameter.note));
  }
  // ---- 加班（雲端中繼）：與請假同構。主檔讀取全部；手機只讀自己；手機送出；主檔核准/退回/刪除 ----
  if(op === "getot"){
    ensureSheets(); ensureOtSheet();
    return jsonpOut(e, readOts(e.parameter.emp));
  }
  if(op === "addot"){
    ensureSheets();
    return jsonpOut(e, appendOt(safeJson(e.parameter.record, {}) || {}));
  }
  if(op === "setot"){
    ensureSheets();
    return jsonpOut(e, setOt(e.parameter.no, e.parameter.status, e.parameter.note));
  }
  // ---- 補休（雲端中繼；與加班同構。主檔讀取全部；手機不直讀；主檔核准「加班補休」時寫入；到期折現/刪除寫回）----
  if(op === "getcomp"){
    ensureSheets(); ensureCompSheet();
    return jsonpOut(e, readComps(e.parameter.emp));
  }
  if(op === "adcomp"){
    ensureSheets();
    return jsonpOut(e, appendComp(safeJson(e.parameter.record, {}) || {}));
  }
  if(op === "setcomp"){
    ensureSheets();
    return jsonpOut(e, setComp(e.parameter.no, e.parameter.status, e.parameter.note, e.parameter.cash));
  }
  // ---- 寫入（JSONP）：主系統的補登／更正走這條，伺服器會回結果 → 前端可確認是否真的寫入 ----
  if(op === "addpunch"){
    ensureSheets();
    return jsonpOut(e, appendPunch(safeJson(e.parameter.record, {}) || {}));
  }
  if(op === "addpunches"){
    ensureSheets();
    const rows = safeJson(e.parameter.rows, []);
    const res = (Array.isArray(rows) ? rows : []).map(r => appendPunch(r || {}));
    // ❗2026-09-26：added 只算「真的寫入成功」的（ok && !skipped）。
    //   月結守門擋下的那幾筆回 {ok:false,closed:true}，若只濾 !skipped 會被誤計為「已新增」，
    //   前端就會顯示「新增 N 筆」但雲端一筆都沒進去（與 leave3 的空白列事故同一種誤導）。
    return jsonpOut(e, { ok:true, n:res.length, added:res.filter(x => x.ok && !x.skipped).length, failed:res.filter(x => !x.ok).length, results:res });
  }
  if(op === "setemps"){
    ensureSheets();
    const rows = safeJson(e.parameter.rows, []);
    writeEmps(Array.isArray(rows) ? rows : []);
    return jsonpOut(e, { ok:true, n:(Array.isArray(rows) ? rows.length : 0) });
  }
  if(op === "setMonthClose"){ return jsonpOut(e, setMonthClose(e.parameter.enabled)); }
  // 預設：回傳員工打卡頁（員工手機開這個網址打卡）
  ensureSheets();
  return HtmlService.createHtmlOutputFromFile("PunchPage").setTitle("員工打卡");
}

function doPost(e){
  const op = (e && e.parameter && e.parameter.op) || "";
  let payload = {};
  try { payload = JSON.parse((e && e.postData && e.postData.contents) ? e.postData.contents : "{}"); }
  catch(err){ payload = {}; }
  // doPost 的 op 全部都是寫入 → 一律檢查寫入權杖（tok 可放 query 或 JSON body）
  { const denied = writeDenied_((e && e.parameter && e.parameter.tok) || (payload && payload.tok));
    if(denied) return jsonOut(denied); }
  if(op === "addpunch"){ ensureSheets(); const rec = payload.record || payload; return jsonOut(appendPunch(rec)); }
  if(op === "setemps"){ ensureSheets(); writeEmps(payload.rows || []); return jsonOut({ ok:true, n:(payload.rows || []).length }); }
  if(op === "setschedule"){ ensureSheets(); return jsonOut(writeSchedule(payload.ym, payload.rows || [], { start:(payload.start !== false) })); }
  if(op === "addleave"){ ensureSheets(); const rec = payload.record || payload; return jsonOut(appendLeave(rec)); }
  if(op === "setleave"){ ensureSheets(); return jsonOut(setLeave(payload.no, payload.status, payload.note)); }
  if(op === "addot"){ ensureSheets(); const rec = payload.record || payload; return jsonOut(appendOt(rec)); }
  if(op === "setot"){ ensureSheets(); return jsonOut(setOt(payload.no, payload.status, payload.note)); }
  if(op === "adcomp"){ ensureSheets(); const rec = payload.record || payload; return jsonOut(appendComp(rec)); }
  if(op === "setcomp"){ ensureSheets(); return jsonOut(setComp(payload.no, payload.status, payload.note, payload.cash)); }
  if(op === "setMonthClose"){ return jsonOut(setMonthClose(payload.enabled)); }
  return jsonOut({ error:"unknown op: " + op });
}

// ---------- 輸出工具 ----------
function jsonOut(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
/* JSONP 輸出。`callback` 來自網址，屬**不可信輸入** → 必須白名單：
   只接受合法 JS 識別字（1~64 字元、首字非數字）。不符者視同未提供，回純 JSON。
   不驗證的後果：`?callback=alert(1)//` 會讓端點變成反射型 XSS 載體。
   主系統產生的名字是 `__hrpcb<時間戳><亂數>`，必定通過。 */
function jsonpOut(e, obj){
  const cb = (e && e.parameter && e.parameter.callback);
  const safe = cb && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(String(cb));
  if(safe) return ContentService.createTextOutput(cb + "(" + JSON.stringify(obj) + ")").setMimeType(ContentService.MimeType.JAVASCRIPT);
  return jsonOut(obj);
}
