// 工作台同步（GitHub Actions 執行；本機要跑需設 GITHUB_TOKEN、GITHUB_REPOSITORY）
//  1. Issue 裡勾了「企劃同意」（技術提案是「程式同意」）→ 把 tasks.md 的 0.1 打勾並註明來源（之後由 workflow commit）
//  2. 每張待同意的提案都有一個「提案」Issue（沒有就開，企劃在手機就能看、能勾）
//  3. 已同意的 Issue 貼「已同意」標籤；已完成的提案把 Issue 關掉
//  3b. 做完（待驗收）的提案開「試玩清單」討論串（QA／企劃一項一項勾）；全部勾完貼「試玩通過」；已完成就關掉
//  4. 產生工作台資料 workbench-out/data.json（由 workflow 推到 workbench-data 分支）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { readSpectra, approveTasks, approvalIssueBody, indexContent, approverOf, ISSUE_MARKER_RE, ISSUE_APPROVE_RE, qaItems, qaIssueBody, parseQa, assetSummary, QA_MARKER_RE, QA_ALWAYS, PLAN_STAGES } from "./lib.mjs";

const root = process.cwd();
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (!repo || !token) { console.error("需要 GITHUB_REPOSITORY 與 GITHUB_TOKEN"); process.exit(1); }
const cfg = existsSync("workbench.config.json") ? JSON.parse(readFileSync("workbench.config.json", "utf8")) : {};
const specDir = cfg.spec_dir || "docs/spectra";
// 企劃文件流（平台專案）：提案直接放在 spec_dir（docs/提案）；沒有同意、提案 Issue、試玩清單
const planning = cfg.flow === "planning";
const changesDir = planning ? specDir : `${specDir}/changes`;
const readOpts = { flow: planning ? "planning" : "game", changesDir: planning ? specDir : undefined };
const repoUrl = `https://github.com/${repo}`;
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });

async function gh(path, init = {}) {
  const r = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  if (!r.ok && r.status !== 422) throw new Error(`${init.method || "GET"} ${path} → ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}
const post = (p, body, method = "POST") => gh(p, { method, body: JSON.stringify(body) });

const LABELS = { 提案: "5319e7", 技術: "6f42c1", 已同意: "0e8a16", 需求: "1d76db", 回饋: "d93f0b", 試玩: "fbca04", 試玩通過: "0e8a16" };
for (const [name, color] of Object.entries(LABELS)) await post("/labels", { name, color }); // 已存在會回 422，忽略

// ---- 1. 同意：任何一個提案 Issue 勾了「企劃同意」，就把 tasks.md 0.1 打勾 ----
// Issue 清單用 GraphQL：REST 的清單會延遲好幾分鐘（剛開的 Issue 看不到 → 重複開）
async function listIssues() {
  const [owner, name] = repo.split("/");
  const q = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issues(first:100,orderBy:{field:CREATED_AT,direction:DESC}){nodes{
    number title body state url createdAt author{login} comments{totalCount} labels(first:20){nodes{name}} assignees(first:10){nodes{login}} }}}}`;
  const r = await fetch("https://api.github.com/graphql", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: q, variables: { owner, name } }) });
  const j = await r.json();
  if (!r.ok || j.errors) throw new Error(`GraphQL issues → ${r.status} ${JSON.stringify(j.errors || j).slice(0, 300)}`);
  // 轉成跟 REST 一樣的欄位，後面的程式不用改
  return j.data.repository.issues.nodes.map(i => ({
    number: i.number, title: i.title, body: i.body, state: i.state.toLowerCase(), html_url: i.url, created_at: i.createdAt,
    user: { login: i.author?.login }, comments: i.comments.totalCount, labels: i.labels.nodes.map(l => ({ name: l.name })), assignees: i.assignees.nodes,
  }));
}
let allIssues = await listIssues();
// 同一張提案有好幾個 Issue（幾個同步同時跑、GitHub 清單還沒更新時會發生）：留最早的，其餘關掉
{
  const first = new Map();
  for (const i of [...allIssues].sort((a, b) => a.number - b.number)) {
    // 提案的討論串用提案名稱；試玩清單用「qa:提案名稱」
    const b = i.body || "", qa = b.match(QA_MARKER_RE)?.[1], id = b.match(ISSUE_MARKER_RE)?.[1] || (qa && "qa:" + qa); if (!id) continue;
    if (!first.has(id)) { first.set(id, i.number); continue; }
    if (i.state === "open") {
      await post(`/issues/${i.number}/comments`, { body: `重複了，請看 #${first.get(id)}。` });
      await post(`/issues/${i.number}`, { state: "closed", state_reason: "not_planned" }, "PATCH");
      console.log(`關掉重複的 Issue #${i.number}（留 #${first.get(id)}）`);
    }
    i.duplicate = true;
  }
  allIssues = allIssues.filter(i => !i.duplicate);
}
const changed = [];
let { changes } = readSpectra(root, specDir, readOpts);
if (!planning) {
const hasLabel = (i, name) => i.labels?.some(l => (l.name || l) === name);
const setBox = async (issue, checked) => {
  issue.body = issue.body.replace(ISSUE_APPROVE_RE, (m, x, who) => `- [${checked ? "x" : " "}] ${who}同意`);
  await post(`/issues/${issue.number}`, { body: issue.body }, "PATCH");
};
for (const issue of allIssues) {
  const id = (issue.body || "").match(ISSUE_MARKER_RE)?.[1];
  const c = id && changes.find(x => x.id === id && !x.archived);
  if (!c || !c.tasks.hasApprovalItem || issue.state !== "open") continue;
  const boxChecked = (issue.body || "").match(ISSUE_APPROVE_RE)?.[1]?.toLowerCase() === "x";
  if (c.tasks.approved) {
    // 在 Spectra 桌面版或對話中同意：把 Issue 的勾也補上，兩邊一致
    if (!boxChecked) {
      await setBox(issue, true);
      await post(`/issues/${issue.number}/comments`, { body: `✅ 已同意（${c.tasks.approvalNote || "在 Spectra 桌面版或對話中"}）。` });
    }
    continue;
  }
  if (hasLabel(issue, "已同意")) {
    // 提案改過、0.1 被取消：請同意的人（企劃／程式）重新確認
    await setBox(issue, false);
    await gh(`/issues/${issue.number}/labels/${encodeURIComponent("已同意")}`, { method: "DELETE" }).catch(() => {});
    issue.labels = issue.labels.filter(l => (l.name || l) !== "已同意");
    await post(`/issues/${issue.number}`, { body: approvalIssueBody(c, repoUrl, specDir) }, "PATCH");
    await post(`/issues/${issue.number}/comments`, { body: `🔄 提案 \`${c.id}\` 有修改，已把「${approverOf(c.kind)}同意」取消。請看上面更新後的內容，沒問題再勾一次。` });
    console.log(`重新確認：${c.id}（Issue #${issue.number}）`);
    continue;
  }
  if (!boxChecked) {
    // 還沒同意、提案內容改過（例如企劃給了新版示意圖）：討論串換成最新內容，留言說一聲
    const fresh = approvalIssueBody(c, repoUrl, specDir);
    if ((issue.body || "").replace(/\r/g, "").trim() !== fresh.trim()) {
      await post(`/issues/${issue.number}`, { body: fresh }, "PATCH");
      await post(`/issues/${issue.number}/comments`, { body: `📝 提案 \`${c.id}\` 的內容更新了，上面已換成最新版本（為什麼、改什麼、需要${approverOf(c.kind)}確認的事）。` });
      console.log(`更新提案內容：${c.id}（Issue #${issue.number}）`);
    }
    continue;
  }
  const f = join(root, specDir, "changes", c.folder, "tasks.md");
  writeFileSync(f, approveTasks(readFileSync(f, "utf8"), `${approverOf(c.kind)}於 GitHub Issue #${issue.number} 同意，${today}`));
  changed.push(f);
  await post(`/issues/${issue.number}/labels`, { labels: ["已同意"] });
  await post(`/issues/${issue.number}/comments`, { body: `✅ 已記錄${approverOf(c.kind)}同意：提案 \`${c.id}\` 的任務 0.1 已打勾。對 AI 說「做 ${c.id}」就會開始製作。` });
  console.log(`同意：${c.id}（Issue #${issue.number}）`);
}
if (changed.length) ({ changes } = readSpectra(root, specDir, readOpts));

// ---- 2、3. 提案 Issue：沒有就開；已同意貼標籤；已完成就關 ----
const issueOf = id => allIssues.find(i => (i.body || "").match(ISSUE_MARKER_RE)?.[1] === id);
for (const c of changes) {
  let issue = issueOf(c.id);
  if (!c.archived && !issue) {
    const tech = c.kind === "技術";
    issue = await post("/issues", { title: `${tech ? "技術提案" : "提案"}：${c.title}（${c.id}）`, body: approvalIssueBody(c, repoUrl, specDir), labels: tech ? ["提案", "技術"] : ["提案"] });
    allIssues.push(issue);
    console.log(`開 Issue #${issue.number}：${c.id}`);
  }
  if (!issue) continue;
  if (c.tasks.approved && !issue.labels?.some(l => (l.name || l) === "已同意")) await post(`/issues/${issue.number}/labels`, { labels: ["已同意"] });
  if (c.archived && issue.state === "open") {
    await post(`/issues/${issue.number}/comments`, { body: `🎉 提案 \`${c.id}\` 已完成（${c.date}），規則已併回規則書。` });
    await post(`/issues/${issue.number}`, { state: "closed", state_reason: "completed" }, "PATCH");
    issue.state = "closed";
    console.log(`驗收關閉 Issue #${issue.number}：${c.id}`);
  }
  c.issue = { number: issue.number, url: issue.html_url, state: issue.state, comments: issue.comments };
}

// ---- 3b. 試玩清單 ----
const qaOf = id => allIssues.find(i => (i.body || "").match(QA_MARKER_RE)?.[1] === id);
const playUrl = ((cfg.links || []).find(l => /試玩/.test(l.label)) || (cfg.links || [])[0])?.url || "";
for (const c of changes) {
  let qa = qaOf(c.id);
  if (!c.archived && c.status === "待驗收" && !qa) {
    qa = await post("/issues", { title: `試玩清單：${c.title}（${c.id}）`, body: qaIssueBody(c, qaItems(c, cfg.qa_always || QA_ALWAYS), repoUrl, specDir, playUrl), labels: ["試玩"] });
    allIssues.push(qa);
    console.log(`開試玩清單 #${qa.number}：${c.id}`);
  }
  if (!qa) continue;
  const q = parseQa(qa.body || "");
  if (c.archived && qa.state === "open") {
    await post(`/issues/${qa.number}/comments`, { body: `🎉 提案 \`${c.id}\` 已驗收通過（${c.date}）。` });
    await post(`/issues/${qa.number}`, { state: "closed", state_reason: "completed" }, "PATCH");
    qa.state = "closed";
  } else if (!c.archived && q.total && q.done === q.total && !hasLabel(qa, "試玩通過")) {
    await post(`/issues/${qa.number}/labels`, { labels: ["試玩通過"] });
    await post(`/issues/${qa.number}/comments`, { body: `✅ 試玩清單 ${q.total} 項全部通過。企劃確認後對 AI 說「${c.id} 驗收通過」。` });
    qa.labels = [...(qa.labels || []), { name: "試玩通過" }];
  }
  c.qa = { number: qa.number, url: qa.html_url, state: qa.state, ...q };
}

}

// ---- 4. 工作台資料 ----
const pick = label => allIssues.filter(i => i.labels?.some(l => (l.name || l) === label))
  .map(i => ({ number: i.number, title: i.title, url: i.html_url, state: i.state, created: i.created_at, user: i.user?.login, labels: i.labels.map(l => l.name || l), comments: i.comments, assignees: (i.assignees || []).map(a => a.login) }));
const commits = execSync('git log -15 --date=iso-strict --pretty=format:%H%x1f%ad%x1f%an%x1f%s', { encoding: "utf8" })
  .split("\n").filter(Boolean).map(l => { const [sha, date, author, subject] = l.split("\x1f"); return { sha: sha.slice(0, 7), date, author, subject, url: `${repoUrl}/commit/${sha}` }; });
const allRuns = (await gh("/actions/runs?per_page=30").catch(() => ({ workflow_runs: [] }))).workflow_runs;
// 開著的 PR（給程式審查）
const pulls = (await gh("/pulls?state=open&per_page=30").catch(() => []))
  .map(p => ({ number: p.number, title: p.title, url: p.html_url, user: p.user?.login, created: p.created_at, draft: p.draft, branch: p.head?.ref }));
const runs = allRuns
  .filter(r => r.name !== "workbench").slice(0, 5)
  .map(r => ({
    name: { "test-and-deploy": "自動測試＋部署", "pages build and deployment": "網站部署", "test-web": "網頁版自動測試" }[r.name] || r.name,
    status: r.status, conclusion: r.conclusion, date: r.created_at, url: r.html_url,
    title: (r.head_commit?.message || r.display_title || "").split("\n")[0],
  }));
const { specs } = readSpectra(root, specDir, readOpts);
// 素材清單（檔名有「素材」的 CSV）：美術要做、企劃要確認、要放進遊戲的
const content = indexContent(root, cfg.content_dirs || ["docs/企劃"]);
const sheet = content.find(f => f.ext === "csv" && /素材|asset/i.test(f.name));
const assets = sheet ? { path: sheet.path, ...assetSummary(readFileSync(join(root, sheet.path), "utf8")) } : null;
// 私人專案：管理台要用登入碼走 API 讀檔、讀圖
const repoInfo = await gh("").catch(() => ({}));
const data = {
  generatedAt: new Date().toISOString(),
  repo, repoUrl, specDir,
  changesDir,
  flow: planning ? { mode: "planning", stages: PLAN_STAGES } : { mode: "game" },
  private: !!repoInfo.private,
  branch: process.env.GITHUB_REF_NAME && !process.env.GITHUB_REF_NAME.includes("/") ? process.env.GITHUB_REF_NAME : "main",
  contentDirs: cfg.content_dirs || ["docs/企劃"],
  content, assets,
  name: cfg.name || repo.split("/")[1],
  links: cfg.links || [],
  tools: cfg.tools || [], // 專案工具（外掛）：框架以外、這個專案自己的工具
  changes, specs,
  requests: pick("需求"), feedback: pick("回饋"),
  commits, runs, pulls,
};
mkdirSync("workbench-out", { recursive: true });
writeFileSync("workbench-out/data.json", JSON.stringify(data, null, 1));
writeFileSync("workbench-out/changed.txt", changed.join("\n"));
console.log(`工作台資料：提案 ${changes.length}、規則書 ${specs.length}、需求 ${data.requests.length}、回饋 ${data.feedback.length}${planning ? "（企劃文件流）" : ""}`);
