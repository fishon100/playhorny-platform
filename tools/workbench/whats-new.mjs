// 「同步」：企劃回到對話時，AI 先跑這支，把企劃在管理台（或 GitHub、手機）做過、等 AI 接手的事列出來。
// 用法：git pull 之後 node tools/workbench/whats-new.mjs
// 讀：提案狀態（docs/spectra）、GitHub 討論串（gh）、試玩清單、素材清單、管理台送來的修改（git log）、關卡編輯器的修改檔（有的專案才有）
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { readSpectra, ISSUE_MARKER_RE, QA_MARKER_RE, parseQa, assetSummary, indexContent } from "./lib.mjs";

const root = process.cwd();
const cfg = existsSync("workbench.config.json") ? JSON.parse(readFileSync("workbench.config.json", "utf8")) : {};
const sh = cmd => { try { return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
const json = cmd => { try { return JSON.parse(sh(cmd) || "null"); } catch { return null; } };
const STAMP = join(root, ".git", "whats-new-last");               // 上次「同步」的時間（只在這台電腦，不進 git）
const since = existsSync(STAMP) ? readFileSync(STAMP, "utf8").trim() : sh('git log -1 --format=%cI --before="2 days ago"') || "";
const out = [], todo = [];
const section = (title, lines) => { if (lines.length) out.push(`\n■ ${title}`, ...lines.map(l => `  ・${l}`)); };

// 1. 提案
const specDir = cfg.spec_dir || "docs/spectra";
const planning = cfg.flow === "planning";   // 企劃文件流：提案直接放在 spec_dir（例 docs/提案），依階段列出
const { changes } = readSpectra(root, specDir, { flow: planning ? "planning" : "game", changesDir: planning ? specDir : undefined });
const act = changes.filter(c => !c.archived), by = s => act.filter(c => c.status === s);
if (planning) {
  const artDone = c => { const art = c.plan?.stages?.find(s => s.n === 5)?.lanes?.find(l => l.name === "美術")?.items.filter(i => !i.milestone) || []; return art.length > 0 && art.every(i => i.done); };
  section("等需求確認（M1）：需求會議看企劃書＋示意圖", act.filter(c => c.plan?.current === 4).map(c => `${c.title}（${c.id}）`));
  section("美術完成、等規格確認（M2）：補 SPEC、匯出 spec.md", act.filter(c => c.plan?.current === 5 && c.plan.milestones?.M2 && !c.plan.milestones.M2.done && artDone(c)).map(c => `${c.title}（${c.id}）`));
  section("等驗收：照 SPEC 驗收條件逐條驗", act.filter(c => c.plan?.current === 6).map(c => `${c.title}（${c.id}）`));
  section("待歸檔（階段都勾完了，可以搬到 archive）", act.filter(c => c.plan?.stages?.length && c.plan.current == null).map(c => { todo.push(`歸檔 ${c.id}`); return `${c.title}（${c.id}）`; }));
} else {
  const tag = c => (c.kind === "技術" ? "【技術】" : "");
  section("等企劃同意的提案", by("待同意").filter(c => c.kind !== "技術").map(c => `${c.title}（${c.id}）`));
  section("等程式同意的技術提案", by("待同意").filter(c => c.kind === "技術").map(c => `${c.title}（${c.id}）`));
  section("已同意、還沒開始做（可以直接做到上線）", by("已同意").map(c => { todo.push(`做 ${c.id}`); return `${tag(c)}${c.title}（${c.id}）・${c.tasks.approvalNote || "已同意"}`; }));
  section("製作中", by("製作中").map(c => { todo.push(`繼續做 ${c.id}`); return `${tag(c)}${c.title}（${c.id}）・任務 ${c.tasks.done}/${c.tasks.total}・下一步：${c.tasks.next}`; }));
  // 試玩清單（GitHub 討論串，標籤「試玩」）：進度、不通過的項目
  const qaIssues = json("gh issue list --label 試玩 --state open --limit 50 --json number,body,url") || [];
  const qaOf = c => { const i = qaIssues.find(x => (x.body || "").match(QA_MARKER_RE)?.[1] === c.id); return i && { number: i.number, ...parseQa(i.body) }; };
  const qaLine = c => { const q = qaOf(c); if (!q) return "試玩清單還沒建立（推上去約 1 分鐘後會自動開）"; const bad = q.items.filter(i => !i.done && i.fails.length);
    bad.forEach(i => todo.push(`修試玩不通過：${c.id}「${i.text}」（回饋 ${i.fails.map(n => "#" + n).join("、")}）`));
    return `試玩清單 #${q.number}：${q.done}/${q.total}${bad.length ? `，不通過：${bad.map(i => `「${i.text}」${i.fails.map(n => "#" + n).join("、")}`).join("；")}` : q.done === q.total ? "，全部通過 → 可以問企劃要不要驗收" : ""}`; };
  section("做完了，等試玩驗收", by("待驗收").filter(c => c.kind !== "技術").map(c => `${c.title}（${c.id}）・${qaLine(c)}`));
  section("技術提案做完了，等程式確認", by("待驗收").filter(c => c.kind === "技術").map(c => `${c.title}（${c.id}）・${qaLine(c)}・PR 合併、測試通過後說「${c.id} 驗收通過」`));
}

// 素材清單（檔名有「素材」的 CSV）：美術交件了等企劃確認；企劃採用了要放進遊戲
const sheet = indexContent(root, cfg.content_dirs || ["docs/企劃"]).find(f => f.ext === "csv" && /素材|asset/i.test(f.name));
if (sheet) {
  const a = assetSummary(readFileSync(join(root, sheet.path), "utf8"));
  section("美術交件了，等企劃確認（素材庫按採用／退回，或在對話中說）", a.toReview);
  section("企劃採用了，要放進遊戲（放好後清單狀態改「已放進遊戲」）", a.toPlace);
  if (a.toReview.length) todo.push(`請企劃確認 ${a.toReview.length} 個素材`);
  if (a.toPlace.length) todo.push(`把 ${a.toPlace.length} 個已採用的素材放進遊戲`);
}

// 2. GitHub 討論串：提案的新留言（最後一則是人留的）、還沒處理的回饋與需求
const issues = json("gh issue list --state open --limit 100 --json number,title,labels,body,url") || [];
const bot = a => !a || /\[bot\]$|^github-actions/.test(a);
const notes = [];
for (const i of issues.filter(i => ISSUE_MARKER_RE.test(i.body || ""))) {
  const cm = (json(`gh issue view ${i.number} --json comments`) || {}).comments || [];
  const last = cm.filter(c => !/^(👍|✅|🔄|🎉)/.test(c.body || "")).at(-1);
  if (last && !bot(last.author?.login) && (!since || last.createdAt > since)) {
    const id = (i.body.match(ISSUE_MARKER_RE) || [])[1];
    notes.push(`#${i.number} ${id}：${last.author.login} 留言「${(last.body || "").replace(/\s+/g, " ").slice(0, 60)}」`);
    todo.push(`看提案 ${id} 的留言`);
  }
}
section("提案討論串有新留言（照留言改提案）", notes);
const lab = (i, n) => (i.labels || []).some(l => l.name === n);
section("還沒處理的回饋", issues.filter(i => lab(i, "回饋")).map(i => { todo.push(`把 #${i.number} 開成提案（或直接修）`); return `#${i.number} ${i.title}`; }));
section("還沒處理的需求", issues.filter(i => lab(i, "需求")).map(i => { todo.push(`把 #${i.number} 開成提案`); return `#${i.number} ${i.title}`; }));

// 2b. 等程式審查的 PR（技術提案做完開的 PR，或程式自己開的）
const pulls = json("gh pr list --state open --limit 50 --json number,title,author,isDraft,headRefName,reviewDecision") || [];
section("等程式審查的 PR", pulls.map(p => `#${p.number} ${p.title}（${p.headRefName}${p.isDraft ? "・草稿" : ""}${p.reviewDecision === "APPROVED" ? "・已核准，可以合併" : p.reviewDecision === "CHANGES_REQUESTED" ? "・程式要求修改" : ""}）`));
pulls.filter(p => p.reviewDecision === "CHANGES_REQUESTED").forEach(p => todo.push(`照程式的意見修 PR #${p.number}`));

// 3. 管理台送來的修改（commit 訊息有「管理台」）：同意、編輯文件、上傳素材
const log = since ? sh(`git log --since="${since}" --format=%h%x09%an%x09%s`) : "";
// 管理台寫入的 commit 會帶「（管理台，帳號）」；在 GitHub 討論串勾同意由 Action 寫入（「來自 GitHub Issue」）
const fromConsole = log.split("\n").filter(l => /（管理台，|來自 GitHub Issue/.test(l)).map(l => { const [h, a, s] = l.split("\t"); return `${s}（${a}，${h}）`; });
section("在管理台做的修改（上次同步之後）", fromConsole);
if (fromConsole.some(s => /內容：|素材：/.test(s)) && existsSync("tools/vault-mirror.mjs")) todo.push("企劃文件同步回 Obsidian（node tools/vault-mirror.mjs）");

// 4. 關卡編輯器送出、還沒套用的修改（有關卡編輯器的專案）
const ED = join(root, "tools", "levels", "edits");
if (existsSync(ED)) {
  const files = readdirSync(ED).filter(f => f.endsWith(".json")).sort();
  section("關卡編輯器送出、還沒套用", files.map(f => { const e = JSON.parse(readFileSync(join(ED, f), "utf8")); return `${f}${e.note ? `「${e.note}」` : ""}：第 ${Object.keys(e.stages || {}).join("、") || "—"} 關${Object.keys(e.layouts || {}).length ? `、台面 ${Object.keys(e.layouts).join("、")}` : ""}`; }));
  if (files.length) todo.push("套用關卡修改");
}

console.log(`同步：${cfg.name || root}${since ? `（上次同步 ${since.slice(0, 16).replace("T", " ")}）` : ""}`);
console.log(out.length ? out.join("\n") : "\n沒有等 AI 接手的事。");
if (todo.length) console.log(`\n建議接著做：\n${[...new Set(todo)].map(t => `  → ${t}`).join("\n")}`);
if (!process.argv.includes("--dry")) { mkdirSync(join(root, ".git"), { recursive: true }); writeFileSync(STAMP, new Date().toISOString()); }
