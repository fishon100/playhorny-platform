// 規格書：把示意圖的「註解模式」（html 裡的 var SPECS = {...}，可選的 var ORDER = [...]）轉成 Markdown，
// 讓規格書在管理台、GitHub 看得到、每一版的差異比得出來，AI 也拿它對照規則書。
// 用法：node tools/specsheet.mjs <示意圖.html> [輸出.md]
//   沒給輸出檔：寫到 docs/企劃/規格書/<示意圖檔名>_規格書.md
// 支援一般 html 與 Claude Design 的打包檔（standalone，頁面藏在 __bundler/template 裡）
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import vm from "node:vm";

/** Claude Design 打包檔：取出真正的頁面；不是打包檔就原樣回傳 */
export function pageFromBundle(html) {
  const m = html.match(/<script type="__bundler\/template">\s*([\s\S]*?)\s*<\/script>/);
  if (!m) return html;
  try { return JSON.parse(m[1]); } catch { return html; }
}

// 從 start 開始，找出成對的括號（略過字串裡的括號）
function balanced(src, start, open, close) {
  let depth = 0, quote = "";
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}
// 只執行物件字面值（沒有任何全域可用、限時），不執行頁面其他程式
const literal = text => JSON.parse(JSON.stringify(vm.runInNewContext(`(${text})`, Object.create(null), { timeout: 1000 })));   // 轉成一般資料（沙盒裡建的物件不是這邊的 Array）

/** 讀出 SPECS 與 ORDER；沒有註解模式回傳 null */
export function specsFromHtml(html) {
  const page = pageFromBundle(html);
  const s = page.search(/var\s+SPECS\s*=\s*\{/);
  if (s < 0) return null;
  const specs = literal(balanced(page, page.indexOf("{", s), "{", "}"));
  const o = page.search(/var\s+ORDER\s*=\s*\[/);
  const order = o >= 0 ? literal(balanced(page, page.indexOf("[", o), "[", "]")) : Object.keys(specs).map(k => [k, ""]);
  const title = ((page.match(/<title>([^<]*)<\/title>/i) || [])[1] || "").replace(/\s+—.*$/, "").trim();
  return { specs, order, title };
}

const strip = s => String(s ?? "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").trim();
const cell = s => strip(s).replace(/\|/g, "／");

/** 轉成 Markdown（照 ORDER 的順序，每個版位一節） */
export function specsToMarkdown({ specs, order, title }, { source = "" } = {}) {
  const out = [`# ${title || "示意圖"} 規格書`, "",
    `> 由 \`tools/specsheet.mjs\` 從示意圖的「註解模式」自動產生${source ? `（來源：\`${source}\`）` : ""}。**不要手改這份**：改示意圖的規格後重新產生。`, ""];
  const ids = [...order.map(o => o[0]).filter(id => specs[id]), ...Object.keys(specs).filter(id => !order.some(o => o[0] === id))];
  out.push("## 目錄", "", ...ids.map((id, i) => `${i + 1}. ${strip(specs[id].title)}${(order.find(o => o[0] === id) || [])[1] ? `：${strip(order.find(o => o[0] === id)[1])}` : ""}`), "");
  ids.forEach((id, i) => {
    const s = specs[id];
    out.push(`## ${i + 1}. ${strip(s.title)}`, "");
    if (s.crumb?.length) out.push(`位置：${s.crumb.map(strip).join(" › ")}`, "");
    for (const sec of s.sections || []) {
      if (sec.title && sec.title !== "undefined" && strip(sec.title)) out.push(`### ${strip(sec.title)}`, "");
      if (sec.type === "text") out.push(strip(sec.body), "");
      else if (sec.type === "list") out.push(...(sec.items || []).map((it, n) => `${n + 1}. ${strip(it)}`), "");
      else if (sec.type === "states") out.push(...(sec.items || []).map(kv => `- **${strip(kv[0])}** — ${strip(kv[1])}`), "");
      else if (sec.type === "table") out.push(`| ${(sec.head || []).map(cell).join(" | ")} |`, `| ${(sec.head || []).map(() => "---").join(" | ")} |`, ...(sec.rows || []).map(r => `| ${r.map(cell).join(" | ")} |`), "");
      else if (sec.type === "code") out.push("```", strip(sec.body), "```", "");
      else if (sec.body) out.push(strip(sec.body), "");
    }
  });
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

// 指令列
if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  const [src, dest] = process.argv.slice(2);
  if (!src) { console.error("用法：node tools/specsheet.mjs <示意圖.html> [輸出.md]"); process.exit(1); }
  const parsed = specsFromHtml(readFileSync(src, "utf8"));
  if (!parsed) { console.error("這份 html 沒有註解模式（找不到 var SPECS = {...}）"); process.exit(2); }
  const out = dest || join("docs/企劃/規格書", basename(src).replace(/\.html?$/i, "") + "_規格書.md");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, specsToMarkdown(parsed, { source: src.replace(/\\/g, "/") }) + "\n");
  console.log(`規格書：${Object.keys(parsed.specs).length} 個版位 → ${out}`);
}
