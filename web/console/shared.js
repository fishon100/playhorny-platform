// 管理台與 Node 測試共用的純函式：試玩清單的勾選、素材清單（CSV）的修改。不碰畫面、不連網路。

// ---------- 試玩清單（GitHub 討論串裡的勾選框） ----------
const BOX_RE = /^- \[( |x|X)\] .*$/gm;
/** 改第 i 項（從 0 開始）的勾選；勾起來時，之前「❌ 不通過」的標記改成「✅ 修好了」 */
export function setQaItem(body, i, done) {
  let n = -1;
  return body.replace(BOX_RE, line => {
    if (++n !== i) return line;
    const next = line.replace(/^- \[( |x|X)\]/, done ? "- [x]" : "- [ ]");
    return done ? next.replace(/❌ #(\d+)/g, "✅ #$1") : next;
  });
}
/** 讀回試玩清單（跟 tools/workbench/lib.mjs 的 parseQa 一樣） */
export function parseQa(body = "") {
  const items = [...body.matchAll(/^- \[( |x|X)\] (.*)$/gm)].map(m => {
    const done = m[1] !== " ", fails = [...m[2].matchAll(/[❌✅] #(\d+)/g)].map(x => +x[1]);
    return { done, text: m[2].replace(/\s*[❌✅] #\d+/g, "").trim(), fails, fixed: done && fails.length > 0 };
  });
  return { items, total: items.length, done: items.filter(i => i.done).length, failed: items.filter(i => !i.done && i.fails.length).length };
}
/** 第 i 項不通過：取消勾選，後面標上回饋編號（❌ #12） */
export function failQaItem(body, i, issueNumber) {
  let n = -1;
  return body.replace(BOX_RE, line => (++n !== i ? line : `${line.replace(/^- \[( |x|X)\]/, "- [ ]").trimEnd()} ❌ #${issueNumber}`));
}

// ---------- 素材清單（素材.csv） ----------
/** 素材的狀態（照順序）：美術做 → 交件 → 企劃確認 → 採用／退回 → AI 放進遊戲 */
export const ASSET_STATES = ["待製作", "方向稿", "製作中", "待確認", "退回", "已採用", "已放進遊戲"];
export function parseCsv(text) {
  text = text.replace(/^﻿/, ""); const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
/** 依狀態分：美術要做的（含退回）、企劃要確認的、已採用還沒放進遊戲的（跟 tools/workbench/lib.mjs 的 assetSummary 一樣） */
export function assetCounts(rows) {
  const head = rows[0] || [], iS = head.indexOf("狀態"), iN = Math.max(0, head.indexOf("檔名"));
  const body = rows.slice(1).filter(r => r.some(Boolean) && iS >= 0 && r[iS]);
  const names = test => body.filter(r => test(r[iS].trim())).map(r => r[iN]);
  return {
    toMake: names(s => !/^(待確認|已採用|已放進遊戲|完成|已完成)$/.test(s)),
    toReview: names(s => s === "待確認"),
    toPlace: names(s => s === "已採用"),
    returned: names(s => /退回|修改|重做/.test(s)),
  };
}
export function toCsv(rows, { bom = false, eol = "\n" } = {}) {
  const cell = v => (/[",\r\n]/.test(v ?? "") ? `"${String(v).replace(/"/g, '""')}"` : v ?? "");
  return (bom ? "﻿" : "") + rows.map(r => r.map(cell).join(",") + eol).join("");
}
/**
 * 改素材清單的某一列（rowIndex：含標題列的列號）。expectName 是畫面上看到的檔名：對不上表示清單剛被別人改過，就不寫。
 * 沒有「交件」「意見」欄位會自動加在最後面；BOM 與換行照原本的。
 */
export function updateAssetRow(text, rowIndex, expectName, changes) {
  const rows = parseCsv(text), head = rows[0] || [];
  const iName = Math.max(0, head.indexOf("檔名"));
  if (!rows[rowIndex] || rows[rowIndex][iName] !== expectName) throw new Error("素材清單剛被改過，請重新整理後再試一次");
  for (const col of ["交件", "意見", ...Object.keys(changes)]) if (!head.includes(col)) head.push(col);
  for (const r of rows.slice(1)) while (r.length < head.length) r.push("");
  for (const [k, v] of Object.entries(changes)) rows[rowIndex][head.indexOf(k)] = v;
  return toCsv(rows, { bom: text.startsWith("﻿"), eol: text.includes("\r\n") ? "\r\n" : "\n" });
}
