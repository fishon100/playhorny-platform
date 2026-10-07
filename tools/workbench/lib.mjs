// 工作台共用：讀 Spectra 的提案與規則書，整理成工作台要的資料。純函式＋讀檔，Node 與測試都用它。
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

export const APPROVAL_RE = /^- \[( |x|X)\] 0\.1 .*$/m;
export const ISSUE_MARKER = name => `<!-- spectra-change: ${name} -->`;
export const ISSUE_MARKER_RE = /<!-- spectra-change: ([a-z0-9][a-z0-9-]*) -->/;
export const ISSUE_APPROVE_RE = /^- \[( |x|X)\] (企劃|程式)同意/m;   // 企劃提案＝企劃同意、技術提案＝程式同意
/** 提案類型 → 誰同意 */
export const approverOf = kind => (kind === "技術" ? "程式" : "企劃");

const read = f => (existsSync(f) ? readFileSync(f, "utf8").replace(/\r/g, "") : "");

/** 依「## 標題」切段落；回傳 { 標題: 內容 } */
export function sections(md) {
  const out = {};
  for (const block of ("\n" + md).split(/\n(?=## )/).slice(1)) {
    const [head, ...rest] = block.split("\n");
    out[head.replace(/^## /, "").trim()] = rest.join("\n").trim();
  }
  return out;
}

/** 任務清單：總數、完成數、企劃是否同意（0.1）、同意的註記 */
export function parseTasks(md) {
  md = md.replace(/\r\n/g, "\n");
  const items = [...md.matchAll(/^- \[( |x|X)\] (.*)$/gm)].map(m => ({ done: m[1] !== " ", text: m[2].trim() }));
  const approvalItem = items.find(t => /^0\.1 /.test(t.text));
  const work = items.filter(t => t !== approvalItem);
  const note = approvalItem?.done ? (approvalItem.text.match(/（([^）]*同意[^）]*)）\s*$/) || [])[1] || "" : "";
  const groups = [];
  for (const line of md.split("\n")) {
    const h = line.match(/^##\s+(.+)/);
    if (h) groups.push({ title: h[1].trim(), items: [] });
    const m = line.match(/^- \[( |x|X)\] (.*)$/);
    if (m) { if (!groups.length) groups.push({ title: "任務", items: [] }); groups.at(-1).items.push({ done: m[1] !== " ", text: m[2].trim() }); }
  }
  return {
    groups: groups.filter(g => g.items.length),
    total: work.length,
    done: work.filter(t => t.done).length,
    hasApprovalItem: !!approvalItem,
    approved: !!approvalItem?.done,
    approvalNote: note,
    next: work.find(t => !t.done)?.text || "",
  };
}

// ---------- 企劃文件流（workbench.config.json 的 flow: "planning"）：平台專案用 ----------
// 階段寫死在這裡，管理台從 data.json 的 flow.stages 讀，兩邊同一份
export const PLAN_STAGES = [
  { n: 1, label: "需求", sub: "需求池／回饋" },
  { n: 2, label: "企劃書", sub: "Notion" },
  { n: 3, label: "示意圖", sub: "介面向才有" },
  { n: 4, label: "需求確認", sub: "M1", milestone: "M1" },
  { n: 5, label: "並行製作", sub: "美術／後端／前端" },
  { n: 6, label: "驗收", sub: "SPEC 驗收條件" },
  { n: 7, label: "完成", sub: "歸檔" },
];
// 里程碑項目：「M1 需求確認：…（2026-10-07，需求會議）」→ 代號、文字、括號裡的註記
export const MILESTONE_RE = /^(M\d)\s+(.*?)(?:（([^）]*)）)?\s*$/;

/** tasks.md → 階段（## N. 標題）、並行線（### 線名）、里程碑（M1／M2）。目前階段＝第一個還有沒勾項目的章節 */
export function parseStages(md) {
  const stages = [];
  let st = null, lane = null;
  for (const line of md.split(/\r?\n/)) {
    const h2 = line.match(/^##\s+(\d+)\.\s*(.+?)\s*$/);
    if (h2) { st = { n: +h2[1], title: h2[2].replace(/\s*◆\s*$/, ""), lanes: [] }; lane = null; stages.push(st); continue; }
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h3 && st) { lane = { name: h3[1], items: [] }; st.lanes.push(lane); continue; }
    const it = line.match(/^- \[( |x|X)\] (.*)$/);
    if (it && st) {
      if (!lane) { lane = { name: "", items: [] }; st.lanes.push(lane); }
      const text = it[2].trim(), done = it[1] !== " ", m = text.match(MILESTONE_RE);
      lane.items.push({ done, text, milestone: m ? m[1] : "", note: m && done ? (m[3] || "") : "" });
    }
  }
  const milestones = {};
  for (const s of stages) {
    for (const l of s.lanes) {
      l.total = l.items.length; l.done = l.items.filter(i => i.done).length;
      for (const i of l.items) if (i.milestone) milestones[i.milestone] = { done: i.done, note: i.note, stage: s.n, text: i.text };
    }
    s.total = s.lanes.reduce((a, l) => a + l.total, 0); s.done = s.lanes.reduce((a, l) => a + l.done, 0);
  }
  return {
    stages, milestones,
    current: stages.find(s => s.done < s.total)?.n ?? null,
    total: stages.reduce((a, s) => a + s.total, 0),
    done: stages.reduce((a, s) => a + s.done, 0),
  };
}

/** 企劃文件流的狀態文字：目前階段的名稱／待歸檔／已完成 */
export function planStatus(archived, plan) {
  if (archived) return "已完成";
  if (!plan.stages.length) return "需求";
  if (plan.current == null) return "待歸檔";
  return PLAN_STAGES.find(s => s.n === plan.current)?.label || `第 ${plan.current} 階段`;
}

/** 把 tasks.md 的 0.1 打勾並加註來源；已經勾過就原樣回傳 */
export function approveTasks(md, note) {
  return md.replace(APPROVAL_RE, line => {
    if (/^- \[[xX]\]/.test(line)) return line;
    return line.replace(/^- \[ \]/, "- [x]").replace(/\s*$/, `（${note}）`);
  });
}

/** proposal.md → 中文標題、為什麼、改什麼、需要企劃確認的事 */
export function parseProposal(md, fallbackName) {
  const s = sections(md);
  const pick = re => Object.entries(s).find(([k]) => re.test(k))?.[1] || "";
  const why = pick(/^(Why|為什麼|Problem)/i);
  const title = (md.match(/中文標題[：:]\s*(.+)/) || [])[1]?.trim() ||
    (why.split("\n").find(l => l.trim()) || fallbackName).replace(/[。，,.（(：:].*$/, "").replace(/[`*]/g, "").slice(0, 40);
  return {
    title,
    why,
    what: pick(/^(What Changes|改什麼|Proposed Solution)/i),
    confirm: pick(/(企劃|程式).*確認|需要確認|Open Questions/i),
    breaking: /\*\*BREAKING\*\*/.test(md),
    // 類型：企劃（改玩法、規則書，企劃同意）／技術（重構、效能、工具，不改規則書，程式同意、要程式審查）
    kind: /類型[：:]\s*技術/.test(md) ? "技術" : "企劃",
    // 文件組合：系統向（只有企劃書）／介面向（企劃書＋示意圖＋規格書）
    docs: /文件[：:]\s*介面/.test(md) ? "介面向" : "系統向",
    brief: ((md.match(/^>\s*企劃書[：:]\s*(.+)$/m) || [])[1] || "").trim(),
    mockups: ((md.match(/^>\s*示意圖[：:]\s*(.+)$/m) || [])[1] || "").split(/[、,，]/).map(x => x.trim()).filter(Boolean),
    // 規格書：可以跟示意圖同一個檔（示意圖的「註解模式」），括號後面是說明
    specsheet: ((md.match(/^>\s*規格書[：:]\s*([^\s（(]+)/m) || [])[1] || "").trim(),
    // 優化案：改既有功能；「基於」是原提案的 id（已歸檔的那張）
    optimize: /類型[：:]\s*優化/.test(md),
    base: ((md.match(/^>\s*基於[：:]\s*(\S+)/m) || [])[1] || "").trim(),
    // 設計稿（例：Claude Design 分享連結）：備用，正本是示意圖
    design: ((md.match(/^>\s*設計稿[：:]\s*(.+)$/m) || [])[1] || "").trim(),
    // 試玩重點：給試玩的人（QA／企劃）一項一項確認的事
    qaFocus: pick(/試玩重點/).split("\n").map(l => l.match(/^\s*[-*]\s+(.+)/)?.[1]?.trim()).filter(Boolean),
  };
}

/** 提案的規則差異（changes/<id>/specs/<能力>/spec.md）：每條規則的名稱、中文說明；移除的規則不算 */
export function parseDeltaReqs(md, cap = "") {
  const out = []; let op = "ADDED";
  for (const line of md.split("\n")) {
    const h = line.match(/^## (ADDED|MODIFIED|REMOVED|RENAMED) Requirements/i); if (h) { op = h[1].toUpperCase(); continue; }
    const r = line.match(/^### Requirement:\s*(.+)/); if (r) { out.push({ cap, op, name: r[1].trim(), zh: "" }); continue; }
    const z = line.match(/^> 中文[：:]\s*(.+)/); if (z && out.length && !out.at(-1).zh) out.at(-1).zh = z[1].trim();
  }
  return out.filter(r => r.op !== "REMOVED");
}

// ---------- 試玩清單（QA）：提案做完、上線後，給人一項一項試玩的清單（GitHub 討論串，手機 App 也能勾） ----------
export const QA_MARKER = id => `<!-- spectra-qa: ${id} -->`;
export const QA_MARKER_RE = /<!-- spectra-qa: ([a-z0-9][a-z0-9-]*) -->/;
export const QA_ALWAYS = ["在手機上從頭玩到這次改的地方，沒有卡頓、跑版或錯字"];
/** 清單項目：提案的「試玩重點」優先，沒有就用每條規則的中文說明；最後加上每次都要試的（workbench.config.json 的 qa_always） */
export function qaItems(c, always = QA_ALWAYS) {
  const own = c.qaFocus?.length ? c.qaFocus : (c.reqs || []).map(r => r.zh || r.name);
  const items = [...new Set([...own, ...always])];
  return items.length ? items : [...QA_ALWAYS];
}
export function qaIssueBody(c, items, repoUrl, specDir = "docs/spectra", playUrl = "") {
  return [
    QA_MARKER(c.id),
    `提案「${c.title}」做完、已經上線了。請照下面一項一項試玩：**沒問題就勾**；有問題在管理台按「不通過」（會自動開一則 🔴 回饋），或在下面留言寫哪一項、怎麼了（附截圖更好）。`,
    playUrl ? `\n▶ 試玩：${playUrl}` : "",
    `\n### 試玩清單\n`,
    ...items.map(t => `- [ ] ${t}`),
    `\n---`,
    `全部勾完後，對 AI 說「${c.id} 驗收通過」。`,
    `提案內容：${repoUrl}/tree/main/${specDir}/changes/${c.folder}`,
  ].filter(l => l !== "").join("\n");
}
/** 讀回試玩清單：每項有沒有勾、不通過的回饋編號（❌ 還沒修、✅ 修好了） */
export function parseQa(body = "") {
  const items = [...body.matchAll(/^- \[( |x|X)\] (.*)$/gm)].map(m => {
    const done = m[1] !== " ", fails = [...m[2].matchAll(/[❌✅] #(\d+)/g)].map(x => +x[1]);
    return { done, text: m[2].replace(/\s*[❌✅] #\d+/g, "").trim(), fails, fixed: done && fails.length > 0 };
  });
  return { items, total: items.length, done: items.filter(i => i.done).length, failed: items.filter(i => !i.done && i.fails.length).length };
}

// ---------- 素材清單（素材.csv）：美術做 → 交件（待確認）→ 企劃採用／退回 → AI 放進遊戲 ----------
function parseCsvRows(text) {
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
/** 依狀態分：美術要做的（含退回）、企劃要確認的、已採用還沒放進遊戲的 */
export function assetSummary(csvText) {
  const rows = parseCsvRows(csvText), head = rows[0] || [];
  const iS = head.indexOf("狀態"), iN = Math.max(0, head.indexOf("檔名"));
  const body = rows.slice(1).filter(r => r.some(Boolean) && iS >= 0 && r[iS]);
  const names = test => body.filter(r => test(r[iS].trim())).map(r => r[iN]);
  const finished = s => /^(待確認|已採用|已放進遊戲|完成|已完成)$/.test(s);
  return {
    toMake: names(s => !finished(s)),
    toReview: names(s => s === "待確認"),
    toPlace: names(s => s === "已採用"),
    returned: names(s => /退回|修改|重做/.test(s)),
  };
}

/** 提案狀態（給人看的中文） */
export function statusOf({ archived, tasks }) {
  if (archived) return "已完成";
  if (tasks.hasApprovalItem && !tasks.approved) return "待同意";
  if (tasks.total > 0 && tasks.done === tasks.total) return "待驗收";
  if (tasks.done > 0) return "製作中";
  return tasks.hasApprovalItem ? "已同意" : "待同意";
}

/** 讀整個 spec 目錄 → { changes, specs }
 *  opts.flow：game（預設）／planning；planning 的提案有 plan（階段、並行線、里程碑），status 是階段名稱
 *  opts.changesDir：提案資料夾（預設 <specDir>/changes；企劃文件流直接用 docs/提案） */
export function readSpectra(root, specDir = "docs/spectra", opts = {}) {
  const base = join(root, specDir);
  const planning = opts.flow === "planning";
  const changesDir = opts.changesDir ? join(root, opts.changesDir) : join(base, "changes");
  const dirs = d => (existsSync(d) ? readdirSync(d).filter(n => !n.startsWith(".") && statSync(join(d, n)).isDirectory()) : []);
  const change = (dir, name, archived) => {
    const tasksMd = read(join(dir, "tasks.md"));
    const tasks = parseTasks(tasksMd);
    const proposal = parseProposal(read(join(dir, "proposal.md")), name);
    const capabilities = dirs(join(dir, "specs"));
    const reqs = capabilities.flatMap(cap => parseDeltaReqs(read(join(dir, "specs", cap, "spec.md")), cap));
    const date = archived ? (name.match(/^\d{4}-\d{2}-\d{2}/) || [""])[0] : "";
    const id = archived ? name.replace(/^\d{4}-\d{2}-\d{2}-/, "") : name;
    const artifacts = { proposal: existsSync(join(dir, "proposal.md")), specs: capabilities.length > 0, design: existsSync(join(dir, "design.md")), tasks: existsSync(join(dir, "tasks.md")) };
    const plan = planning ? parseStages(tasksMd) : undefined;
    return { id, folder: name, archived, date, ...proposal, capabilities, reqs, artifacts, tasks, plan, status: planning ? planStatus(archived, plan) : statusOf({ archived, tasks }) };
  };
  const active = dirs(changesDir).filter(n => n !== "archive").map(n => change(join(changesDir, n), n, false));
  const archived = dirs(join(changesDir, "archive")).map(n => change(join(changesDir, "archive", n), n, true)).sort((a, b) => b.folder.localeCompare(a.folder));
  const specs = (planning ? [] : dirs(join(base, "specs"))).map(name => {
    const md = read(join(base, "specs", name, "spec.md"));
    const purposeZh = (md.match(/## Purpose[\s\S]*?> 中文[：:]\s*(.+)/) || [])[1] || "";
    const purpose = purposeZh || (sections(md).Purpose || "").split("\n")[0];
    const reqs = ("\n" + md).split(/\n(?=### Requirement:)/).slice(1).map(block => ({
      name: block.match(/^### Requirement:\s*(.+)/)[1].trim(),
      zh: (block.match(/> 中文[：:]\s*(.+)/) || [])[1] || "",
      scenarios: [...block.matchAll(/^#### Scenario:\s*(.+)$/gm)].map(m => m[1].trim()),
    }));
    return { name, purpose, requirements: reqs.length, scenarios: reqs.reduce((n, r) => n + r.scenarios.length, 0), reqs };
  });
  return { changes: [...active, ...archived], specs };
}

/** 提案 Issue 的內文（給企劃在手機上看、勾選） */
export function approvalIssueBody(c, repoUrl, specDir = "docs/spectra") {
  const link = `${repoUrl}/tree/main/${specDir}/changes/${c.folder}`;
  const cut = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
  return [
    ISSUE_MARKER(c.id),
    `### 為什麼`,
    cut(c.why || "（proposal.md 沒有寫）", 1200),
    ``,
    `### 改什麼`,
    cut(c.what || "（proposal.md 沒有寫）", 1500),
    ``,
    c.kind === "技術" ? `> 🔧 **技術提案**：不改玩法和規則書，由**程式**同意；做完開 PR，程式審查合併後才上線。\n` : "",
    c.confirm ? `### ❓ 需要${approverOf(c.kind)}確認的事\n${cut(c.confirm, 1200)}\n` : "",
    c.breaking ? `> ⚠️ 這張提案有 **BREAKING**：會拿掉或改變玩家已經習慣的東西。\n` : "",
    `---`,
    `**看完沒問題就勾下面這格**（手機 GitHub App 也可以勾）。勾完幾十秒後，提案的任務 0.1 會自動打勾，對 AI 說「做 ${c.id}」就會開始製作。`,
    ``,
    `- [ ] ${approverOf(c.kind)}同意`,
    ``,
    `有意見？直接在下面留言，再對 AI 說「看提案」，AI 會照意見修改提案。`,
    `完整內容：${link}`,
  ].filter(l => l !== "").join("\n").replace(/\n(### )/g, "\n\n$1");
}

/** 內容庫索引：列出 dirs 底下的文件與圖檔（給管理台的內容庫、素材庫用；內容由管理台按需讀取） */
export function indexContent(root, dirs = ["docs/企劃"]) {
  const keep = /\.(md|csv|html|png|jpe?g|gif|webp|svg|mp3|ogg|wav|json)$/i;   // html＝示意圖
  const out = [];
  const walk = (abs, rel) => {
    if (!existsSync(abs)) return;
    for (const n of readdirSync(abs)) {
      if (n.startsWith(".")) continue;
      const a = join(abs, n), r = rel + "/" + n, st = statSync(a);
      if (st.isDirectory()) walk(a, r);
      else if (keep.test(n)) {
        const ext = n.split(".").pop().toLowerCase();
        const title = ext === "html" ? ((read(a).match(/<title>([^<]*)<\/title>/i) || [])[1] || "").trim() || n.replace(/\.html$/, "") : ext === "md" ? ((read(a).match(/^# (.+)$/m) || [])[1] || n.replace(/\.md$/, "")).trim() : n.replace(/\.[^.]+$/, "");
        out.push({ path: r.replace(/^\//, ""), name: n, ext, size: st.size, title });
      }
    }
  };
  for (const d of dirs) walk(join(root, d), d);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
