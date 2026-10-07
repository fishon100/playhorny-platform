// tests/planning.test.mjs — 企劃文件流：tasks.md 章節＝階段、### ＝並行線、M1／M2＝里程碑
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStages, planStatus, PLAN_STAGES, parseProposal, readSpectra } from "../tools/workbench/lib.mjs";

const TASKS = `## 1. 需求
- [x] 1.1 需求來源：Notion 需求池
## 2. 企劃書
- [x] 2.1 Notion 撰寫企劃書（v1.1）
## 3. 示意圖
- [x] 3.1 示意圖 v21
## 4. 需求確認 ◆
- [x] M1 需求確認：企劃書 v1.1＋示意圖 v21（2026-10-07，需求會議）
## 5. 並行製作
### 美術
- [ ] 5.1 視覺稿（完成約九成時通知企劃）
- [ ] M2 規格確認：SPEC 定稿、匯出 spec.md
### 後端
- [x] 5.2 開工單
- [ ] 5.3 後端完成
### 前端
- [ ] 5.4 開工單
## 6. 驗收
- [ ] 6.1 照 SPEC 驗收條件逐條驗
`;

test("階段：章節編號＝階段，第一個沒做完的章節是目前階段", () => {
  const p = parseStages(TASKS);
  assert.equal(p.stages.length, 6);
  assert.deepEqual(p.stages.map(s => s.n), [1, 2, 3, 4, 5, 6]);
  assert.equal(p.stages[3].title, "需求確認");          // ◆ 會被拿掉
  assert.equal(p.current, 5);
  assert.equal(p.total, 10);
  assert.equal(p.done, 5);
});

test("並行線：### 是第 5 階段的線，各自算進度；沒有 ### 的章節只有一條無名線", () => {
  const s5 = parseStages(TASKS).stages.find(s => s.n === 5);
  assert.deepEqual(s5.lanes.map(l => l.name), ["美術", "後端", "前端"]);
  assert.deepEqual(s5.lanes.map(l => `${l.done}/${l.total}`), ["0/2", "1/2", "0/1"]);
  const s1 = parseStages(TASKS).stages.find(s => s.n === 1);
  assert.equal(s1.lanes.length, 1);
  assert.equal(s1.lanes[0].name, "");
});

test("里程碑：M1／M2 開頭的項目，勾了就讀括號裡的註記", () => {
  const { milestones } = parseStages(TASKS);
  assert.equal(milestones.M1.done, true);
  assert.equal(milestones.M1.note, "2026-10-07，需求會議");
  assert.equal(milestones.M1.stage, 4);
  assert.equal(milestones.M2.done, false);
  assert.equal(milestones.M2.note, "");
  assert.equal(milestones.M2.stage, 5);
});

test("狀態：目前階段的名稱；全部勾完＝待歸檔；archive＝已完成", () => {
  const p = parseStages(TASKS);
  assert.equal(planStatus(false, p), "並行製作");
  assert.equal(planStatus(false, parseStages(TASKS.replace(/- \[ \]/g, "- [x]"))), "待歸檔");
  assert.equal(planStatus(true, p), "已完成");
  assert.equal(PLAN_STAGES.find(s => s.n === 4).milestone, "M1");
});

test("CRLF 的 tasks.md（Windows）結果跟 LF 一樣", () => {
  const p = parseStages(TASKS.replace(/\n/g, "\r\n"));
  assert.equal(p.current, 5);
  assert.equal(p.total, 10);
  assert.equal(p.done, 5);
  assert.equal(p.milestones.M1.note, "2026-10-07，需求會議");
});

const PROPOSAL = `> 中文標題：遊戲內頁改版
> 類型：優化
> 基於：game-page-redesign
> 文件：介面向
> 企劃書：https://app.notion.com/p/38711c058c2d8030b36bc9d6bdf36fa3（v1.1）
> 示意圖：docs/提案/game-page-v2/示意圖/遊戲內頁_v22.html
> 設計稿：https://claude.ai/design/p/abc

## 為什麼

舊版不好用。
`;

test("提案：優化案讀得到「基於」，設計稿與企劃書連結原樣保留", () => {
  const p = parseProposal(PROPOSAL, "game-page-v2");
  assert.equal(p.optimize, true);
  assert.equal(p.base, "game-page-redesign");
  assert.equal(p.design, "https://claude.ai/design/p/abc");
  assert.equal(p.brief, "https://app.notion.com/p/38711c058c2d8030b36bc9d6bdf36fa3（v1.1）");
  assert.equal(p.docs, "介面向");
  assert.equal(parseProposal("## Why\n\nx\n", "a").optimize, false);
});

test("readSpectra 企劃模式：提案直接放在 docs/提案/<id>，有 plan 與階段狀態；archive 是已完成", () => {
  const root = mkdtempSync(join(tmpdir(), "plan-"));
  mkdirSync(join(root, "docs/提案/game-page-redesign"), { recursive: true });
  writeFileSync(join(root, "docs/提案/game-page-redesign/proposal.md"), PROPOSAL);
  writeFileSync(join(root, "docs/提案/game-page-redesign/tasks.md"), TASKS);
  mkdirSync(join(root, "docs/提案/archive/2026-09-01-old"), { recursive: true });
  writeFileSync(join(root, "docs/提案/archive/2026-09-01-old/tasks.md"), "## 7. 完成\n- [x] 7.1 歸檔\n");
  const { changes, specs } = readSpectra(root, "docs/提案", { flow: "planning", changesDir: "docs/提案" });
  assert.equal(specs.length, 0);
  const c = changes.find(x => x.id === "game-page-redesign");
  assert.equal(c.status, "並行製作");
  assert.equal(c.plan.current, 5);
  assert.equal(c.plan.milestones.M1.done, true);
  const old = changes.find(x => x.id === "old");
  assert.equal(old.archived, true);
  assert.equal(old.status, "已完成");
  assert.equal(old.date, "2026-09-01");
});

import { execFileSync } from "node:child_process";

test("local-data：企劃模式的 data.json 有 flow.stages 與 changesDir，提案帶 plan", () => {
  const root = mkdtempSync(join(tmpdir(), "plan-data-"));
  mkdirSync(join(root, "docs/提案/game-page-redesign"), { recursive: true });
  writeFileSync(join(root, "docs/提案/game-page-redesign/proposal.md"), PROPOSAL);
  writeFileSync(join(root, "docs/提案/game-page-redesign/tasks.md"), TASKS);
  writeFileSync(join(root, "workbench.config.json"), JSON.stringify({ name: "PlayHorny 平台", flow: "planning", spec_dir: "docs/提案", content_dirs: ["docs/企劃"] }));
  const out = JSON.parse(execFileSync(process.execPath, ["tools/workbench/local-data.mjs", root], { encoding: "utf8" }));
  assert.equal(out.flow.mode, "planning");
  assert.equal(out.flow.stages.length, 7);
  assert.equal(out.changesDir, "docs/提案");
  assert.equal(out.name, "PlayHorny 平台");
  assert.equal(out.changes[0].plan.current, 5);
  assert.deepEqual(out.requests, []);
});

test("沒有階段的 tasks.md：stages 空、current null、狀態算「需求」", () => {
  const p = parseStages("");
  assert.equal(p.stages.length, 0);
  assert.equal(p.current, null);
  assert.equal(planStatus(false, parseStages("")), "需求");
});
