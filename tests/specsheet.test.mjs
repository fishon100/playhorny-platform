// 規格書：從示意圖的註解模式（var SPECS = {...}）產生 Markdown。執行：node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageFromBundle, specsFromHtml, specsToMarkdown } from "../tools/specsheet.mjs";

const PAGE = `<!doctype html><title>測試頁</title><script>
var SPECS = {
'gallery': { title: '截圖輪播', crumb: ['遊戲內頁', '版位', '截圖'], sections: [
  { type: 'text', title: '用途', body: '展示<strong>實機</strong>截圖' },
  { type: 'list', title: '輪播行為', items: ['左箭頭：上一張；位於第一張時循環至最後一張', '右箭頭：下一張'] },
  { type: 'states', title: '邊界', items: [['僅 1 張', '不顯示箭頭']] },
  { type: 'table', head: ['欄位', '必填'], rows: [['截圖', '必填']] }
] }
};
var ORDER = [['gallery', 'Splide 輪播']];
</script>`;

test("讀出註解模式的規格（一般 html）", () => {
  const s = specsFromHtml(PAGE);
  assert.equal(s.specs.gallery.title, "截圖輪播");
  assert.deepEqual(s.order, [["gallery", "Splide 輪播"]]);
});

test("Claude Design 打包檔（standalone）：先解出頁面再讀規格", () => {
  // 跟真的打包檔一樣：頁面字串裡的「/」寫成 \u002F（不然 </script> 會提早結束）
  const bundle = `<html><body><script type="__bundler/manifest">{}</script>\n<script type="__bundler/template">\n${JSON.stringify(PAGE).replace(/\//g, "\\u002F")}\n</script></body></html>`;
  assert.equal(pageFromBundle(bundle), PAGE);
  assert.equal(specsFromHtml(bundle).specs.gallery.title, "截圖輪播");
});

test("轉成 Markdown：標題、清單、狀態、表格（沒有標題的表格不印 undefined），HTML 標籤拿掉", () => {
  const md = specsToMarkdown(specsFromHtml(PAGE), { source: "docs/企劃/示意圖/x.html" });
  assert.match(md, /^# 測試頁 規格書/m);
  assert.match(md, /## 1\. 截圖輪播/);
  assert.match(md, /展示實機截圖/);
  assert.match(md, /1\. 左箭頭：上一張；位於第一張時循環至最後一張/);
  assert.match(md, /- \*\*僅 1 張\*\* — 不顯示箭頭/);
  assert.match(md, /\| 截圖 \| 必填 \|/);
  assert.doesNotMatch(md, /undefined/);
  assert.match(md, /docs\/企劃\/示意圖\/x\.html/);
});

test("沒有註解模式的 html：回傳 null", () => {
  assert.equal(specsFromHtml("<html><body>hi</body></html>"), null);
});
