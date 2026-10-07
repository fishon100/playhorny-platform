// 工作台：提案解析、同意勾選、狀態判斷。執行：node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTasks, approveTasks, parseProposal, statusOf, readSpectra, approvalIssueBody, indexContent, ISSUE_MARKER_RE, ISSUE_APPROVE_RE } from "../tools/workbench/lib.mjs";

const TASKS = `## 0. 企劃確認

- [ ] 0.1 企劃確認：讀過 proposal，同意開始實作

## 1. 測試

- [x] 1.1 先寫會失敗的測試
- [ ] 1.2 實作
`;

test("任務：0.1 不算進度，其餘算完成數", () => {
  const t = parseTasks(TASKS);
  assert.equal(t.total, 2);
  assert.equal(t.done, 1);
  assert.equal(t.hasApprovalItem, true);
  assert.equal(t.approved, false);
  assert.equal(t.next, "1.2 實作");
});

test("同意：只勾 0.1、加註來源；已勾過不重複加註", () => {
  const once = approveTasks(TASKS, "企劃於 GitHub Issue #3 同意，2026-10-06");
  assert.match(once, /^- \[x\] 0\.1 .*（企劃於 GitHub Issue #3 同意，2026-10-06）$/m);
  assert.match(once, /^- \[ \] 1\.2 實作$/m);
  assert.equal(approveTasks(once, "另一次"), once);
  assert.equal(parseTasks(once).approvalNote, "企劃於 GitHub Issue #3 同意，2026-10-06");
});

test("狀態：待同意 → 已同意 → 製作中 → 待驗收 → 已完成", () => {
  const t = (done, total, approved) => ({ hasApprovalItem: true, approved, done, total });
  assert.equal(statusOf({ archived: false, tasks: t(0, 3, false) }), "待同意");
  assert.equal(statusOf({ archived: false, tasks: t(0, 3, true) }), "已同意");
  assert.equal(statusOf({ archived: false, tasks: t(1, 3, true) }), "製作中");
  assert.equal(statusOf({ archived: false, tasks: t(3, 3, true) }), "待驗收");
  assert.equal(statusOf({ archived: true, tasks: t(3, 3, true) }), "已完成");
});

test("提案：讀中文標題、為什麼、需要企劃確認的事、BREAKING", () => {
  const p = parseProposal(`> 中文標題：滑板全寬移動\n\n## Why\n\n滑板只能在中間移動。\n\n## What Changes\n\n- **BREAKING** 範圍改成全寬\n\n## 需要企劃確認的事\n\n- 寬度要 112 嗎？\n`, "x");
  assert.equal(p.title, "滑板全寬移動");
  assert.equal(p.why, "滑板只能在中間移動。");
  assert.equal(p.confirm, "- 寬度要 112 嗎？");
  assert.equal(p.breaking, true);
});

test("讀資料夾：進行中、已完成（日期與代號分開）、規則書條數", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-"));
  const S = join(root, "docs/spectra");
  mkdirSync(join(S, "changes/paddle-wide"), { recursive: true });
  writeFileSync(join(S, "changes/paddle-wide/tasks.md"), TASKS);
  writeFileSync(join(S, "changes/paddle-wide/proposal.md"), "## Why\n\n滑板太小。\n");
  mkdirSync(join(S, "changes/archive/2026-10-05-old-one"), { recursive: true });
  writeFileSync(join(S, "changes/archive/2026-10-05-old-one/tasks.md"), "- [x] 1.1 做完\n");
  mkdirSync(join(S, "specs/catch-ball"), { recursive: true });
  writeFileSync(join(S, "specs/catch-ball/spec.md"), "## Purpose\n\nx\n\n> 中文：接球遊戲\n\n## Requirements\n\n### Requirement: A\n\n#### Scenario: a\n\n#### Scenario: b\n");
  const { changes, specs } = readSpectra(root);
  assert.deepEqual(changes.map(c => [c.id, c.status, c.date]), [["paddle-wide", "待同意", ""], ["old-one", "已完成", "2026-10-05"]]);
  assert.deepEqual(specs.map(s => [s.name, s.purpose, s.requirements, s.scenarios]), [["catch-ball", "接球遊戲", 1, 2]]);
  assert.deepEqual(specs[0].reqs, [{ name: "A", zh: "", scenarios: ["a", "b"] }]);
  assert.deepEqual(changes[0].artifacts, { proposal: true, specs: false, design: false, tasks: true });
});

test("Issue 內文：帶標記與可勾選的「企劃同意」，勾選後能被辨認", () => {
  const body = approvalIssueBody({ id: "paddle-wide", folder: "paddle-wide", why: "因為", what: "改", confirm: "", breaking: false }, "https://github.com/a/b");
  assert.equal(body.match(ISSUE_MARKER_RE)[1], "paddle-wide");
  assert.equal(body.match(ISSUE_APPROVE_RE)[1], " ");
  assert.equal(body.replace("- [ ] 企劃同意", "- [x] 企劃同意").match(ISSUE_APPROVE_RE)[1], "x");
});

test("流程樹：任務依「## 標題」分組", () => {
  const t = parseTasks(TASKS);
  assert.deepEqual(t.groups.map(g => [g.title, g.items.length]), [["0. 企劃確認", 1], ["1. 測試", 2]]);
  assert.equal(t.groups[1].items[0].done, true);
});

test("內容庫：列出文件與圖檔，Markdown 用第一個標題當名稱", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-"));
  mkdirSync(join(root, "docs/企劃/知識庫/角色"), { recursive: true });
  writeFileSync(join(root, "docs/企劃/知識庫/角色/阿鰭.md"), "---\ntags: [x]\n---\n# 阿鰭（角色卡）\n內容");
  writeFileSync(join(root, "docs/企劃/圖.png"), "x");
  writeFileSync(join(root, "docs/企劃/略過.tmp"), "x");
  const idx = indexContent(root);
  assert.deepEqual(idx.map(f => [f.path, f.ext, f.title]), [["docs/企劃/圖.png", "png", "圖"], ["docs/企劃/知識庫/角色/阿鰭.md", "md", "阿鰭（角色卡）"]]);
});

test("技術提案：類型讀得出來，討論串的勾選框是「程式同意」，勾了也辨認得出來", () => {
  const p = parseProposal(`> 中文標題：物理迴圈改固定步長\n> 類型：技術\n\n## Why\n\n手機掉幀時球會穿牆。\n\n## 需要程式確認的事\n\n- 步長 1/120 秒\n`, "x");
  assert.equal(p.kind, "技術");
  assert.match(p.confirm, /1\/120/);   // 「需要程式確認的事」也讀得到
  assert.equal(parseProposal("> 中文標題：加道具\n\n## Why\n\n想要。\n", "y").kind, "企劃");
  const body = approvalIssueBody({ id: "fixed-step", folder: "fixed-step", why: "因為", what: "改", confirm: "", breaking: false, kind: "技術" }, "https://github.com/a/b");
  assert.match(body, /^- \[ \] 程式同意$/m);
  assert.match(body, /技術提案/);
  assert.equal(body.match(ISSUE_APPROVE_RE)[2], "程式");
  assert.equal(body.replace("- [ ] 程式同意", "- [x] 程式同意").match(ISSUE_APPROVE_RE)[1], "x");
});

test("介面向提案：讀得出文件組合、企劃書、示意圖（可以好幾個）；沒寫就是系統向", () => {
  const p = parseProposal(`> 中文標題：遊戲內頁改版\n> 類型：企劃\n> 文件：介面向\n> 企劃書：docs/企劃/企劃書/遊戲內頁.md\n> 示意圖：docs/企劃/示意圖/a.html、docs/企劃/示意圖/b.html\n\n## Why\n\n提升決策效率。\n`, "x");
  assert.equal(p.docs, "介面向");
  assert.equal(p.brief, "docs/企劃/企劃書/遊戲內頁.md");
  assert.deepEqual(p.mockups, ["docs/企劃/示意圖/a.html", "docs/企劃/示意圖/b.html"]);
  const sys = parseProposal("> 中文標題：排行榜快取\n\n## Why\n\n太慢。\n", "y");
  assert.equal(sys.docs, "系統向"); assert.deepEqual(sys.mockups, []);
});

test("內容庫：示意圖（html）也列進來，用 <title> 當名稱", () => {
  const root = mkdtempSync(join(tmpdir(), "mock-"));
  mkdirSync(join(root, "docs/企劃/示意圖"), { recursive: true });
  writeFileSync(join(root, "docs/企劃/示意圖/page.html"), "<!doctype html><title>遊戲下載頁</title><p>hi</p>");
  const f = indexContent(root).find(x => x.ext === "html");
  assert.equal(f.title, "遊戲下載頁");
  assert.equal(f.path, "docs/企劃/示意圖/page.html");
});

test("規格書：可以寫跟示意圖同一個檔（括號是說明，不算路徑）", () => {
  const p = parseProposal("> 中文標題：x\n> 文件：介面向\n> 示意圖：docs/企劃/示意圖/a.html\n> 規格書：docs/企劃/示意圖/a.html（同一個檔案，開註解模式）\n\n## Why\n\n。\n", "x");
  assert.equal(p.specsheet, "docs/企劃/示意圖/a.html");
});
