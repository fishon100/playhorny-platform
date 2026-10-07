// 開發管理台：多專案、流程圖（泳道）、提案、規則書、內容庫、素材庫、專案工具（外掛）、回饋、上線紀錄
// 資料：各專案 workbench-data 分支的 data.json（GitHub Actions 產生）；文件內容按需從 raw.githubusercontent.com 讀取
// 登入後（github.js）：同意、留言、寫回饋／提需求、編輯內容、上傳素材都在管理台完成
import { auth, verify, tokenUrl, classicTokenUrl, approveChange, comment, createIssue, readFile, saveFile, uploadFile, qaSet, qaFail, saveAssetRow, rawFetch } from "./github.js?v=202610081100";
import { parseCsv, assetCounts, ASSET_STATES, parseQa } from "./shared.js?v=202610081100";
import { icon as I, hasIcon } from "./icons.js?v=202610081100";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const qs = new URLSearchParams(location.search);
const ago = iso => { const m = Math.round((Date.now() - new Date(iso)) / 60000); if (m < 1) return "剛剛"; if (m < 60) return `${m} 分鐘前`; const h = Math.round(m / 60); return h < 24 ? `${h} 小時前` : `${Math.round(h / 24)} 天前`; };
const short = (s, n) => { s = String(s || "").replace(/[#*`>_]/g, "").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
// 檔名用：只截長度，不像 short() 會拿掉 _ * 這些 Markdown 符號
const clip = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n) + "…" : s; };
const encPath = p => p.split("/").map(encodeURIComponent).join("/");

const S = { projects: [], repo: "", data: null, view: "overview", arg: "", treeFilter: "", flowMode: store.get("console:flowMode") || "diagram", assetFilter: "全部", assetCat: "全部" };
const raw = p => `https://raw.githubusercontent.com/${S.repo}/${S.data?.branch || "main"}/${encPath(p)}`;
const blob = p => `${S.data.repoUrl}/blob/${S.data.branch || "main"}/${encPath(p)}`;
const tree = p => `${S.data.repoUrl}/tree/${S.data.branch || "main"}/${encPath(p)}`;
// 私人專案：raw 網址沒登入看不到，文字與圖片都改用登入碼走 API（data.private 由同步程式寫入）
const isPriv = () => !!S.data?.private;
async function getText(path) {
  const r = isPriv() ? await rawFetch(S.repo, path, S.data.branch) : await fetch(raw(path) + `?t=${Date.now()}`);
  if (!r.ok) throw new Error(r.status);
  return r.text();
}
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
// 圖片的 src：公開專案直接用 raw 網址；私人專案先放空白，之後用登入碼讀成 blob 再換上
const imgSrc = p => isPriv() ? `src="${PIXEL}" data-ghimg="${esc(p)}"` : `src="${raw(p)}"`;
const imgCache = new Map();
async function hydrateImgs() {
  for (const img of document.querySelectorAll("img[data-ghimg]")) {
    const p = img.dataset.ghimg, key = S.repo + ":" + p; img.removeAttribute("data-ghimg");
    try {
      if (!imgCache.has(key)) { const r = await rawFetch(S.repo, p, S.data.branch); imgCache.set(key, URL.createObjectURL(new Blob([await r.arrayBuffer()], { type: MIME[p.split(".").pop().toLowerCase()] || "application/octet-stream" }))); }
      img.src = imgCache.get(key);
    } catch { img.alt = "（私人專案：登入後才看得到圖片）"; }
  }
}
new MutationObserver(() => { if (document.querySelector("img[data-ghimg]")) hydrateImgs(); }).observe(document.documentElement, { subtree: true, childList: true });

// ---------- 內容分類 ----------
const IMG = /^(png|jpe?g|gif|webp|svg)$/;
const CATS = [
  { key: "script", label: "劇本", ic: "book", test: f => /劇情|劇本|腳本|大綱|story|script/i.test(f.path) && !/世界觀/.test(f.name) },
  { key: "chars", label: "角色", ic: "users", test: f => /角色|character/i.test(f.path) },
  { key: "world", label: "世界觀", ic: "globe", test: f => /世界|街區|world/i.test(f.path) },
  { key: "terms", label: "名詞", ic: "tag", test: f => /名詞|命名|term|glossary/i.test(f.name) },
  { key: "numbers", label: "數值", ic: "chart", test: f => /數值|tuning|balance/i.test(f.name) },
  { key: "specsheets", label: "規格書", ic: "list", test: f => /規格書/.test(f.path) },   // 元件規格（標註在示意圖上；md 是 tools/specsheet.mjs 從註解模式產生的）
  { key: "briefs", label: "企劃書", ic: "fileText", test: f => /企劃書/.test(f.path) },   // 需求定義（為什麼做、做什麼、什麼情境）
  { key: "mockups", label: "示意圖", ic: "layout", test: f => f.ext === "html" && !/規格書/.test(f.path) },   // 介面展示（AI 依企劃書做的 html 畫面）
  { key: "plans", label: "規劃書", ic: "fileText", test: f => /規劃書|主架構|規劃|plan/i.test(f.path) },
  { key: "records", label: "紀錄", ic: "history", test: f => /日誌|回饋|紀錄|log/i.test(f.name) },
];
const isAsset = f => IMG.test(f.ext) || /^(mp3|ogg|wav)$/.test(f.ext) || /媒體庫|美術|音樂|音效|素材|assets/i.test(f.path);
function catOf(f) {
  if (f.ext === "html") return /規格書/.test(f.path) ? "specsheets" : "mockups";
  if (f.ext !== "md") return null;
  if (/媒體庫|素材/.test(f.path) && !/美術風格/.test(f.name)) return "assets";
  return (CATS.find(c => c.test(f)) || { key: "other" }).key;
}
// 專案工具（外掛）：workbench.config.json 的 tools；舊設定只有 links 時，把「試玩」以外的連結當工具
const stripEmoji = s => String(s || "").replace(/^[\p{Extended_Pictographic}\p{S}️‍\s]+/u, "");
const toolsOf = d => d.tools?.length ? d.tools : (d.links || []).filter(l => !/試玩/.test(l.label)).map(l => ({ label: stripEmoji(l.label), url: l.url, icon: /測試/.test(l.label) ? "flask" : /編輯/.test(l.label) ? "wrench" : /文件|說明/.test(l.label) ? "book" : "external" }));
const playLinks = d => (d.links || []).filter(l => /試玩/.test(l.label));

// ---------- 側欄 ----------
function sideHtml() {
  const d = S.data, act = d.changes.filter(c => !c.archived), waiting = act.filter(c => isPlan() ? [4, 6].includes(planStageOf(c)) : c.status === "待同意").length;
  const content = d.content || [];
  const count = k => content.filter(f => catOf(f) === k).length;
  const fbOpen = d.feedback.filter(i => i.state === "open").length + d.requests.filter(i => i.state === "open").length;
  const cur = v => S.view === v.split("/")[0] && (!v.includes("/") || S.arg === v.split("/")[1]);
  const item = (v, ic, label, n, hot) => `<button class="nav" data-go="${v}" ${cur(v) ? 'aria-current="page"' : ""}>${I(ic)}<span>${label}</span>${n ? `<span class="n ${hot ? "hot" : ""}">${n}</span>` : ""}</button>`;
  const tools = toolsOf(d);
  return `<h6>專案</h6>
    ${item("overview", "home", "總覽", waiting, true)}
    ${item("flow", "workflow", "流程圖")}
    ${item("changes", "list", "提案", act.length)}
    ${isPlan() ? "" : item("specs", "scroll", "規則書", d.specs.length)}
    <h6>內容庫</h6>
    ${CATS.filter(c => count(c.key)).map(c => item("content/" + c.key, c.ic, c.label, count(c.key))).join("")}
    ${item("assets", "image", "素材庫", content.filter(isAsset).length)}
    ${item("files", "files", "全部文件", content.length)}
    <h6>協作</h6>
    ${item("issues", "message", "回饋與需求", fbOpen, fbOpen > 0)}
    ${item("activity", "rocket", isPlan() ? "改動紀錄" : "上線紀錄")}
    ${tools.length ? `<h6>${I("puzzle", 12)}專案工具</h6>${tools.map(t => `<a class="nav" href="${esc(t.url)}" target="_blank" rel="noopener" title="${esc(t.desc || t.label)}">${I(hasIcon(t.icon) ? t.icon : "wrench")}<span>${esc(t.label)}</span><span class="ext">${I("external", 13)}</span></a>`).join("")}` : ""}
    <h6>系統</h6>
    ${item("tools", "puzzle", "工具與外掛")}
    ${item("projects", "folder", "專案目錄", S.projects.length)}
    ${item("help", "help", "說明")}`;
}

// ---------- 共用元件 ----------
const issueBtns = primary => `<button class="btn ${primary ? "primary" : ""}" data-newissue="回饋">${I("gamepad")}寫回饋</button><button class="btn" data-newissue="需求">${I("lightbulb")}提需求</button>`;
const chip = s => `<span class="chip s-${esc(s)}">${esc(s)}</span>`;
// 技術提案（重構、效能、工具；程式同意、程式審查）的標記；誰同意
const kindChip = c => c.kind === "技術" ? `<span class="chip c-tech" title="技術提案：程式同意，做完開 PR 給程式審查">${I("code", 12)}技術</span>` : "";
const approverOf = c => (c.kind === "技術" ? "程式" : "企劃");
const pct = c => (c.tasks.total ? Math.round((c.tasks.done / c.tasks.total) * 100) : c.archived ? 100 : 0);
const barHtml = c => `<div class="bar" title="${c.tasks.done}/${c.tasks.total}"><i style="width:${pct(c)}%"></i></div>`;
const ORDER = { 待同意: 0, 待驗收: 1, 製作中: 2, 已同意: 3, 已完成: 9 };
const vh = (ic, title, sub = "", right = "") => `<div class="vh"><h1>${I(ic, 20)}${title}</h1>${sub ? `<span class="sub">${sub}</span>` : ""}<div class="spacer"></div>${right}</div>`;

function chainHtml(c) {
  if (isPlan()) {
    const cur = planStageOf(c), st = planStages().filter(s => !(s.n === 3 && c.docs !== "介面向"));
    const now = st.findIndex(s => s.n === cur);
    return `<div class="chain">${st.map((s, i) => { const ok = c.archived || s.n < cur; return `${i ? `<div class="link ${ok ? "done" : ""}"></div>` : ""}<div class="step ${ok ? "done" : i === now ? "now" : ""}" title="${ok ? "完成" : i === now ? "目前在這一步" : "還沒到"}"><div class="dotc">${ok ? I("check", 13) : s.milestone ? "◆" : s.n}</div><span>${esc(s.label)}</span></div>`; }).join("")}</div>`;
  }
  const a = c.artifacts || {}, t = c.tasks;
  const steps = [["說明", a.proposal], ["規則", a.specs], ["設計", a.design], ["任務", a.tasks], ["同意", c.archived || t.approved], ["製作", t.total > 0 && t.done === t.total], ["驗收", c.archived]];
  const now = steps.findIndex(([, ok]) => !ok);
  return `<div class="chain">${steps.map(([l, ok], i) => `${i ? `<div class="link ${ok ? "done" : ""}"></div>` : ""}<div class="step ${ok ? "done" : i === now ? "now" : ""}" title="${ok ? "完成" : i === now ? "目前在這一步" : "還沒到"}"><div class="dotc">${ok ? I("check", 13) : i + 1}</div><span>${l}</span></div>`).join("")}</div>`;
}
const taskTree = (groups, closedDone) => (groups || []).map(g => `<li class="${closedDone && g.items.every(i => i.done) ? "closed" : ""}"><div class="tnode"><button class="tw">${I("chevronDown", 14)}</button><span class="lbl"><b>${esc(g.title)}</b></span><span class="meta muted">${g.items.filter(i => i.done).length}/${g.items.length}</span></div>
  <ul>${g.items.map(i => `<li><div class="tnode"><span class="tw leaf"></span><span class="${i.done ? "ck" : "ck-no"}">${I(i.done ? "checkCircle" : "circle", 15)}</span><span class="lbl" title="${esc(i.text)}">${esc(i.text)}</span></div></li>`).join("")}</ul></li>`).join("");

// 試玩清單：做完、已上線的提案，一項一項試玩（勾＝沒問題；不通過＝自動開 🔴 回饋）
function qaHtml(c) {
  if (c.archived || !(c.qa || c.status === "待驗收")) return "";
  if (!c.qa) return `<div class="banner">${I("hourglass", 15)}<span>試玩清單建立中：約 1 分鐘後重新整理就會出現。</span></div>`;
  const q = c.qa, all = q.total && q.done === q.total;
  const fbLink = n => `<a href="${esc(S.data.repoUrl)}/issues/${n}" target="_blank" rel="noopener">#${n}</a>`;
  return `<section class="qa ${all ? "all" : ""}">
    <div class="qa-h">${I("flask", 15)}<b>試玩清單</b><span class="muted">${q.done}/${q.total}${q.failed ? `・<span class="bad-t">${q.failed} 項不通過</span>` : ""}</span><span class="spacer"></span>${playLinks(S.data).slice(0, 1).map(l => `<a class="btn sm primary" href="${esc(l.url)}" target="_blank" rel="noopener">${I("play", 13)}試玩</a>`).join("")}<a class="btn sm" href="${esc(q.url)}" target="_blank" rel="noopener" title="GitHub 上的試玩清單（手機 App 也能勾）">${I("git", 13)}#${q.number}</a></div>
    <ul class="qa-list">${q.items.map((it, i) => `<li class="${it.done ? "ok" : it.fails.length ? "bad" : ""}">
      <button class="qa-ck" data-qa="${esc(c.id)}:${i}:${it.done ? 0 : 1}" aria-pressed="${it.done}" title="${it.done ? "取消勾選" : "沒問題，勾起來"}">${I(it.done ? "checkCircle" : "circle", 18)}</button>
      <div class="g"><div>${esc(it.text)}</div>${it.fails.length ? `<div class="muted">${it.fixed ? "修好了" : "不通過"}：${it.fails.map(fbLink).join("、")}</div>` : ""}</div>
      ${it.done ? "" : `<button class="btn sm" data-qafail="${esc(c.id)}:${i}">${I("x", 13)}不通過</button>`}</li>`).join("")}</ul>
    ${all ? `<p class="ok-t">${I("checkCircle", 14)}全部通過：企劃確認後對 AI 說「${esc(c.id)} 驗收通過」。</p>` : `<p class="muted">沒問題就勾；有問題按「不通過」，寫下哪裡怪（可附截圖），會自動開一則 🔴 必修回饋，AI 修好後再試一次。</p>`}
  </section>`;
}
// 提案的文件組合：企劃書（需求定義）、示意圖（介面展示）；介面向的提案才有示意圖
function docsRow(c) {
  if (!c.brief && !c.mockups?.length && !c.specsheet && !c.design && !c.optimize && c.docs !== "介面向") return "";
  const name = p => p.split("/").pop().replace(/.(md|html)$/, "");
  return `<div class="docs-row"><span class="chip ${c.docs === "介面向" ? "c-info" : ""}" title="${c.docs === "介面向" ? "介面向：企劃書＋示意圖＋規格書" : "系統向：只有企劃書"}">${I("files", 12)}${esc(c.docs)}</span>${c.optimize ? `<button class="chip c-info" data-change="${esc(c.base)}" title="優化案：基於 ${esc(c.base)}">${I("sparkles", 12)}優化・${esc(c.base)}</button>` : ""}
    ${c.brief ? (/^https?:\/\//.test(c.brief) ? `<a class="btn sm" href="${esc(c.brief.split(/[（(]/)[0].trim())}" target="_blank" rel="noopener" title="${esc(c.brief)}">${I("fileText", 14)}企劃書${/[（(]([^）)]+)[）)]/.test(c.brief) ? "・" + esc(c.brief.match(/[（(]([^）)]+)[）)]/)[1]) : ""}</a>` : `<button class="btn sm" data-opendoc="${esc(c.brief)}">${I("fileText", 14)}企劃書</button>`) : ""}
    ${c.design && /^https?:\/\//.test(c.design) ? `<a class="btn sm" href="${esc(c.design)}" target="_blank" rel="noopener" title="設計稿（備用，正本是示意圖）">${I("layout", 14)}設計稿</a>` : ""}
    ${(c.mockups || []).map(p => `<button class="btn sm" data-opendoc="${esc(p)}" title="${esc(p)}">${I("layout", 14)}示意圖：${esc(name(p))}</button>`).join("")}
    ${c.specsheet ? `<button class="btn sm" data-opendoc="${esc(c.specsheet)}" title="${c.mockups?.includes(c.specsheet) ? "規格書就在示意圖裡：打開後按右下角「註解模式：開」，點黃色 SPEC 看每個版位的規格" : esc(c.specsheet)}">${I("list", 14)}規格書${c.mockups?.includes(c.specsheet) ? "（示意圖註解模式）" : ""}</button>` : ""}
    ${c.docs === "介面向" && !c.mockups?.length ? `<span class="muted">還沒有示意圖</span>` : ""}</div>`;
}
function changeDetail(c) {
  const folder = `${S.data.changesDir || S.data.specDir + "/changes"}/${c.archived ? "archive/" : ""}${c.folder}`;
  const groups = taskTree(c.tasks.groups, true);
  return `<button class="ibtn close" data-close aria-label="關閉">${I("x")}</button>
    <div class="row">${chip(c.status)}${kindChip(c)}${c.breaking ? '<span class="chip c-bad">BREAKING</span>' : ""}<span class="muted" style="font-family:var(--mono)">${esc(c.id)}${c.date ? "・" + esc(c.date) : ""}</span></div>
    <h2 style="margin:10px 0 0;font-size:18px;font-weight:650">${esc(c.title)}</h2>
    ${chainHtml(c)}
    ${docsRow(c)}
    <div class="row" style="margin-bottom:14px">
      ${isPlan() ? "" : c.status === "待同意" ? approveBtn(c) : ""}
      ${isPlan() ? (planStageOf(c) === 4 ? sayBtn(`${c.id} 需求確認了`, "") : planStageOf(c) === 5 && c.plan?.milestones?.M2 && !c.plan.milestones.M2.done ? sayBtn(`${c.id} 規格確認了`, "") : planStageOf(c) === 6 ? sayBtn(`${c.id} 驗收通過`, "") : "")
        : ["已同意", "製作中"].includes(c.status) ? sayBtn(`做 ${c.id}`, "") : c.status === "待驗收" ? sayBtn(`${c.id} 驗收通過`, "") : ""}
      ${c.issue && !c.archived ? `<button class="btn" data-comment="${esc(c.id)}">${I("message")}留言／提問</button>` : ""}
      <a class="btn" href="${tree(folder)}" target="_blank" rel="noopener">${I("fileText")}提案檔案</a>
      ${c.issue ? `<a class="btn" href="${esc(c.issue.url)}" target="_blank" rel="noopener" title="GitHub 上的討論串（Issue）">${I("git")}討論串 #${c.issue.number}${c.issue.comments ? `（${c.issue.comments}）` : ""}</a>` : ""}
    </div>
    ${isPlan() ? `<div class="row" style="margin-bottom:14px">${msChip(c, "M1")}${msChip(c, "M2")}</div>` : ""}
    ${c.tasks.approvalNote ? `<div class="banner">${I("checkCircle")}<span>${esc(c.tasks.approvalNote)}</span></div>` : ""}
    ${isPlan() ? "" : qaHtml(c)}
    <h3>為什麼</h3><div class="pre">${esc(c.why || "（沒有寫）")}</div>
    <h3 style="margin-top:16px">改什麼</h3><div class="pre">${esc(c.what || "（沒有寫）")}</div>
    ${c.confirm ? `<h3 style="margin-top:16px">${I("help", 14)}需要企劃確認的事</h3><div class="ask">${esc(c.confirm)}</div>` : ""}
    ${c.capabilities?.length ? `<h3 style="margin-top:16px">影響的規則書</h3><div class="row">${c.capabilities.map(n => `<button class="chip" data-go="specs/${esc(n)}">${I("scroll", 12)}${esc(n)}</button>`).join("")}</div>` : ""}
    <h3 style="margin-top:16px">${isPlan() ? "階段與任務" : "任務"} ${c.tasks.done}/${c.tasks.total}</h3>
    ${groups ? `<ul class="tree">${groups}</ul>` : `<p class="muted">沒有任務清單</p>`}`;
}

// ---------- 各頁 ----------
const V = {};
const runLi = r => `<li><span class="status-dot ${r.conclusion === "success" ? "ok" : r.conclusion === "failure" ? "bad" : ""}"></span><div class="g"><a class="t1" href="${esc(r.url)}" target="_blank" rel="noopener" style="color:var(--ink)">${esc(r.title || r.name)}</a><div class="muted">${esc(r.name)}・${r.conclusion === "success" ? "成功" : r.conclusion === "failure" ? "失敗" : "進行中"}・${ago(r.date)}</div></div></li>`;

V.overview = () => {
  const d = S.data, act = d.changes.filter(c => !c.archived), arc = d.changes.filter(c => c.archived);
  const by = s => act.filter(c => c.status === s);
  const rqOpen = d.requests.filter(i => i.state === "open"), fbOpen = d.feedback.filter(i => i.state === "open");
  const content = d.content || [];
  const todo = myTodo(S.role || "全部");
  const tools = toolsOf(d);
  // 摘要列：一列看完各階段數量；要處理的數字用狀態色
  const seg = (ic, label, n, go, cls = "") => `<button class="seg-i ${n ? cls : ""}" data-go="${go}"><span class="k">${I(ic, 13)}${label}</span><b>${n}</b></button>`;
  const active = [...act].sort((a, b) => sortKey(a) - sortKey(b));
  const linkRow = (ic, label, n, go) => `<li data-go="${go}" style="cursor:pointer">${I(ic, 15)}<div class="g">${label}</div><span class="muted" style="font-variant-numeric:tabular-nums">${n}</span>${I("chevronRight", 14)}</li>`;
  return `<div class="crumb">${esc(d.repo)}</div>
    ${vh("home", esc(d.name), "", `${playLinks(d).map(l => `<a class="btn primary" href="${esc(l.url)}" target="_blank" rel="noopener">${I("play", 14)}試玩</a>`).join("")}${issueBtns()}`)}
    <div class="strip">
      ${isPlan()
        ? planStages().filter(s => s.n !== 7).map(s => seg(s.milestone ? "checkCircle" : "workflow", s.label, act.filter(c => planStageOf(c) === s.n).length, "flow", s.milestone || s.n === 6 ? "attn" : "")).join("") + seg("archive", "已完成", arc.length, "changes")
        : seg("hourglass", "待同意", by("待同意").length, "flow", "attn") + seg("code", "製作中", by("已同意").length + by("製作中").length, "flow") + seg("flask", "待驗收", by("待驗收").length, "flow", "attn") + seg("archive", "已完成", arc.length, "changes") + seg("scroll", "規則", d.specs.reduce((n, s) => n + s.requirements, 0), "specs")}${seg("message", "未處理回饋", fbOpen.length + rqOpen.length, "issues", "bad")}
    </div>
    ${S.role ? "" : rolePicker()}
    <div class="ov-grid">
      <div class="col">
        ${panel("alert", S.role && S.role !== "全部" ? `我的待辦・${esc(S.role)}` : "需要處理", todo.length ? `<ul class="list">${todo.join("")}</ul>` : `<div class="empty">${S.role && S.role !== "全部" ? `目前沒有${esc(S.role)}要處理的事。提案任務標了【${esc(S.role.split("／")[0])}】就會出現在這裡。` : "目前沒有等待處理的事"}</div>`, `${todo.length ? `<span class="chip c-warn">${todo.length}</span>` : ""}${roleSelect()}`)}
        ${panel("workflow", "進行中的提案", active.length ? `<table class="t stack"><thead><tr><th>狀態</th><th>提案</th><th>進度</th></tr></thead><tbody>${active.map(c => `<tr class="click" data-change="${esc(c.id)}"><td>${chip(c.status)}</td><td style="min-width:0"><div style="font-weight:600">${esc(c.title)}</div><div class="muted">${c.tasks.next ? `下一步：${esc(short(c.tasks.next, 40))}` : esc(c.id)}</div>${isPlan() && planStageOf(c) === 5 ? `<div class="muted">${esc(lanesText(c))}</div>` : ""}</td><td style="width:150px">${barHtml(c)}<div class="muted" style="margin-top:4px">${c.tasks.done}/${c.tasks.total} 任務</div></td></tr>`).join("")}</tbody></table>` : `<div class="empty">沒有進行中的提案</div>`, `<button class="btn sm" data-go="flow">${I("workflow", 13)}流程圖</button>`, true)}
      </div>
      <div class="col">
        ${panel("rocket", isPlan() ? "最近改動" : "最近上線", `<ul class="list">${d.runs.slice(0, 5).map(runLi).join("") || `<li class="empty">還沒有紀錄</li>`}</ul>`, `<button class="btn sm" data-go="activity">全部</button>`)}
        ${panel("files", "內容與工具", `<ul class="list">${linkRow("fileText", "企劃文件", content.filter(f => f.ext === "md").length, "files")}${linkRow("image", "圖片素材", content.filter(f => IMG.test(f.ext)).length, "assets")}${linkRow("puzzle", "專案工具", tools.length, "tools")}</ul>`)}
      </div>
    </div>`;
};
// ===== 角色與「我的待辦」：首頁依角色列出要做的事 =====
const ROLES = [["企劃", "fileText", "同意提案、確認素材、驗收、處理回饋"], ["美術", "image", "標【美術】的任務、待製作與被退回的素材、交件"], ["程式", "code", "同意技術提案、審查 PR、修失敗的測試"], ["前端", "layout", "第 5 階段「前端」線的任務；M2 之後補介面細節"], ["後端", "code", "第 5 階段「後端」線的任務；M1 之後就能開工"],["QA", "flask", "照試玩清單試玩、回報不通過"], ["劇本／數值", "book", "標【劇本】【數值】的任務"], ["全部", "users", "看所有要處理的事"]];
const ROLE_TAG = { 企劃: /【企劃】/, 美術: /【美術】/, 程式: /【程式】/, QA: /【QA】/i, "劇本／數值": /【(劇本|數值)】/, 前端: /【前端】/, 後端: /【後端】/ };
// 試玩清單進度（給待辦、流程圖、明細用）
const qaText = c => c.qa ? `試玩清單 ${c.qa.done}/${c.qa.total}${c.qa.failed ? `・${c.qa.failed} 項不通過` : c.qa.total && c.qa.done === c.qa.total ? "・全部通過" : ""}` : c.status === "待驗收" ? "試玩清單建立中（約 1 分鐘）" : "";
S.role = store.get("console:role") || "";
const rolePicker = () => `<section class="panel role-pick"><div class="ph">${I("users", 15)}<h3>你主要負責什麼？</h3><span class="spacer"></span><span class="muted">首頁會依角色列出你的待辦（之後可以在「需要處理」右上角換）</span></div><div class="pb"><div class="roles">${ROLES.map(([r, ic, desc]) => `<button class="role" data-role="${esc(r)}">${I(ic, 18)}<b>${esc(r)}</b><small>${esc(desc)}</small></button>`).join("")}</div></div></section>`;
const roleSelect = () => `<select class="rsel" data-rolesel aria-label="角色">${ROLES.map(([r]) => `<option ${r === (S.role || "全部") ? "selected" : ""}>${esc(r)}</option>`).join("")}</select>`;
// 提案任務裡標了角色的（例：「2.3 【美術】畫 Boss 立繪」）
function roleTasks(role) {
  const re = ROLE_TAG[role]; if (!re) return [];
  const out = [];
  for (const c of S.data.changes.filter(x => !x.archived)) for (const g of c.tasks.groups || []) for (const it of g.items) if (!it.done && re.test(it.text)) out.push({ c, text: it.text });
  return out;
}
// 企劃文件流：第 5 階段的並行線，線名就是角色（美術／後端／前端），不用在任務文字標【角色】
function laneTasks(role) {
  const out = [];
  for (const c of S.data.changes.filter(x => !x.archived && planStageOf(x) >= 5)) for (const l of c.plan?.stages?.find(s => s.n === 5)?.lanes || []) if (l.name === role) for (const it of l.items) if (!it.done && !it.milestone) out.push({ c, text: it.text });
  return out;
}
const todoLi =(dot, title, sub, actions = "") => `<li><span class="status-dot ${dot}"></span><div class="g"><div class="t1">${title}</div>${sub ? `<div class="muted">${sub}</div>` : ""}</div>${actions}</li>`;
const detailBtn = c => `<button class="btn sm" data-change="${esc(c.id)}">明細</button>`;
function myTodo(role) {
  const d = S.data, act = d.changes.filter(c => !c.archived), by = s => act.filter(c => c.status === s);
  const fbOpen = d.feedback.filter(i => i.state === "open"), rqOpen = d.requests.filter(i => i.state === "open");
  const me = auth.user?.login;
  const items = [], add = (key, html) => { if (!items.some(x => x.key === key)) items.push({ key, html }); };
  const is = (...r) => role === "全部" || r.includes(role);
  if (isPlan()) {
    if (is("企劃")) {
      act.filter(c => planStageOf(c) === 4).forEach(c => add("m1:" + c.id, todoLi("warn", esc(c.title), `等需求確認（M1）：需求會議看企劃書＋示意圖，確認後對 AI 說・${esc(c.id)}`, sayBtn(`${c.id} 需求確認了`) + detailBtn(c))));
      act.filter(c => { if (planStageOf(c) !== 5 || !c.plan?.milestones?.M2 || c.plan.milestones.M2.done) return false; const art = c.plan.stages.find(s => s.n === 5)?.lanes?.find(l => l.name === "美術")?.items.filter(i => !i.milestone) || []; return art.length > 0 && art.every(i => i.done); }).forEach(c => add("m2:" + c.id, todoLi("warn", esc(c.title), `美術完成了：補 SPEC 介面細節、匯出 spec.md，確認後對 AI 說・${esc(c.id)}`, sayBtn(`${c.id} 規格確認了`) + detailBtn(c))));
      act.filter(c => planStageOf(c) === 6).forEach(c => add("vf:" + c.id, todoLi("info", esc(c.title), `開發完成：照 SPEC 驗收條件逐條驗，通過後對 AI 說・${esc(c.id)}`, sayBtn(`${c.id} 驗收通過`) + detailBtn(c))));
      if (fbOpen.length + rqOpen.length) add("fb", todoLi("bad", `${fbOpen.length} 則回饋、${rqOpen.length} 則需求還沒處理`, "看過後請 AI 整理成提案或寫回同一張提案", sayBtn(fbOpen.length ? "看回饋" : "看需求") + `<button class="btn sm" data-go="issues">查看</button>`));
    }
    for (const r of ["美術", "後端", "前端"]) if (is(r)) laneTasks(r).forEach(({ c, text }) => add("t:" + c.id + text, todoLi("warn", esc(text), `提案：${esc(c.title)}・${r}`, detailBtn(c))));
    for (const r of ["企劃", "美術", "程式", "QA", "劇本／數值", "前端", "後端"]) if (is(r)) roleTasks(r).forEach(({ c, text }) => add("t:" + c.id + text, todoLi("warn", esc(text), `提案：${esc(c.title)}`, detailBtn(c))));
    return items.map(x => x.html);
  }
  if (is("企劃")) {
    by("待同意").filter(c => c.kind !== "技術").forEach(c => add("ap:" + c.id, todoLi("", esc(c.title), `等企劃同意・${esc(c.id)}`, approveBtn(c, `${I("thumbsUp", 14)}同意`) + detailBtn(c))));
    by("待驗收").filter(c => c.kind !== "技術").forEach(c => add("vf:" + c.id, todoLi(c.qa?.failed ? "bad" : "info", esc(c.title), `做完了：照試玩清單試玩，沒問題就跟 AI 說驗收通過・${esc(qaText(c))}`, sayBtn(`${c.id} 驗收通過`) + `<button class="btn sm" data-change="${esc(c.id)}">試玩清單</button>`)));
    const ar = assetsOf();
    if (ar?.toReview.length) add("assets-review", todoLi("warn", `${ar.toReview.length} 個素材等你確認`, `美術交件了：${esc(clip(ar.toReview.join("、"), 60))}`, `<button class="btn sm" data-assetgo="待確認">確認素材</button>`));
    if (fbOpen.length + rqOpen.length) add("fb", todoLi("bad", `${fbOpen.length} 則回饋、${rqOpen.length} 則需求還沒處理`, "看過後請 AI 整理成提案", sayBtn(fbOpen.length ? "看回饋" : "看需求") + `<button class="btn sm" data-go="issues">查看</button>`));
  }
  if (is("程式")) {
    by("待同意").filter(c => c.kind === "技術").forEach(c => add("ap:" + c.id, todoLi("", `${esc(c.title)} ${kindChip(c)}`, `技術提案，等程式同意・${esc(c.id)}`, approveBtn(c, `${I("thumbsUp", 14)}同意`) + detailBtn(c))));
    (d.pulls || []).forEach(p => add("pr:" + p.number, todoLi("info", `審查 PR #${p.number} ${esc(p.title)}`, `${esc(p.user || "")}・${ago(p.created)}${p.draft ? "・草稿" : ""}`, `<a class="btn sm" href="${esc(p.url)}" target="_blank" rel="noopener">審查</a>`)));
    if (d.runs[0]?.conclusion === "failure") add("run", todoLi("bad", `最近一次「${esc(d.runs[0].name)}」失敗`, esc(d.runs[0].title || ""), `<a class="btn sm" href="${esc(d.runs[0].url)}" target="_blank" rel="noopener">看原因</a>`));
    by("待驗收").filter(c => c.kind === "技術").forEach(c => add("vf:" + c.id, todoLi("info", `${esc(c.title)} ${kindChip(c)}`, "技術提案做完了：PR 合併、測試通過後跟 AI 說驗收通過", sayBtn(`${c.id} 驗收通過`) + detailBtn(c))));
    by("已同意").forEach(c => add("go:" + c.id, todoLi("", esc(c.title), `${approverOf(c)}已同意，還沒開始做`, sayBtn(`做 ${c.id}`) + detailBtn(c))));
  }
  if (is("QA")) {
    // QA：做完、已上線的提案，照試玩清單一項一項試
    by("待驗收").forEach(c => add("qa:" + c.id, todoLi(c.qa?.failed ? "bad" : "info", `試玩：${esc(c.title)} ${kindChip(c)}`, esc(qaText(c)), `<button class="btn sm ${c.qa && c.qa.done < c.qa.total ? "primary" : ""}" data-change="${esc(c.id)}">${I("flask", 13)}開始試玩</button>`)));
  }
  for (const r of ["企劃", "美術", "程式", "QA", "劇本／數值"]) if (is(r)) roleTasks(r).forEach(({ c, text }) => add("t:" + c.id + text, todoLi("warn", esc(text), `提案：${esc(c.title)}`, detailBtn(c))));
  if (is("美術")) {
    const a = assetsOf();
    if (a?.returned.length) add("assets-back", todoLi("bad", `${a.returned.length} 個素材被退回，要修改`, esc(clip(a.returned.join("、"), 60)), `<button class="btn sm" data-assetgo="退回">看意見</button>`));
    const make = (a?.toMake.length || 0) - (a?.returned.length || 0);
    if (make > 0) add("assets", todoLi("warn", `${make} 個素材待製作`, "做好後在素材庫按「交件」", `<button class="btn sm" data-go="assets">素材庫</button>`));
  }
  const labelled = [...fbOpen, ...rqOpen].filter(i => (me && i.assignees?.includes(me)) || (role !== "全部" && role.split("／").some(r => i.labels?.includes(r))));
  labelled.forEach(i => add("i:" + i.number, todoLi("bad", `#${i.number} ${esc(i.title)}`, i.assignees?.includes(me) ? "指派給你" : `標籤：${esc(role)}`, `<a class="btn sm" href="${esc(i.url)}" target="_blank" rel="noopener">查看</a>`)));
  if (is("美術", "企劃") && !d.assets && S.assetTodo?.repo !== S.repo) loadAssetTodo();
  return items.map(x => x.html);
}
// 素材清單摘要：新的管理台資料裡就有（data.assets）；舊資料才自己讀 CSV
const assetsOf = () => S.data.assets || (S.assetTodo?.repo === S.repo ? S.assetTodo.sum : null);
async function loadAssetTodo() {
  const repo = S.repo, sheet = (S.data.content || []).find(f => f.ext === "csv" && /素材|asset/i.test(f.name));
  S.assetTodo = { repo, sum: null };
  if (!sheet) return;
  try {
    S.assetTodo.sum = assetCounts(parseCsv(await getText(sheet.path)));
    if (repo === S.repo && S.view === "overview") render();
  } catch {}
}

// 面板：標題列＋內容（flush＝內容是表格，不要內距）
function panel(ic, title, body, right = "", flush = false) {
  return `<section class="panel"><div class="ph">${I(ic, 15)}<h3>${title}</h3><span class="spacer"></span>${right}</div><div class="pb ${flush ? "flush" : ""}">${body}</div></section>`;
}

// ===== 流程圖：上方是兩條標準流程（企劃提案、技術提案），下方每張進行中的提案一條泳道，標出它走到哪 =====
// ===== 企劃文件流（data.flow.mode === "planning"）：平台專案的 7 格流程，沒有同意／試玩／規則書 =====
const isPlan = () => S.data?.flow?.mode === "planning";
const planStages = () => (S.data?.flow?.stages || []);
const planStageOf = c => c.archived ? 7 : !c.plan?.stages?.length ? 1 : (c.plan.current ?? 7);
const planLabel = n => planStages().find(s => s.n === n)?.label || "";
// 里程碑小標：◆ M1・2026-10-07，需求會議／◆ M2・待確認
const msChip = (c, key) => { const m = c.plan?.milestones?.[key]; if (!m) return ""; return `<span class="chip ${m.done ? "c-ok" : "c-warn"}" title="${esc(m.text)}">◆ ${key}${m.done ? `・${esc(m.note || "已確認")}` : "・待確認"}</span>`; };
// 第 5 階段的並行線：美術 0/2・後端 1/2・前端 0/1
const lanesText = c => (c.plan?.stages?.find(s => s.n === 5)?.lanes || []).filter(l => l.name).map(l => `${l.name} ${l.done}/${l.total}`).join("・");
const sortKey = c => isPlan() ? (c.archived ? 99 : 10 - planStageOf(c)) : (ORDER[c.status] ?? 5);
const STAGES = [
  { n: 1, label: "需求", sub: "回饋／需求" },
  { n: 2, label: "寫提案", sub: "propose" },
  { n: 3, label: "同意", sub: "企劃／程式" },
  { n: 4, label: "製作", sub: "apply" },
  { n: 5, label: "調整？", sub: "ingest" },
  { n: 6, label: "試玩驗收", sub: "verify" },
  { n: 7, label: "規則併回", sub: "archive" },
  { n: 8, label: "完成", sub: "done" },
];
// 提案目前在第幾格（1～8）
const stageOf = c => isPlan() ? planStageOf(c) : (c.archived ? 8 : c.status === "待驗收" ? 6 : c.status === "製作中" || c.status === "已同意" ? 4 : c.status === "待同意" ? 3 : 2);
const STAGE_HINT = { 3: "等企劃同意", 4: "AI 製作中", 6: "等試玩驗收", 8: "已完成" };
const STAGE_HINT_TECH = { 3: "等程式同意", 4: "AI 製作中", 6: "等程式審查 PR", 8: "已完成" };
// 企劃文件流的流程圖：上方兩條標準流程（介面向、系統向），下方每張進行中的提案一條泳道
function flowDiagramPlan() {
  const d = S.data, ST = planStages(), act = d.changes.filter(c => !c.archived).sort((a, b) => planStageOf(b) - planStageOf(a));
  const arc = d.changes.filter(c => c.archived);
  const rq = d.requests.filter(i => i.state === "open").length + d.feedback.filter(i => i.state === "open").length;
  let r = 1;
  const at = (col, row, html, cls = "cell") => `<div class="${cls}" style="grid-column:${col + 1};grid-row:${row}">${html}</div>`;
  const node = (id, ic, title, sub, cls = "", tip = "") => `<div class="node ${cls}" data-node="${id}"${tip ? ` title="${esc(tip)}"` : ""}>${I(ic, 18)}<b>${title}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
  let h = "";
  for (let i = 0; i <= ST.length; i++) h += `<div class="col-line" style="grid-column:${i + 1}"></div>`;
  h += `<div style="grid-column:1;grid-row:${r}"></div>` + ST.map(s => `<div class="head" style="grid-column:${s.n + 1};grid-row:${r}"><span class="num">${s.n}</span><b>${s.milestone ? "◆ " : ""}${esc(s.label)}</b><small>${esc(s.sub)}</small></div>`).join("");
  // 標準流程：介面向（7 格）
  r++;
  h += `<div class="lane-label" style="grid-column:1;grid-row:${r}"><span class="pill brand" title="直接影響畫面的功能：企劃書 → 示意圖＋SPEC → 美術／後端／前端並行">${I("layout", 15)}介面向</span></div>`;
  h += at(1, r, node("u1", "lightbulb", "需求", "需求池、回饋"));
  h += at(2, r, node("u2", "fileText", "企劃書", "Notion，repo 放連結"));
  h += at(3, r, node("u3", "layout", "示意圖＋SPEC", "AI 依企劃書做"));
  h += at(4, r, node("u4", "checkCircle", "需求確認 M1", "需求會議"));
  h += at(5, r, node("u5", "users", "並行製作", "美術 ◆M2／後端／前端"));
  h += at(6, r, node("u6", "flask", "驗收", "SPEC 驗收條件"));
  h += at(7, r, node("u7", "archive", "完成", "歸檔"));
  // 標準流程：系統向（跳過示意圖）
  r++;
  h += `<div class="lane-label" style="grid-column:1;grid-row:${r}"><span class="pill" style="background:var(--line-strong);color:var(--ink)" title="只動後端邏輯、資料，畫面沒有明顯改變：只有企劃書">${I("code", 15)}系統向</span></div>`;
  h += at(1, r, node("s1", "lightbulb", "需求", ""));
  h += at(2, r, node("s2", "fileText", "企劃書", "Notion"));
  h += at(4, r, node("s4", "checkCircle", "需求確認 M1", ""));
  h += at(5, r, node("s5", "code", "製作", "後端（需要時加前端）"));
  h += at(6, r, node("s6", "flask", "驗收", ""));
  h += at(7, r, node("s7", "archive", "完成", ""));
  // 每張進行中的提案
  r++;
  h += `<div class="lane-title" style="grid-row:${r}">進行中的提案（${act.length}）</div>`;
  const lanes = [];
  for (const c of act) {
    r++;
    const st = planStageOf(c);
    lanes.push({ id: c.id, row: r, st });
    h += `<div class="lane-label" style="grid-column:1;grid-row:${r}"><button class="pill change" data-change="${esc(c.id)}"><span>${esc(short(c.title, 18))}</span><small>${c.optimize ? "優化・" : ""}${esc(c.docs)}</small></button></div>`;
    for (const s of ST) {
      if (s.n === 3 && c.docs !== "介面向") { h += at(3, r, `<span data-node="${esc(c.id)}:3" class="node todo" style="opacity:.35"></span>`, "cell small"); continue; }
      const ms = s.milestone ? c.plan?.milestones?.[s.milestone] : null;
      if (s.n < st) h += at(s.n, r, `<div class="node done" data-node="${esc(c.id)}:${s.n}" title="${esc(s.label)}：完成${ms?.note ? "・" + esc(ms.note) : ""}">${I("check", 16)}</div>`, "cell small");
      else if (s.n === st) h += at(s.n, r, `<div class="node current" data-node="${esc(c.id)}:${s.n}" data-change="${esc(c.id)}" title="${esc(s.label)}">${I(s.n === 5 ? "users" : s.n === 6 ? "flask" : s.milestone ? "checkCircle" : "fileText", 16)}${s.n === 5 ? `<small>${esc(lanesText(c))}</small>` : ""}</div>`, "cell small");
      else h += at(s.n, r, `<span class="node todo" data-node="${esc(c.id)}:${s.n}"></span>`, "cell small");
    }
  }
  if (!act.length) { r++; h += `<div class="lane-label" style="grid-column:1;grid-row:${r}"></div><div class="empty" style="grid-column:2 / -1;grid-row:${r};z-index:1">目前沒有進行中的提案。對 AI 說「把 <需求> 開成提案」。</div>`; }
  r++;
  h += `<div class="lane-sep" style="grid-row:${r}"></div>`;
  r++;
  h += `<div class="lane-label" style="grid-column:1;grid-row:${r}"><span class="pill" style="background:var(--line-strong);color:var(--ink)">${I("archive", 15)}其他</span></div>`;
  h += at(1, r, `<div class="node clickable" data-go="issues">${I("lightbulb", 18)}<b>${rq} 則</b><small>還沒處理的需求／回饋</small></div>`);
  h += at(7, r, `<div class="node clickable" data-go="changes">${I("archive", 18)}<b>${arc.length} 張</b><small>已完成的提案</small></div>`);
  return { html: `<div class="flow-wrap"><div class="flow plan" id="flow">${h}<svg class="links" id="flowLinks"></svg></div></div>`, lanes };
}
// 企劃文件流的連接線：介面向 u1→u7、系統向 s1→s2→s4→…、每條泳道完成綠色／之後灰虛線
function drawFlowLinksPlan(lanes) {
  const flow = $("#flow"), svg = $("#flowLinks"); if (!flow || !svg) return;
  const box = flow.getBoundingClientRect();
  const pos = id => { const el = flow.querySelector(`[data-node="${CSS.escape(id)}"]`); if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left - box.left, r: r.right - box.left, t: r.top - box.top, b: r.bottom - box.top, cx: (r.left + r.right) / 2 - box.left, cy: (r.top + r.bottom) / 2 - box.top }; };
  const paths = [];
  const hline = (a, b, cls = "") => { const A = pos(a), B = pos(b); if (A && B) paths.push(`<path class="${cls}" d="M${A.r} ${A.cy} H${B.l}"/>`); };
  ["u1", "u2", "u3", "u4", "u5", "u6", "u7"].reduce((p, c) => (hline(p, c, "on"), c));
  ["s1", "s2", "s4", "s5", "s6", "s7"].reduce((p, c) => (hline(p, c, "tech"), c));
  for (const L of lanes) {
    const pts = [1, 2, 3, 4, 5, 6, 7].map(n => pos(`${L.id}:${n}`)).filter(Boolean);
    for (let i = 1; i < pts.length; i++) paths.push(`<path class="${i + 1 <= L.st ? "done" : "dash"}" d="M${pts[i - 1].r} ${pts[i - 1].cy} H${pts[i].l}"/>`);
  }
  svg.setAttribute("viewBox", `0 0 ${flow.scrollWidth} ${flow.scrollHeight}`);
  const arrows = [["base", "var(--line-strong)"], ["on", "var(--accent)"], ["tech", "var(--violet)"], ["done", "var(--ok)"]]
    .map(([k, c]) => `<marker id="ar-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" style="fill:${c}"/></marker>`).join("");
  svg.innerHTML = `<defs>${arrows}</defs>` + paths.join("");
}
function flowDiagram() {
  const d = S.data, act = d.changes.filter(c => !c.archived).sort((a, b) => stageOf(b) - stageOf(a));
  const arc = d.changes.filter(c => c.archived);
  const rq = d.requests.filter(i => i.state === "open").length + d.feedback.filter(i => i.state === "open").length;
  let r = 1;
  const at = (col, row, html, cls = "cell") => `<div class="${cls}" style="grid-column:${col + 1};grid-row:${row}">${html}</div>`;
  const node = (id, ic, title, sub, cls = "", tip = "") => `<div class="node ${cls}" data-node="${id}"${tip ? ` title="${esc(tip)}"` : ""}>${I(ic, 18)}<b>${title}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
  let h = "";
  for (let i = 0; i <= 8; i++) h += `<div class="col-line" style="grid-column:${i + 1}"></div>`;
  h += `<div style="grid-column:1;grid-row:${r}"></div>` + STAGES.map(s => `<div class="head" style="grid-column:${s.n + 1};grid-row:${r}"><span class="num">${s.n}</span><b>${s.label}</b><small>${s.sub}</small></div>`).join("");
  // 標準流程（範本泳道）
  r++;
  h += `<div class="lane-label" style="grid-column:1;grid-row:${r}"><span class="pill brand" title="玩家看得到的改變：玩法、畫面、數值、文字">${I("fileText", 15)}企劃提案</span></div>`;
  h += at(1, r, node("t1", "lightbulb", "提需求／回饋", "管理台、GitHub"));
  h += at(2, r, node("t2", "fileText", "AI 寫提案", "推上去自動開討論串", "spectra", "Spectra：/spectra-propose"));
  h += at(3, r, node("t3", "thumbsUp", "企劃同意", "討論串、管理台或對話"));
  h += at(4, r, node("t4", "code", "AI 製作", "先寫測試再做", "spectra", "Spectra：/spectra-apply（先寫會失敗的測試，再做到測試全過、部署）"));
  h += at(5, r, node("t5", "help", "需求有變？", "製作中被要求調整"));
  h += at(6, r, node("t6", "flask", "試玩驗收", "照試玩清單試玩", "spectra", "QA 或企劃照試玩清單試，全部通過後說「驗收通過」（Spectra：/spectra-verify）"));
  h += at(7, r, node("t7", "archive", "併回規則書", "驗收後歸檔", "spectra", "Spectra：/spectra-archive"));
  h += at(8, r, node("t8", "checkCircle", "完成", "討論串自動關閉"));
  r++;
  h += at(2, r, node("t2b", "discuss", "先討論", "需求不清楚時", "spectra ghost", "Spectra：/spectra-discuss（先討論，不改程式）"), "cell");
  h += at(5, r, node("t5b", "ingest", "改提案", "改完要再同意一次", "spectra", "Spectra：/spectra-ingest"), "cell");
  // 技術提案：程式同意、在分支做、開 PR 給程式審查，合併才上線
  r++;
  h += `<div class="lane-label" style="grid-column:1;grid-row:${r}"><span class="pill tech" title="玩家看不到的改變：重構、效能、工具、測試；不改規則書">${I("code", 15)}技術提案</span></div>`;
  h += at(1, r, node("k1", "wrench", "程式提出", "重構、效能、工具", "tech"));
  h += at(2, r, node("k2", "fileText", "寫技術提案", "AI 寫・類型：技術", "tech"));
  h += at(3, r, node("k3", "thumbsUp", "程式同意", "勾「程式同意」", "tech"));
  h += at(4, r, node("k4", "code", "分支製作", "AI 先寫測試再做", "tech", "分支 tech/<名稱>"));
  h += at(5, r, node("k5", "gitPr", "開 PR", "GitHub 自動跑測試", "tech"));
  h += at(6, r, node("k6", "users", "程式審查", "要求修改 → AI 改", "tech"));
  h += at(7, r, node("k7", "checkCircle", "合併", "不改規則書", "tech"));
  h += at(8, r, node("k8", "rocket", "上線", "部署、通知", "tech"));
  // 每張進行中的提案
  r++;
  h += `<div class="lane-title" style="grid-row:${r}">進行中的提案（${act.length}）</div>`;
  const lanes = [];
  for (const c of act) {
    r++;
    const st = stageOf(c);
    lanes.push({ id: c.id, row: r, st });
    h += `<div class="lane-label" style="grid-column:1;grid-row:${r}"><button class="pill change${c.kind === "技術" ? " is-tech" : ""}" data-change="${esc(c.id)}"><span>${esc(short(c.title, 18))}</span><small>${c.kind === "技術" ? "技術・" : ""}${esc(c.id)}</small></button></div>`;
    for (const s of STAGES) {
      if (s.n === 5) { h += at(5, r, `<span data-node="${c.id}:5" class="node todo" style="opacity:.35"></span>`, "cell small"); continue; }
      if (s.n < st) h += at(s.n, r, `<div class="node done" data-node="${c.id}:${s.n}" title="${s.label}：完成">${I("check", 16)}</div>`, "cell small");
      else if (s.n === st) h += at(s.n, r, `<div class="node current${c.kind === "技術" ? " tech" : ""}" data-node="${c.id}:${s.n}" data-change="${esc(c.id)}">${I(st === 3 ? "thumbsUp" : st === 4 ? "code" : st === 6 ? "flask" : "fileText", 18)}<b>${esc((c.kind === "技術" ? STAGE_HINT_TECH : STAGE_HINT)[st] || s.label)}</b><small>${st === 4 ? `任務 ${c.tasks.done}/${c.tasks.total}` : st === 6 && c.qa ? `清單 ${c.qa.done}/${c.qa.total}${c.qa.failed ? `・${c.qa.failed} 不通過` : ""}` : esc(c.status)}</small></div>`, "cell small");
      else h += at(s.n, r, `<span class="node todo" data-node="${c.id}:${s.n}"></span>`, "cell small");
    }
  }
  if (!act.length) { r++; h += `<div class="lane-label" style="grid-column:1;grid-row:${r}"></div><div class="empty" style="grid-column:2 / -1;grid-row:${r};z-index:1">目前沒有進行中的提案。新想法用「提需求」，再對 AI 說「看需求」。</div>`; }
  // 需求池、已完成
  r++;
  h += `<div class="lane-sep" style="grid-row:${r}"></div>`;
  r++;
  h += `<div class="lane-label" style="grid-column:1;grid-row:${r}"><span class="pill" style="background:var(--line-strong);color:var(--ink)">${I("archive", 15)}其他</span></div>`;
  h += at(1, r, `<div class="node clickable" data-go="issues">${I("lightbulb", 18)}<b>${rq} 則</b><small>還沒處理的需求／回饋</small></div>`);
  h += at(8, r, `<div class="node clickable" data-go="changes">${I("archive", 18)}<b>${arc.length} 張</b><small>已完成的提案</small></div>`);
  return { html: `<div class="flow-wrap"><div class="flow" id="flow">${h}<svg class="links" id="flowLinks"></svg></div></div>`, lanes };
}
// 畫連接線：依實際排版位置計算（視窗改變大小時重畫）
function drawFlowLinks(lanes) {
  const flow = $("#flow"), svg = $("#flowLinks"); if (!flow || !svg) return;
  const box = flow.getBoundingClientRect();
  const pos = id => { const el = flow.querySelector(`[data-node="${CSS.escape(id)}"]`); if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left - box.left, r: r.right - box.left, t: r.top - box.top, b: r.bottom - box.top, cx: (r.left + r.right) / 2 - box.left, cy: (r.top + r.bottom) / 2 - box.top }; };
  const R = 10, paths = [];
  const hline = (a, b, cls = "") => { const A = pos(a), B = pos(b); if (A && B) paths.push(`<path class="${cls}" d="M${A.r} ${A.cy} H${B.l}"/>`); };
  // 標準流程主線
  ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"].reduce((p, c) => (hline(p, c, "on"), c));
  ["k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8"].reduce((p, c) => (hline(p, c, "tech"), c));
  // discuss → propose（從下方繞上來）
  const dA = pos("t2b"), dB = pos("t2");
  if (dA && dB) paths.push(`<path class="on dash" d="M${dA.cx} ${dA.t} V${dB.b}"/>`);
  // 調整？→ 是 → ingest → 回到「企劃同意」（技術提案的「改提案」也一樣回到程式同意）
  const a5 = pos("t5"), b5 = pos("t5b"), a3 = pos("t3");
  if (a5 && b5 && a3) {
    paths.push(`<path class="on" d="M${a5.cx} ${a5.b} V${b5.t}"/>`);
    paths.push(`<path class="on" d="M${b5.l} ${b5.cy} H${a3.cx + R} Q${a3.cx} ${b5.cy} ${a3.cx} ${b5.cy - R} V${a3.b}"/>`);
    paths.push(`<text x="${a5.cx + 6}" y="${(a5.b + b5.t) / 2 + 4}">是</text>`);
    const a6 = pos("t6"); if (a6) paths.push(`<text class="sm" text-anchor="middle" x="${(a5.r + a6.l) / 2}" y="${a5.cy - 5}">否</text>`); // 兩格之間只有十幾 px：置中、字小一點，才不會壓到格子
  }
  // 每條泳道：完成的部分綠色、之後灰色虛線
  for (const L of lanes) {
    const pts = [1, 2, 3, 4, 5, 6, 7, 8].map(n => pos(`${L.id}:${n}`)).filter(Boolean);
    for (let i = 1; i < pts.length; i++) {
      paths.push(`<path class="${i + 1 <= L.st ? "done" : "dash"}" d="M${pts[i - 1].r} ${pts[i - 1].cy} H${pts[i].l}"/>`);
    }
  }
  svg.setAttribute("viewBox", `0 0 ${flow.scrollWidth} ${flow.scrollHeight}`);
  // 箭頭：每種線一個顏色（marker 的顏色要自己指定，不會跟著線）
  const arrows = [["base", "var(--line-strong)"], ["on", "var(--accent)"], ["tech", "var(--violet)"], ["done", "var(--ok)"]]
    .map(([k, c]) => `<marker id="ar-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" style="fill:${c}"/></marker>`).join("");
  svg.innerHTML = `<defs>${arrows}</defs>` + paths.join("");
}
let flowLanes = [];
const redrawFlowLinks = () => (isPlan() ? drawFlowLinksPlan : drawFlowLinks)(flowLanes);
addEventListener("resize", () => { if (S.view === "flow" && S.flowMode === "diagram") redrawFlowLinks(); });

function flowTreeHtml() {
  const d = S.data, f = S.treeFilter.trim().toLowerCase();
  const match = c => !f || (c.title + c.id).toLowerCase().includes(f);
  const act = d.changes.filter(c => !c.archived && match(c)), arc = d.changes.filter(c => c.archived && match(c));
  const ch = c => {
    const a = c.artifacts || {}, t = c.tasks;
    const art = (ok, ic, label, extra = "") => `<li><div class="tnode"><span class="tw leaf"></span><span class="${ok ? "ck" : "ck-no"}">${I(ok ? "checkCircle" : "circle", 15)}</span>${I(ic, 14)}<span class="lbl">${label}</span>${extra}</div></li>`;
    return `<li class="${c.archived ? "closed" : ""}"><div class="tnode clickable" data-change="${esc(c.id)}"><button class="tw">${I("chevronDown", 14)}</button>${chip(c.status)}<span class="lbl"><b>${esc(c.title)}</b> <span class="muted">${esc(c.id)}</span></span><span class="meta">${barHtml(c)}<span class="muted">${t.done}/${t.total}</span></span></div>
      <ul>${art(a.proposal, "fileText", "說明 proposal")}${art(a.specs, "scroll", "規則差異", c.capabilities?.length ? `<span class="meta muted">${esc(c.capabilities.join("、"))}</span>` : "")}${art(a.design, "wrench", "設計 design")}
      ${isPlan() ? "" : art(c.archived || t.approved, "thumbsUp", `${approverOf(c)}同意`, t.approvalNote ? `<span class="meta muted">${esc(short(t.approvalNote, 30))}</span>` : "")}
      <li class="${c.archived ? "closed" : ""}"><div class="tnode"><button class="tw">${I("chevronDown", 14)}</button>${I("list", 14)}<span class="lbl">任務 tasks</span><span class="meta muted">${t.done}/${t.total}</span></div><ul>${taskTree(t.groups, false)}</ul></li></ul></li>`;
  };
  const issues = (list, ic, label) => `<li class="closed"><div class="tnode"><button class="tw">${I("chevronDown", 14)}</button>${I(ic, 14)}<span class="lbl"><b>${label}</b></span><span class="meta muted">${list.length}</span></div><ul>${list.map(i => `<li><div class="tnode"><span class="tw leaf"></span><a class="lbl" href="${esc(i.url)}" target="_blank" rel="noopener">#${i.number} ${esc(i.title)}</a></div></li>`).join("") || `<li><div class="tnode muted"><span class="tw leaf"></span>沒有</div></li>`}</ul></li>`;
  const stage = (ic, label, list, closed) => `<li class="${closed ? "closed" : ""}"><div class="tnode"><button class="tw">${I("chevronDown", 14)}</button>${I(ic, 14)}<span class="lbl"><b>${label}</b></span><span class="meta muted">${list.length}</span></div><ul>${list.map(ch).join("") || `<li><div class="tnode muted"><span class="tw leaf"></span>沒有</div></li>`}</ul></li>`;
  const by = s => act.filter(c => c.status === s);
  return `<div class="card"><div class="row" style="margin-bottom:10px"><input class="search" id="treeSearch" placeholder="搜尋提案…" value="${esc(S.treeFilter)}"><button class="btn sm" data-tree="open">全部展開</button><button class="btn sm" data-tree="close">全部收合</button></div>
    <ul class="tree" id="flowTree"><li><div class="tnode"><button class="tw">${I("chevronDown", 14)}</button>${I("folder", 14)}<span class="lbl"><b>${esc(d.name)}</b></span><span class="meta muted">${d.changes.length} 張提案${isPlan() ? "" : `・${d.specs.length} 份規則書`}</span></div><ul>
      ${issues(d.requests.filter(i => i.state === "open"), "lightbulb", "需求（還沒處理）")}
      ${issues(d.feedback.filter(i => i.state === "open"), "gamepad", "回饋（還沒處理）")}
      ${isPlan()
        ? planStages().filter(s => s.n !== 7).map(s => stage(s.milestone ? "checkCircle" : "workflow", `${s.n}. ${esc(s.label)}`, act.filter(c => planStageOf(c) === s.n), false)).join("") + stage("archive", "待歸檔", act.filter(c => planStageOf(c) === 7), false) + stage("archive", "已完成", arc, !f)
        : `${stage("hourglass", "待同意", by("待同意"), false)}${stage("thumbsUp", "已同意", by("已同意"), false)}${stage("code", "製作中", by("製作中"), false)}${stage("flask", "待驗收", by("待驗收"), false)}${stage("archive", "已完成", arc, !f)}`}
      ${isPlan() ? "" : `<li class="closed"><div class="tnode"><button class="tw">${I("chevronDown", 14)}</button>${I("scroll", 14)}<span class="lbl"><b>規則書</b></span><span class="meta muted">${d.specs.length}</span></div><ul>${d.specs.map(s => `<li><div class="tnode clickable" data-go="specs/${esc(s.name)}"><span class="tw leaf"></span><span class="lbl">${esc(s.name)} <span class="muted">${esc(short(s.purpose, 40))}</span></span><span class="meta muted">${s.requirements} 條</span></div></li>`).join("")}</ul></li>`}
    </ul></li></ul></div>`;
}
V.flow = () => {
  const seg = `<div class="seg" role="group" aria-label="顯示方式"><button data-flowmode="diagram" aria-pressed="${S.flowMode === "diagram"}">${I("workflow", 14)}流程圖</button><button data-flowmode="tree" aria-pressed="${S.flowMode === "tree"}">${I("tree", 14)}結構樹</button></div>`;
  if (S.flowMode === "tree") return vh("workflow", "流程圖", "專案 → 階段 → 提案 → 文件與任務", seg) + flowTreeHtml();
  const { html, lanes } = isPlan() ? flowDiagramPlan() : flowDiagram();
  flowLanes = lanes;
  setTimeout(() => (isPlan() ? drawFlowLinksPlan : drawFlowLinks)(lanes), 0);
  const sub = isPlan() ? "上方是兩條標準流程（介面向、系統向）；下方每張進行中的提案一條泳道，◆ 是里程碑（M1 需求確認、M2 規格確認）" : "上方是兩條標準流程（企劃提案、技術提案）；下方每張進行中的提案一條泳道，亮色格子＝目前在這一步";
  return vh("workflow", "流程圖", sub, seg) + html +
    `<div class="legend"><span><span class="node done" style="width:16px;height:16px">${I("check", 10)}</span>完成</span><span><span class="lg" style="background:var(--accent);border-color:var(--accent)"></span>目前這一步（點開看明細）</span><span><span class="node todo"></span>還沒到</span>${isPlan() ? "" : `<span><span class="lg" style="background:var(--accent-soft);border-color:var(--accent-line)"></span>Spectra 指令（AI 執行）</span>`}</div>`;
};
V.tree = () => { S.flowMode = "tree"; S.view = "flow"; return V.flow(); };

V.changes = () => {
  const d = S.data, list = [...d.changes].sort((a, b) => (sortKey(a) - sortKey(b)) || b.folder.localeCompare(a.folder));
  return vh("list", "提案", "點一列看明細與進度鏈") +
    `<div class="tablewrap"><table class="t stack"><thead><tr><th>狀態</th><th>提案</th><th>進度</th><th>${isPlan() ? "里程碑" : "同意"}</th><th>日期</th></tr></thead><tbody>
    ${list.map(c => `<tr class="click ${S.sel === c.id ? "sel" : ""}" data-change="${esc(c.id)}"><td>${chip(c.status)}</td><td><div style="font-weight:600">${esc(c.title)} ${kindChip(c)}</div><div class="muted" style="font-family:var(--mono)">${esc(c.id)}</div></td><td style="min-width:130px">${barHtml(c)}<div class="muted">${c.tasks.done}/${c.tasks.total}</div></td><td>${isPlan() ? msChip(c, "M1") + msChip(c, "M2") : c.archived || c.tasks.approved ? `<span class="ck">${I("checkCircle", 16)}</span>` : `<span class="ck-no">${I("circle", 16)}</span>`}</td><td class="muted">${esc(c.date || "進行中")}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">還沒有提案</td></tr>`}
    </tbody></table></div>`;
};

V.specs = () => {
  const d = S.data, open = S.arg;
  return vh("scroll", "規則書", "遊戲「現在」的規則：功能 → 規則 → 情境（每個情境對應一個自動測試）") +
    `<div class="card"><ul class="tree">${d.specs.map(s => `<li class="${open === s.name ? "" : "closed"}" id="spec-${esc(s.name)}"><div class="tnode"><button class="tw">${I("chevronDown", 14)}</button>${I("scroll", 14)}<span class="lbl"><b>${esc(s.name)}</b> <span class="muted">${esc(short(s.purpose, 70))}</span></span><span class="meta"><span class="muted">${s.requirements} 條・${s.scenarios} 情境</span><a class="chip" href="${blob(`${d.specDir}/specs/${s.name}/spec.md`)}" target="_blank" rel="noopener">${I("external", 12)}全文</a></span></div>
      <ul>${(s.reqs || []).map(r => `<li class="closed"><div class="tnode"><button class="tw">${I("chevronDown", 14)}</button><span class="lbl">${esc(r.zh || r.name)}</span><span class="meta muted">${r.scenarios.length} 情境</span></div><ul>${r.scenarios.map(x => `<li><div class="tnode"><span class="tw leaf"></span>${I("flask", 13)}<span class="lbl muted">${esc(x)}</span></div></li>`).join("")}</ul></li>`).join("")}</ul></li>`).join("") || `<li class="empty">還沒有規則書</li>`}</ul></div>`;
};

function docList(files, cur) {
  return `<div class="flist">${files.map(f => `<button data-doc="${esc(f.path)}" aria-current="${cur === f.path}">${I(f.ext === "csv" ? "table" : f.ext === "html" ? "layout" : "fileText", 15)}<span><b>${esc(f.title)}</b><small>${esc(f.path.replace(/^docs\/企劃\//, ""))}</small></span></button>`).join("") || `<div class="empty">沒有文件</div>`}</div>`;
}
V.content = () => {
  const cat = CATS.find(c => c.key === S.arg) || { label: "其他", ic: "fileText" };
  const files = (S.data.content || []).filter(f => catOf(f) === S.arg);
  const cur = S.doc && files.some(f => f.path === S.doc) ? S.doc : files[0]?.path;
  setTimeout(() => cur && openDoc(cur, "#reader"), 0);
  return vh(cat.ic, cat.label, `${files.length} 份`, ["mockups", "specsheets"].includes(S.arg) ? "" : `<button class="btn" data-newdoc="${esc(S.arg)}">${I("plus", 15)}新文件</button>`) +
    `<div class="split">${docList(files, cur)}<div class="doc" id="reader"><div class="muted">選一份文件</div></div></div>`;
};
V.files = () => {
  const files = (S.data.content || []).filter(f => f.ext === "md" || f.ext === "csv" || f.ext === "html");
  const cur = S.doc && files.some(f => f.path === S.doc) ? S.doc : files[0]?.path;
  setTimeout(() => cur && openDoc(cur, "#reader"), 0);
  return vh("files", "全部文件", esc((S.data.contentDirs || []).join("、"))) + `<div class="split">${docList(files, cur)}<div class="doc" id="reader"></div></div>`;
};

V.assets = () => {
  const content = S.data.content || [];
  const imgs = content.filter(f => IMG.test(f.ext)), audio = content.filter(f => /^(mp3|ogg|wav)$/.test(f.ext));
  const sheets = content.filter(f => f.ext === "csv" && /素材|asset/i.test(f.name));
  const docs = content.filter(f => f.ext === "md" && catOf(f) === "assets");
  setTimeout(() => sheets[0] && loadAssetSheet(sheets[0].path), 0);
  return vh("image", "素材庫", `圖片 ${imgs.length}・聲音 ${audio.length}・清單 ${docs.length}`, `<button class="btn primary" data-upload>${I("upload", 15)}上傳素材</button>`) +
    `${sheets.length ? `<div class="card"><h3>${I("table", 14)}素材進度</h3>
      <p class="muted flowline">${["待製作", "交件", "待確認", "採用／退回", "放進遊戲"].map((s, i) => `${i ? I("chevronRight", 12) : ""}<span>${s}</span>`).join("")}<span class="sep">｜</span>美術做好按「交件」；企劃看過按「採用」或「退回（附意見）」；採用的由 AI 在「同步」時放進遊戲。</p>
      <div id="assetSheet" class="muted">讀取中…</div></div>` : ""}
    <div class="card"><h3>${I("image", 14)}圖片</h3>${imgs.length ? `<div class="gallery">${imgs.map(f => `<div class="tile" data-img="${esc(f.path)}"><div class="im"><img loading="lazy" ${imgSrc(f.path)} alt="${esc(f.title)}"></div><p>${esc(f.name)}</p></div>`).join("")}</div>` : `<div class="empty">還沒有圖片</div>`}</div>
    ${audio.length ? `<div class="card"><h3>${I("volume", 14)}聲音</h3><ul class="list">${audio.map(f => `<li><div class="g">${esc(f.name)}</div><audio controls preload="none" src="${raw(f.path)}"></audio></li>`).join("")}</ul></div>` : ""}
    <div class="card"><h3>${I("fileText", 14)}素材清單與風格指南</h3><div class="row">${docs.map(f => `<button class="btn" data-doc-detail="${esc(f.path)}">${I("fileText", 14)}${esc(f.title)}</button>`).join("") || `<span class="muted">沒有</span>`}</div></div>`;
};
// 素材清單：登入可寫入時用 API 讀最新的（剛交件、剛採用的馬上看得到）；不然讀公開檔案。切換篩選不重新下載
async function loadAssetSheet(path, fresh = false) {
  const el = $("#assetSheet"); if (!el) return;
  try {
    const key = S.repo + ":" + path;
    if (fresh || S.assetText?.key !== key) {
      const text = canWrite() ? (await readFile(S.repo, path, S.data.branch)).text : await getText(path);
      S.assetText = { key, path, text };
    }
    renderAssetSheet(el, path, S.assetText.text);
  } catch (e) { el.textContent = "讀不到素材清單：" + e.message; }
}
const assetChip = s => `<span class="chip ${/已放進|完成|已採用/.test(s) ? "c-ok" : s === "待確認" ? "c-info" : /退回|修改|重做/.test(s) ? "c-bad" : /待/.test(s) ? "c-warn" : ""}">${esc(s)}</span>`;
function renderAssetSheet(el, path, text) {
  const rows = parseCsv(text), head = rows[0] || [];
  const body = rows.map((r, idx) => ({ r, idx })).slice(1).filter(x => x.r.some(Boolean));
  const iS = head.indexOf("狀態"), iC = head.indexOf("類別"), iD = head.indexOf("交件"), iF = head.indexOf("意見");
  const seen = [...new Set(body.map(x => x.r[iS]).filter(Boolean))];
  const states = ["全部", ...ASSET_STATES.filter(s => seen.includes(s)), ...seen.filter(s => !ASSET_STATES.includes(s))], cats = ["全部", ...new Set(body.map(x => x.r[iC]).filter(Boolean))];
  const show = body.filter(({ r }) => (S.assetFilter === "全部" || r[iS] === S.assetFilter) && (S.assetCat === "全部" || r[iC] === S.assetCat));
  const cnt = s => body.filter(x => x.r[iS] === s).length;
  const cols = head.map((h, i) => [h, i]).filter(([h]) => !/提示詞|Figma|^交件$|^意見$/.test(h));
  const files = r => (iD >= 0 ? r[iD] || "" : "").split(/[；;]/).map(s => s.trim()).filter(Boolean);
  const sent = r => `${files(r).map(p => IMG.test(p.split(".").pop().toLowerCase()) ? `<button class="thumb" data-img="${esc(p)}" title="${esc(p)}"><img loading="lazy" ${imgSrc(p)} alt=""></button>` : `<a href="${blob(p)}" target="_blank" rel="noopener">${esc(p.split("/").pop())}</a>`).join("")}${iF >= 0 && r[iF] ? `<div class="note">${I("message", 12)}${esc(r[iF])}</div>` : ""}`;
  const act = ({ r, idx }) => { const s = (r[iS] || "").trim();
    if (s === "待確認") return `<button class="btn sm ok" data-aok="${idx}">${I("check", 13)}採用</button><button class="btn sm" data-aback="${idx}">${I("x", 13)}退回</button>`;
    if (s === "已採用") return `<span class="muted">等 AI 放進遊戲</span>`;
    if (/已放進|完成/.test(s)) return "";
    return `<button class="btn sm" data-asend="${idx}">${I("upload", 13)}交件</button>`; };
  el.className = "";
  el.innerHTML = `${iS >= 0 ? `<div class="filters">${states.map(s => `<button class="fbtn" data-af="${esc(s)}" aria-pressed="${S.assetFilter === s}">${esc(s)} ${s !== "全部" ? cnt(s) : body.length}</button>`).join("")}</div>` : ""}
    ${iC >= 0 ? `<div class="filters">${cats.map(s => `<button class="fbtn" data-ac="${esc(s)}" aria-pressed="${S.assetCat === s}">${esc(s)}</button>`).join("")}</div>` : ""}
    <div class="tablewrap"><table class="t assets"><thead><tr>${cols.map(([h, i]) => `<th>${esc(h)}</th>${i === iS ? "<th></th><th>交件／意見</th>" : ""}`).join("")}</tr></thead><tbody>${show.map(x => `<tr>${cols.map(([, i]) => `<td>${i === iS ? assetChip(x.r[i] || "") : esc(x.r[i] || "")}</td>${i === iS ? `<td class="acts">${act(x)}</td><td class="sent">${sent(x.r)}</td>` : ""}`).join("")}</tr>`).join("") || `<tr><td colspan="${cols.length + 2}" class="empty">沒有這個狀態的素材</td></tr>`}</tbody></table></div>
    <p class="muted">來源：<a href="${blob(path)}" target="_blank" rel="noopener">${esc(path)}</a></p>`;
}
const assetRow = idx => { const rows = parseCsv(S.assetText?.text || ""), head = rows[0] || []; return { rows, head, r: rows[idx] || [], name: (rows[idx] || [])[Math.max(0, head.indexOf("檔名"))] || "" }; };
// 寫入素材清單後：畫面、待辦數字立刻更新（不用等 GitHub Actions）
function afterAssetSave(text) {
  S.assetText = { ...S.assetText, text };
  S.data.assets = { path: S.assetText.path, ...assetCounts(parseCsv(text)) };
  const el = $("#assetSheet"); if (el) renderAssetSheet(el, S.assetText.path, text);
}
async function doAssetSend(idx) {
  const { name } = assetRow(idx); if (!name) return;
  const dir = `${(S.data.contentDirs || ["docs/企劃"])[0]}/圖/交件`;
  if (!canWrite()) {
    const v = await dialog(`交件：${name}`, `<ol class="steps"><li>按「打開 GitHub 上傳頁」，把做好的檔案拖進去，按 <b>Commit changes</b></li><li>回來按「複製給 AI 的話」，貼到 Claude：AI 會把這一列改成「待確認」，企劃就會看到</li></ol><p class="muted">設定登入碼的話，可以直接在這裡上傳，一步完成。</p>`, [["", "取消"], ["say", "複製給 AI 的話"], ["ok", "打開 GitHub 上傳頁", "primary"]]);
    if (v === "ok") openWeb(web.upload(dir), "上傳完回來按「交件」→「複製給 AI 的話」");
    if (v === "say") copySay(`素材 ${name} 交件了`);
    return;
  }
  const v = await dialog(`交件：${name}`, `${target()}<label class="fld"><span>做好的檔案（可以多個，例如不同表情）</span><input name="files" type="file" accept="image/*,audio/*" multiple required></label><label class="fld"><span>給企劃的話（選填）</span><input name="note" placeholder="例：眼睛照上次意見放大了"></label><p class="muted">會放到 <code>${esc(dir)}/</code>，這一列改成「待確認」，企劃的待辦會出現。</p>`, [["", "取消"], ["ok", "交件", "primary"]]);
  if (v !== "ok") return;
  const f = $("#dlg form"), list = [...(f.files.files || [])], note = f.note.value.trim(); if (!list.length) return;
  toast("上傳中…", 30000);
  try {
    const paths = [];
    for (const file of list) {
      const r = await uploadFile(S.repo, `${dir}/${file.name}`, file, `素材交件：${name} 上傳 ${file.name}（管理台，${auth.user.login}）`, S.data.branch);
      paths.push(r.path);
      S.data.content.push({ path: r.path, name: r.path.split("/").pop(), ext: r.path.split(".").pop().toLowerCase(), size: file.size, title: r.path.split("/").pop() });
    }
    const { text } = await saveAssetRow(S.repo, S.assetText.path, idx, name, { 狀態: "待確認", 交件: paths.join("；"), 意見: note ? `美術：${note}` : "" }, `素材交件：${name}（管理台，${auth.user.login}）`, S.data.branch);
    afterAssetSave(text); toast(`已交件：${name}，等企劃確認`);
  } catch (e) { toast("交件失敗：" + e.message, 7000); }
}
async function doAssetReview(idx, ok) {
  const { name, r, head } = assetRow(idx); if (!name) return;
  const shots = (r[head.indexOf("交件")] || "").split(/[；;]/).map(s => s.trim()).filter(p => p && IMG.test(p.split(".").pop().toLowerCase()));
  const preview = shots.length ? `<div class="thumbs">${shots.map(p => `<img ${imgSrc(p)} alt="">`).join("")}</div>` : "";
  const v = await dialog(ok ? `採用：${name}` : `退回：${name}`, `${canWrite() ? target() : ""}${preview}${ok ? `<p>確定採用 <b>${esc(name)}</b>？採用後，對 AI 說「同步」就會把它放進遊戲。</p>` : `<label class="fld"><span>要怎麼改（美術會在待辦看到）</span><textarea name="why" required placeholder="例：眼睛再大一點，顏色跟第 1 區的招牌一樣亮"></textarea></label>`}${canWrite() ? "" : `<p class="muted">沒有登入碼：按下去會複製一句話，貼到 Claude，AI 會幫你改清單。</p>`}`, [["", "取消"], ["ok", ok ? "採用" : "退回", ok ? "ok" : "primary"]]);
  if (v !== "ok") return;
  const why = ok ? "" : $("#dlg form").why.value.trim();
  if (!ok && !why) return;
  if (!canWrite()) { copySay(ok ? `素材 ${name} 採用` : `素材 ${name} 退回：${why}`); return; }
  try {
    const { text } = await saveAssetRow(S.repo, S.assetText.path, idx, name, ok ? { 狀態: "已採用", 意見: "" } : { 狀態: "退回", 意見: `企劃：${why}` }, `素材${ok ? "採用" : "退回"}：${name}（管理台，${auth.user.login}）`, S.data.branch);
    afterAssetSave(text); toast(ok ? `已採用 ${name}：對 AI 說「同步」會放進遊戲` : `已退回 ${name}，美術會看到你的意見`, 6000);
  } catch (e) { toast((ok ? "採用" : "退回") + "失敗：" + e.message, 7000); }
}

// ---------- 試玩清單：勾選、不通過 ----------
async function doQaSet(id, i, done) {
  const c = S.data.changes.find(x => x.id === id); if (!c?.qa) return;
  if (!canTriage()) { openWeb(c.qa.url, `在 GitHub 的試玩清單${done ? "勾起" : "取消勾選"}第 ${i + 1} 項（手機 GitHub App 也可以勾）`); return; }
  try {
    const body = await qaSet(S.repo, c.qa.number, i, done);
    Object.assign(c.qa, parseQa(body)); render();
    toast(c.qa.done === c.qa.total ? `全部通過！企劃確認後對 AI 說「${c.id} 驗收通過」` : done ? "已勾：這項沒問題" : "已取消勾選", 5000);
  } catch (e) { toast("勾選失敗：" + e.message, 7000); }
}
async function doQaFail(id, i) {
  const c = S.data.changes.find(x => x.id === id); if (!c?.qa) return;
  const item = c.qa.items[i]?.text || "", inApp = canTriage();
  const v = await dialog(`不通過：第 ${i + 1} 項`, `${target()}<div class="ask">${esc(item)}</div>
    <label class="fld"><span>哪裡不對（越具體越好：第幾關、做了什麼、看到什麼）</span><textarea name="what" required placeholder="例：第 3 關還是看得到預測線，第 4 關才消失"></textarea></label>
    <div class="row"><label class="fld" style="flex:1"><span>用什麼玩</span><select name="device"><option>手機</option><option>平板</option><option>電腦</option></select></label><label class="fld" style="flex:1"><span>版本或日期（選填）</span><input name="version"></label></div>
    ${inApp ? `<label class="fld"><span>截圖（選填）</span><input name="shots" type="file" accept="image/*" multiple></label>` : `<p class="muted">會打開填好的 GitHub 回饋表單，截圖可以拖進去，按 Create 送出。</p>`}
    <p class="muted">會開一則 🔴 必修回饋，連到這張提案。AI 修好上線後，回來再試這一項。</p>`, [["", "取消"], ["ok", inApp ? "送出不通過" : "下一步：到 GitHub 送出", "primary"]]);
  if (v !== "ok") return;
  const f = $("#dlg form"), what = f.what.value.trim(); if (!what) return;
  const where = `試玩清單 #${c.qa.number} 第 ${i + 1} 項「${item}」（提案 ${c.id}）`, title = `🔴 試玩不通過：${c.title}－${clip(item, 24)}`;
  if (!inApp) {
    const fields = { title: `回饋：${title}`, level: "🔴 必修（不改不行）", version: f.version.value.trim(), what: `${what}\n\n${where}`, device: f.device.value };
    for (const k in fields) if (!fields[k]) delete fields[k];
    openWeb(web.issueForm("feedback", fields),"已打開 GitHub：按 Create 送出。之後對 AI 說「同步」，AI 會把回饋標回試玩清單");
    return;
  }
  toast("送出中…", 20000);
  try {
    const fb = await createIssue(S.repo, "回饋", { __title: title, "等級": "🔴 必修（不改不行）", "試玩的版本或日期": f.version.value.trim(), "發生什麼事／想要什麼感覺": what, "用什麼玩": f.device.value, "試玩清單": where }, [...(f.shots.files || [])], S.data.branch, (S.data.contentDirs || ["docs/企劃"])[0]);
    S.data.feedback.unshift({ number: fb.number, title: fb.title, url: fb.html_url, state: "open", created: fb.created_at, user: auth.user.login, labels: ["回饋"], comments: 0 });
    Object.assign(c.qa, parseQa(await qaFail(S.repo, c.qa.number, i, fb.number))); render();
    toast(`已開回饋 #${fb.number}（🔴 必修）；對 AI 說「看回饋」就會修`, 7000);
  } catch (e) { toast("送出失敗：" + e.message, 7000); }
}

V.tools = () => {
  const tools = toolsOf(S.data);
  return vh("puzzle", "工具與外掛", "框架以外、這個專案自己加的工具") +
    `<div class="card"><h3>${I("puzzle", 14)}這個專案的工具</h3>${tools.length ? `<div class="tools">${tools.map(t => `<a class="tool" href="${esc(t.url)}" target="_blank" rel="noopener"><span class="ti">${I(hasIcon(t.icon) ? t.icon : "wrench", 18)}</span><span><b>${esc(t.label)}</b><small>${esc(t.desc || t.url)}</small></span></a>`).join("")}</div>` : `<div class="empty">這個專案還沒有專案工具</div>`}</div>
    <div class="card md"><h3>${I("help", 14)}什麼是專案工具（外掛）</h3>
      <p>基本框架（流程、提案、規則書、內容庫、素材庫、回饋）是<b>所有專案共用</b>的。每個遊戲常會需要自己的工具——例如彈珠的「關卡編輯器」、RPG 的「對話編輯器」、卡牌遊戲的「卡片數值試算」——這些就是<b>專案工具</b>，只出現在那個專案。</p>
      <p><b>怎麼加</b>：在專案的 <code>workbench.config.json</code> 加 <code>tools</code>：</p>
      <pre><code>"tools": [
  { "label": "關卡編輯器", "url": "https://…/editor.html", "icon": "wrench", "desc": "畫磚塊與台面，複製回關卡表" }
]</code></pre>
      <p>推上 GitHub 約 1 分鐘後，左側選單「專案工具」就會出現。工具本身（網頁）由 AI 用提案開發，放在專案的 <code>web/</code> 底下，跟遊戲一起部署。</p>
      <p class="muted">可用的圖示：wrench、table、chart、image、gamepad、code、flask、book、users、globe、tag、play、sparkles。</p></div>`;
};

V.issues = () => {
  const d = S.data, li = i => `<li><span class="status-dot ${i.state === "open" ? "" : "ok"}"></span><div class="g"><a class="t1" href="${esc(i.url)}" target="_blank" rel="noopener" style="color:var(--ink)">${esc(i.title)}</a><div class="muted">#${i.number}・${esc(i.user || "")}・${ago(i.created)}${i.comments ? `・${i.comments} 則留言` : ""}</div></div>${i.state === "open" ? sayBtn(`把 #${i.number} 開成提案`) : ""}</li>`;
  const open = l => l.filter(i => i.state === "open"), closed = [...d.feedback, ...d.requests].filter(i => i.state !== "open");
  return vh("message", "回饋與需求", "", issueBtns(true)) +
    `<div class="grid2" style="margin-top:0"><div class="card"><h3>${I("gamepad", 14)}回饋（還沒處理）</h3><ul class="list">${open(d.feedback).map(li).join("") || `<li class="empty">沒有</li>`}</ul></div>
    <div class="card"><h3>${I("lightbulb", 14)}需求（還沒處理）</h3><ul class="list">${open(d.requests).map(li).join("") || `<li class="empty">沒有</li>`}</ul></div>
    <div class="card"><h3>${I("checkCircle", 14)}已處理</h3><ul class="list">${closed.map(li).join("") || `<li class="empty">還沒有</li>`}</ul></div></div>`;
};
V.activity = () => vh("rocket", isPlan() ? "改動紀錄" : "上線紀錄") + `<div class="grid2" style="margin-top:0">${(S.data.pulls || []).length ? `<div class="card"><h3>${I("git", 14)}等程式審查的 PR</h3><ul class="list">${S.data.pulls.map(p => `<li><span class="status-dot info"></span><div class="g"><a class="t1" href="${esc(p.url)}" target="_blank" rel="noopener" style="color:var(--ink)">#${p.number} ${esc(p.title)}</a><div class="muted">${esc(p.user || "")}・${ago(p.created)}${p.draft ? "・草稿" : ""}</div></div><a class="btn sm" href="${esc(p.url)}/files" target="_blank" rel="noopener">看改了什麼</a></li>`).join("")}</ul></div>` : ""}<div class="card"><h3>${I("rocket", 14)}自動測試與部署</h3><ul class="list">${S.data.runs.map(runLi).join("") || `<li class="empty">還沒有紀錄</li>`}</ul></div>
  <div class="card"><h3>${I("git", 14)}最近的改動</h3><ul class="list">${S.data.commits.map(c => `<li><div class="g"><a class="t1" href="${esc(c.url)}" target="_blank" rel="noopener" style="color:var(--ink)">${esc(c.subject)}</a><div class="muted">${esc(c.author)}・${ago(c.date)}・<span style="font-family:var(--mono)">${esc(c.sha)}</span></div></div></li>`).join("")}</ul></div></div>`;

V.projects = () => vh("folder", "專案目錄", "點卡片切換專案") +
  `<div class="projects" id="plist">${S.projects.map(p => `<div class="card pcard ${p.repo === S.repo ? "cur" : ""}" data-proj="${esc(p.repo)}"><div class="row"><span class="pdot" style="width:8px;height:8px;border-radius:50%;background:var(--accent)"></span><b>${esc(p.name || p.repo)}</b>${p.local ? '<span class="chip">只在這台</span>' : ""}</div><div class="muted" style="font-family:var(--mono);margin-top:4px">${esc(p.repo)}</div><p class="muted" style="margin:6px 0">${esc(p.note || "")}</p><div class="muted" data-psum="${esc(p.repo)}">讀取中…</div></div>`).join("")}</div>
  <div class="card" style="margin-top:14px"><h3>${I("plus", 14)}加入專案</h3><div class="row"><input class="search" id="addRepo" placeholder="帳號/專案（例：fishon100/pinball-sling）"><button class="btn primary" id="addBtn">加入</button></div>
  <p class="muted">專案要先有 workbench Action（用 game-dev-flow-template 建的專案都有）。這裡加的只存在你這台瀏覽器；要讓全隊看到，請把專案加進範本的 <code>web/console/projects.json</code>。</p></div>`;

// 名詞小抄：介面上的用語
const GLOSSARY = [
  ["提案", "AI 寫的「要改什麼、為什麼」，企劃同意後才會做。一張提案包含說明、會改到的規則、設計、任務清單"],
  ["規則書", "遊戲「現在」的運作規則（也叫規格書）。只能透過提案改，每條規則都有自動測試"],
  ["規劃書", "企劃寫的想法與方向（企劃書），可以隨時改。想做的事要開提案才會進規則書"],
  ["企劃文件流", "平台專案的流程：企劃書（Notion）→ 示意圖＋SPEC → 需求確認 M1 → 美術／後端／前端並行（美術完成約九成後規格確認 M2）→ 驗收。程式由公司團隊做，管理台只追進度"],
  ["里程碑", "M1 需求確認、M2 規格確認：企劃對 AI 說「X 需求確認了」「X 規格確認了」，AI 在 tasks.md 勾起來並記日期。取代遊戲專案的「同意」"],
  ["待同意", "提案寫好了，等企劃看過按同意（技術提案由程式同意）"],
  ["試玩清單", "提案做完、上線後自動開的清單（GitHub 討論串，手機 App 也能勾）：QA 或企劃一項一項試，沒問題就勾；不通過會自動開 🔴 必修回饋。全部勾完再說「驗收通過」"],
  ["素材確認", "美術在素材庫按「交件」上傳 → 狀態變「待確認」→ 企劃按「採用」或「退回（附意見）」→ 採用的由 AI 在「同步」時放進遊戲，狀態變「已放進遊戲」"],
  ["技術提案", "程式提出的重構、效能、工具等改動，不改玩法和規則書。由程式同意，做完開 PR，程式審查合併後才上線"],
  ["已同意／製作中", "企劃同意了；AI 正在照任務清單做（進度條＝完成的任務）"],
  ["待驗收", "做完、已上線：請試玩，沒問題就說「xxx 驗收通過」"],
  ["已完成", "驗收通過，規則已併回規則書"],
  ["討論串", "GitHub 上的 Issue。每張提案、每則回饋和需求都有一個，可以留言、勾同意"],
  ["PR", "AI 或程式做好的修改，等程式審查後才會合併上線"],
  ["對 AI 說", "管理台不會自己叫 AI。按「對 AI 說…」會複製一句指令，貼到 Claude（電腦，或手機的 Remote Control）；AI 做完，管理台約 1 分鐘內更新"],
  ["【美術】等標記", "提案任務開頭的角色標記，會出現在該角色的「我的待辦」"],
  ["登入碼", "選用。讓你不用跳到 GitHub，直接在管理台送出；不登入也可以做所有事"],
];
V.help = () => vh("help", "說明") + `<div class="grid2" style="margin-top:0"><div class="card md">
  <h2>這是什麼</h2><p>專案的管理台：所有專案、每張提案的進度、規則書、劇本與角色等企劃內容、素材都在這裡。首頁會依你的角色列出「我的待辦」。</p>
  <h2>不登入也能用</h2><p>按「同意」「寫回饋」「編輯」「上傳」時，會打開已經填好的 GitHub 網頁，在那裡按一下送出就完成——只要你的瀏覽器有登入 github.com（手機可以用 GitHub App）。想留在管理台裡直接送出、附截圖，再到右上角「登入」設定登入碼。</p>
  <h2>流程圖</h2><p>上方是兩條<b>標準流程</b>：<b>企劃提案</b>（玩法、畫面、數值；企劃同意、試玩驗收）與<b>技術提案</b>（重構、效能、工具；程式同意、開 PR 給程式審查、合併才上線）；下方每張<b>進行中的提案</b>一條泳道：綠色勾＝走過、亮色格子＝目前在這一步（點開看明細）、空心點＝還沒到。右上角可以切到「結構樹」看每一份文件與任務。</p>
  <h2>同意提案</h2><p>在首頁或提案明細按「同意」；也可以在 GitHub 討論串勾 ☐ 企劃同意、Spectra 桌面版勾任務 0.1、Notion 改「同意」，或對 AI 說「同意 xxx」。</p>
  <h2>AI 怎麼配合管理台</h2><p>管理台是給人<b>看進度、做決定</b>的地方（同意、回饋、編輯）；<b>叫 AI 做事一律在 Claude 裡下指令</b>。需要 AI 的地方會有「對 AI 說…」按鈕：按一下複製指令，貼到 Claude 就好。AI 寫好的提案、做完的任務、處理過的回饋，推上 GitHub 後約 1 分鐘就會出現在管理台。</p>
  <h2>內容庫與素材庫</h2><p>劇本、角色、世界觀、名詞、數值、規劃書。每份文件右上角有「編輯」，分類頁有「新文件」。素材庫的素材進度表：美術做好按「交件」，企劃按「採用」或「退回」，採用的由 AI 放進遊戲。</p>
  <h2>試玩清單（QA）</h2><p>提案做完、上線後，會自動開一份試玩清單。角色選「QA」（或企劃自己試），在提案明細一項一項勾；有問題按「不通過」寫下哪裡怪，會自動開一則 🔴 必修回饋。全部通過後企劃說「驗收通過」。</p>
  <h2>資料多新</h2><p>推上 GitHub、討論串或 PR 有變動、部署完成時自動更新（約 1 分鐘），另外每小時一次。</p></div>
  <div class="card"><h3>${I("book", 14)}名詞小抄</h3><dl class="gloss">${GLOSSARY.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl></div></div>`;

// ---------- 文件閱讀 ----------
// ---------- 示意圖（html）：在沙盒裡顯示，可切手機／電腦寬度、開新視窗看完整畫面 ----------
const mockupHtml = path => `<div class="mock-bar"><div class="seg" role="group" aria-label="畫面寬度"><button data-mockw="390" aria-pressed="${S.mockW !== "full"}">${I("phone", 14)}手機</button><button data-mockw="full" aria-pressed="${S.mockW === "full"}">${I("layout", 14)}電腦</button></div><span class="muted">示意圖裡的按鈕都可以點（沙盒，不會影響管理台）</span><span class="spacer"></span><button class="btn sm" data-mockopen>${I("external", 14)}開新視窗看</button></div><div class="mock-stage ${S.mockW === "full" ? "full" : ""}"><iframe class="mock" sandbox="allow-scripts allow-popups allow-modals allow-forms" referrerpolicy="no-referrer" title="示意圖"></iframe></div>`;
function mountMockup(el, text) { S.mockText = text; const f = el.querySelector("iframe.mock"); if (f) f.srcdoc = text; }
function openMockupWindow() {
  const w = window.open("", "_blank"); if (!w) { toast("瀏覽器擋住了新視窗：請允許彈出視窗", 6000); return; }
  w.document.write('<!doctype html><meta charset="utf-8"><title>示意圖</title><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style><iframe sandbox="allow-scripts allow-popups allow-modals allow-forms"></iframe>');
  w.document.close(); w.document.querySelector("iframe").srcdoc = S.mockText || ""; w.opener = null;
}
const resolvePath = (base, rel) => { const parts = base.split("/").slice(0, -1); for (const seg of decodeURIComponent(rel).split("/")) { if (seg === "..") parts.pop(); else if (seg && seg !== ".") parts.push(seg); } return parts.join("/"); };
async function openDoc(path, target) {
  const el = typeof target === "string" ? $(target) : target; if (!el) return;
  S.doc = path;
  const req = (S.docReq = (S.docReq || 0) + 1); // 快速連點時，只顯示最後點的那一份
  document.querySelectorAll("[data-doc]").forEach(b => b.setAttribute("aria-current", b.dataset.doc === path));
  el.innerHTML = `<div class="muted">讀取中…</div>`;
  try {
    let text;
    const cached = S.saved?.[`${S.repo}:${path}`]; // 剛存過的檔案，raw 網址可能還是舊的：10 分鐘內先用剛存的內容
    if (cached && Date.now() - cached.at < 10 * 60000) text = cached.text;
    else text = await getText(path);
    if (req !== S.docReq) return;
    const editable = path.endsWith(".md"); // 沒登入時「編輯」會打開 GitHub 編輯頁
    // 同步工具在檔頭加的說明行：不當內文顯示，改成檔頭的小標籤
    const synced = /^> 🔁 [^\n]*\n\n?/m.test(text);
    if (synced) text = text.replace(/^> 🔁 [^\n]*\n\n?/m, "");
    const head = `<div class="dochead"><span class="path" title="${esc(path)}">${esc(path)}</span>${synced ? `<span class="chip" title="正本在 Obsidian，和這裡雙向同步">${I("refresh", 12)}與 Obsidian 同步</span>` : ""}${editable ? `<button class="btn sm" data-edit="${esc(path)}">${I("edit", 14)}編輯</button>` : ""}<a class="btn sm" href="${blob(path)}" target="_blank" rel="noopener">${I("external", 14)}GitHub</a></div>`;
    if (path.endsWith(".html")) { el.innerHTML = head + mockupHtml(path); mountMockup(el, text); return; }
    if (path.endsWith(".csv")) {
      const rows = parseCsv(text);
      el.innerHTML = head + `<div class="tablewrap"><table class="t"><thead><tr>${(rows[0] || []).map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.slice(1).filter(r => r.some(Boolean)).map(r => `<tr>${r.map(c => `<td class="pre">${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
      return;
    }
    const md = text.replace(/\r/g, "").replace(/^---\n[\s\S]*?\n---\n/, "");
    const html = window.DOMPurify && window.marked ? DOMPurify.sanitize(marked.parse(md)) : `<pre>${esc(md)}</pre>`;
    el.innerHTML = head + `<div class="md">${html}</div>`;
    el.querySelectorAll("img[src]").forEach(img => { const s = img.getAttribute("src"); if (!/^(https?:|data:)/.test(s)) { const p = resolvePath(path, s); if (isPriv()) { img.src = PIXEL; img.dataset.ghimg = p; } else img.src = raw(p); } });
    el.querySelectorAll(".md a[href]").forEach(a => {
      const h = a.getAttribute("href");
      if (/^https?:/.test(h)) { a.target = "_blank"; a.rel = "noopener"; return; }
      if (h.startsWith("#")) return;
      const p = resolvePath(path, h.split("#")[0]);
      if ((S.data.content || []).some(f => f.path === p)) { a.href = "#"; a.addEventListener("click", e => { e.preventDefault(); if (leaveOk()) openDoc(p, el); }); }
      else { a.href = blob(p); a.target = "_blank"; a.rel = "noopener"; }
    });
  } catch (e) { if (req === S.docReq) el.innerHTML = `<div class="err card">讀不到這份文件（${esc(e.message)}）</div>`; }
}
const remember = (path, text) => { S.saved = { ...(S.saved || {}), [`${S.repo}:${path}`]: { text, at: Date.now() } }; };

// ---------- 明細面板 ----------
function showDetail(html) { const d = $("#detail"); d.innerHTML = html; d.classList.add("open"); d.scrollTop = 0; }
function hideDetail() { $("#detail").classList.remove("open"); S.sel = ""; document.querySelectorAll(".sel").forEach(n => n.classList.remove("sel")); }
function selectChange(id) {
  const c = S.data.changes.find(x => x.id === id); if (!c) return;
  S.sel = id; showDetail(changeDetail(c));
  document.querySelectorAll("tr[data-change],.tnode[data-change]").forEach(n => n.classList.toggle("sel", n.dataset.change === id));
  if (S.view === "flow" && S.flowMode === "diagram") redrawFlowLinks();
}

// ---------- 路由與繪製 ----------
const urlFor = (repo, route) => `${location.pathname}?repo=${encodeURIComponent(repo)}${qs.get("data") ? `&data=${encodeURIComponent(qs.get("data"))}` : ""}${qs.has("mock") ? "&mock=1" : ""}#${route}`;
function go(route, push = true) {
  if (!leaveOk()) { history.replaceState(null, "", urlFor(S.repo, [S.view, S.arg].filter(Boolean).join("/"))); return; }
  let [v, ...rest] = route.split("/");
  if (v === "tree") { v = "flow"; S.flowMode = "tree"; } // 舊網址相容
  S.view = V[v] ? v : "overview"; S.arg = rest.join("/");
  if (S.view === "assets" && S.arg) { S.assetFilter = decodeURIComponent(S.arg); S.assetCat = "全部"; } // 手機工作台的「確認素材」：#assets/待確認
  if (push) history.pushState(null, "", urlFor(S.repo, [S.view, S.arg].filter(Boolean).join("/")));
  closeProjMenu(); render(); document.body.classList.remove("drawer");
}
function render() {
  if (!S.data) return;
  $("#side").innerHTML = sideHtml();
  if (S.dirty && $("#edText")) return; // 編輯中：只更新側欄，不要把編輯器洗掉
  $("#view").innerHTML = V[S.view]();
  $("#view").scrollTop = 0;
  if (S.view === "specs" && S.arg) document.getElementById("spec-" + S.arg)?.scrollIntoView({ block: "center" });
  if (S.view === "projects") loadProjectSums();
  if (S.sel && ["flow", "changes", "overview"].includes(S.view)) selectChange(S.sel); else if (!["flow", "changes", "overview"].includes(S.view)) hideDetail();
}

document.addEventListener("click", e => {
  const t = e.target.closest("[data-go],[data-change],[data-doc],[data-doc-detail],[data-close],[data-tree],[data-proj],[data-img],[data-af],[data-ac],[data-flowmode],[data-mockw],[data-mockopen],[data-opendoc],.tw,#addBtn");
  if (!t) return;
  if (t.classList.contains("tw") && !t.classList.contains("leaf")) { e.stopPropagation(); t.closest("li").classList.toggle("closed"); return; }
  if (t.dataset.go) { e.preventDefault(); go(t.dataset.go); return; }
  if (t.dataset.change) { selectChange(t.dataset.change); return; }
  if (t.dataset.flowmode) { S.flowMode = t.dataset.flowmode; store.set("console:flowMode", S.flowMode); render(); return; }
  if (t.dataset.doc) { if (leaveOk()) openDoc(t.dataset.doc, "#reader"); return; }
  if (t.dataset.docDetail) { if (!leaveOk()) return; showDetail(`<button class="ibtn close" data-close aria-label="關閉">${I("x")}</button><div id="dd"></div>`); openDoc(t.dataset.docDetail, "#dd"); return; }
  if (t.dataset.opendoc) { const p = t.dataset.opendoc, f = (S.data.content || []).find(x => x.path === p); if (!f) { window.open(blob(p), "_blank", "noopener"); return; } if (!leaveOk()) return; S.doc = p; hideDetail(); go("content/" + (catOf(f) || "other")); return; }
  if (t.dataset.mockw) { S.mockW = t.dataset.mockw === "full" ? "full" : "390"; document.querySelectorAll("[data-mockw]").forEach(b => b.setAttribute("aria-pressed", b === t)); document.querySelector(".mock-stage")?.classList.toggle("full", S.mockW === "full"); return; }
  if (t.dataset.mockopen !== undefined) { openMockupWindow(); return; }
  if (t.dataset.img) { const p = t.dataset.img; showDetail(`<button class="ibtn close" data-close aria-label="關閉">${I("x")}</button><h3>${esc(p.split("/").pop())}</h3><img ${imgSrc(p)} style="max-width:100%;border-radius:10px;border:1px solid var(--line)" alt=""><div class="row" style="margin-top:12px"><a class="btn" href="${blob(p)}" target="_blank" rel="noopener">${I("external", 14)}GitHub</a><a class="btn" href="${raw(p)}" download>${I("download", 14)}下載</a></div><p class="muted" style="font-family:var(--mono)">${esc(p)}</p>`); return; }
  if (t.dataset.close !== undefined) { if ($("#detail #edText") && !leaveOk()) return; hideDetail(); return; }
  if (t.dataset.tree) { document.querySelectorAll("#flowTree li").forEach(li => li.classList.toggle("closed", t.dataset.tree === "close" && li.parentElement.id !== "flowTree")); return; }
  if (t.dataset.proj) { switchProject(t.dataset.proj); return; }
  if (t.dataset.af) { S.assetFilter = t.dataset.af; loadAssetSheet((S.data.content || []).find(f => f.ext === "csv" && /素材|asset/i.test(f.name)).path); return; }
  if (t.dataset.ac) { S.assetCat = t.dataset.ac; loadAssetSheet((S.data.content || []).find(f => f.ext === "csv" && /素材|asset/i.test(f.name)).path); return; }
  if (t.id === "addBtn") { const v = $("#addRepo").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, ""); if (!/^[\w.-]+\/[\w.-]+$/.test(v)) { toast("格式：帳號/專案"); return; } const local = JSON.parse(store.get("console:projects") || "[]"); if (!local.some(p => p.repo === v)) local.push({ repo: v, name: v.split("/")[1], local: true }); store.set("console:projects", JSON.stringify(local)); S.projects = mergeProjects(S.base, local); switchProject(v); }
});
document.addEventListener("input", e => { if (e.target.id === "treeSearch") { S.treeFilter = e.target.value; const pos = e.target.selectionStart; $("#view").innerHTML = V.flow(); const i = $("#treeSearch"); i.focus(); i.setSelectionRange(pos, pos); } });
addEventListener("popstate", () => { const p = new URLSearchParams(location.search).get("repo"); if (p && p !== S.repo) switchProject(p, false); else go(location.hash.slice(1) || "overview", false); });
// Esc 關明細：打字中、對話框開著、明細裡有編輯器時都不關
addEventListener("keydown", e => { if (e.key === "Escape" && !$("#dlg").open && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && !$("#detail #edText")) hideDetail(); });
addEventListener("hashchange", () => { const r = location.hash.slice(1); if (r && r !== [S.view, S.arg].filter(Boolean).join("/")) go(r, false); });
$("#menu").addEventListener("click", () => document.body.classList.toggle("drawer"));
$("#scrim").addEventListener("click", () => document.body.classList.remove("drawer"));
// 上方專案下拉選單
function closeProjMenu() { $("#projMenu")?.remove(); $("#projBtn").setAttribute("aria-expanded", "false"); }
$("#projBtn").addEventListener("click", e => {
  e.stopPropagation();
  if ($("#projMenu")) return closeProjMenu();
  const m = document.createElement("div");
  m.id = "projMenu"; m.className = "menu"; m.setAttribute("role", "menu");
  m.innerHTML = S.projects.map(p => `<button role="menuitem" data-proj="${esc(p.repo)}" ${p.repo === S.repo ? 'aria-current="true"' : ""}>${I(p.repo === S.repo ? "checkCircle" : "folder", 16)}<span class="mt"><b>${esc(p.name || p.repo)}</b><small>${esc(p.repo)}</small></span></button>`).join("") + `<hr><button role="menuitem" data-go="projects">${I("folder", 16)}<span class="mt"><b>專案目錄</b><small>看全部、加入專案</small></span></button>`;
  $("#projBtn").after(m); $("#projBtn").setAttribute("aria-expanded", "true");
  m.style.left = Math.max(8, Math.min($("#projBtn").offsetLeft, innerWidth - m.offsetWidth - 8)) + "px";
});
document.addEventListener("click", e => { if (!e.target.closest("#projMenu,#projBtn")) closeProjMenu(); });
addEventListener("keydown", e => { if (e.key === "Escape") closeProjMenu(); });
$("#reload").addEventListener("click", () => load(S.repo));
const applyThemeIcon = () => { const dark = (document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark"; $("#theme").innerHTML = I(dark ? "sparkles" : "moon", 17); };
$("#theme").addEventListener("click", () => { const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); const nx = cur === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = nx; store.set("console:theme", nx); applyThemeIcon(); if (S.view === "flow") redrawFlowLinks(); });
if (store.get("console:theme")) document.documentElement.dataset.theme = store.get("console:theme");
// 上方列的圖示
$("#menu").innerHTML = I("menu", 18); $("#reload").innerHTML = I("refresh", 17); $("#toWorkbench").innerHTML = I("phone", 17); $("#projChev").innerHTML = I("chevronDown", 14); applyThemeIcon();

// ---------- 登入與寫入 ----------
const canWrite = () => !!auth.user?.canWrite;
const canTriage = () => !!auth.user?.canTriage;
// 所有寫入對話框最上面都寫清楚「送到哪個專案」，避免選錯專案
const target = () => `<div class="banner">${I("folder", 15)}<span>送到專案：<b>${esc(S.data?.name || S.repo)}</b>（${esc(S.repo)}）。不對的話請先從上方切換專案。</span></div>`;
// 已同意、但 GitHub Actions 還沒寫回的提案（重新整理後也記得，避免重複同意）
const pendKey = () => `console:pending:${S.repo}`;
const pending = () => { try { const p = JSON.parse(sessionStorage.getItem(pendKey()) || "{}"); for (const k in p) if (Date.now() - p[k] > 10 * 60000) delete p[k]; return p; } catch { return {}; } };
const markPending = id => { try { sessionStorage.setItem(pendKey(), JSON.stringify({ ...pending(), [id]: Date.now() })); } catch {} };
const isPending = c => c.status === "待同意" && !!pending()[c.id];
const approveBtn = (c, label = `${I("thumbsUp", 15)}同意`) => isPending(c) ? `<span class="chip s-已同意">${I("hourglass", 12)}已同意，系統寫入中</span>` : `<button class="btn ok" data-approve="${esc(c.id)}">${label}</button>`;
// ---------- 對 AI 說：管理台不呼叫 AI；按鈕複製一句指令，貼到 Claude（電腦或手機 Remote Control） ----------
const sayBtn = (text, size = "sm") => `<button class="btn ${size} say" data-say="${esc(text)}" title="複製這句話，貼到 Claude">${I("message", 13)}對 AI 說「${esc(text)}」</button>`;
async function copySay(text) {
  try { await navigator.clipboard.writeText(text); toast(`已複製「${text}」：貼到 Claude（電腦，或手機的 Remote Control）`, 5000); }
  catch { dialog("對 AI 說", `<p>在 Claude 裡輸入：</p><p><code>${esc(text)}</code></p>`, [["", "關閉"]]); }
}

// ---------- 不登入：打開預先填好的 GitHub 網頁（瀏覽器有登入 github.com 就能用） ----------
const qstr = o => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&"); // 空白用 %20（不要 +）
const web = {
  edit: p => `${S.data.repoUrl}/edit/${S.data.branch || "main"}/${encPath(p)}`,
  newFile: (folder, name, value) => `${S.data.repoUrl}/new/${S.data.branch || "main"}/${encPath(folder)}?${qstr({ filename: name, value })}`,
  upload: dir => `${S.data.repoUrl}/upload/${S.data.branch || "main"}/${encPath(dir)}`,
  issueForm: (tpl, fields) => `${S.data.repoUrl}/issues/new?${qstr({ template: tpl + ".yml", ...fields })}`,
};
function openWeb(url, msg) {
  const w = window.open(url, "_blank");
  if (w) { w.opener = null; toast(msg, 7000); }
  else dialog("打開 GitHub", `<p>${esc(msg)}</p><p><a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener">${I("external", 14)}打開 GitHub 頁面</a></p>`, [["", "關閉"]]);
}
function webApprove(id) {
  const c = S.data.changes.find(x => x.id === id); if (!c) return;
  if (!c.issue) { toast("這張提案的討論串還在建立中，約 1 分鐘後再試（或登入後直接同意）", 7000); return; }
  openWeb(c.issue.url, `在 GitHub 頁面勾 ☐ ${approverOf(c)}同意 就完成了（約 1 分鐘後這裡會更新）`);
}

// 編輯中還沒存：離開前要確認
const leaveOk = () => !S.dirty || confirm("文件還沒儲存，確定要離開嗎？改的內容會不見。") && !(S.dirty = false);
addEventListener("beforeunload", e => { if (S.dirty) { e.preventDefault(); e.returnValue = ""; } });
function toast(msg, ms = 3500) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), ms); }
/** 對話框：回傳按下的按鈕 value（取消＝""） */
function dialog(title, body, buttons = [["", "取消"], ["ok", "確定", "primary"]]) {
  const d = $("#dlg");
  // 取消／關閉加 formnovalidate：必填欄位還沒填也要能關掉
  d.innerHTML = `<form method="dialog"><div class="dlg-h">${esc(title)}<span class="spacer"></span><button class="ibtn" value="" formnovalidate aria-label="關閉">${I("x")}</button></div><div class="dlg-b">${body}</div><div class="dlg-f">${buttons.map(([v, l, c]) => `<button class="btn ${c || ""}" value="${v}" ${v ? "" : "formnovalidate"}>${l}</button>`).join("")}</div></form>`;
  d.showModal();
  // 用 submit（按按鈕當下就觸發）而不是 close 事件：背景分頁裡 close 事件可能會延遲
  return new Promise(res => {
    const form = d.querySelector("form");
    const done = v => { d.onclick = null; res(v); };
    form.addEventListener("submit", e => done(e.submitter?.value || ""), { once: true });
    d.addEventListener("cancel", () => done(""), { once: true });
    // 點視窗外面的暗色區域也能關；已經填了東西就先確認
    d.onclick = e => {
      if (e.target !== d) return;
      const filled = [...form.querySelectorAll("input:not([type=checkbox]),textarea")].some(i => i.type === "file" ? i.files.length : i.value.trim());
      if (filled && !confirm("填的內容還沒送出，確定要關閉嗎？")) return;
      d.close(); done("");
    };
  });
}
function renderAuth() {
  const b = $("#loginBtn");
  if (auth.user) { b.innerHTML = `<span class="who"><img src="${esc(auth.user.avatar)}" alt=""><span class="hide-sm">${esc(auth.user.login)}</span>${auth.user.noAccess ? I("lock", 14) : auth.user.canWrite ? "" : I("eye", 14)}</span>`; b.title = auth.user.noAccess ? "已登入，但登入碼沒有包含這個專案" : auth.user.canWrite ? "已登入：可以同意、留言、寫回饋、編輯內容" : "已登入，但對這個專案只有讀取權限"; }
  else { b.innerHTML = `${I("login", 16)}<span class="hide-sm">登入</span>`; b.title = "不登入也能用（操作會打開 GitHub 網頁）；設定登入碼後可以直接在管理台送出"; }
}
async function checkAuth() {
  if (!auth.token || !S.repo) { auth.user = null; renderAuth(); return; }
  try { await verify(S.repo); }
  catch (e) {
    auth.user = null;
    if (/無效或過期/.test(e.message)) { auth.clear(); toast("登入碼已經失效，請重新登入", 6000); } // 不要每次打開都提醒同一個失效的登入碼
    else toast("登入狀態：" + e.message, 6000);
  }
  renderAuth(); if (S.data) render();
}
async function loginFlow() {
  if (auth.user) {
    const v = await dialog("帳號", `<p><span class="who"><img src="${esc(auth.user.avatar)}" alt=""><b>${esc(auth.user.name)}</b>（${esc(auth.user.login)}）</span></p><p>對「${esc(S.repo)}」的權限：${auth.user.noAccess ? `登入碼沒有包含這個專案。請<a href="${tokenUrl(S.repo.split("/")[0])}" target="_blank" rel="noopener">重新產生登入碼</a>並勾選它（或選 All repositories），再登出、重新登入。` : auth.user.canWrite ? "可以同意、留言、寫回饋、編輯內容" : auth.user.canTriage ? "可以同意、留言、寫回饋（不能編輯內容）" : "只能看"}</p><p class="muted">登入碼存在這台瀏覽器。換電腦、共用電腦用完請登出。</p>`, [["", "關閉"], ["out", "登出", "primary"]]);
    if (v === "out") { auth.clear(); renderAuth(); render(); toast("已登出"); }
    return;
  }
  const owner = S.repo.split("/")[0];
  const v = await dialog("登入（選用）", `
    <div class="banner">${I("checkCircle", 15)}<span><b>不登入也能做所有事。</b>按「同意」「寫回饋」「編輯」「上傳」時，會打開已經填好的 GitHub 網頁，在那裡按一下送出就好——只要瀏覽器有登入 github.com（手機可以用 GitHub App）。</span></div>
    <p>設定<b>登入碼</b>的好處：不用跳到 GitHub，直接在管理台送出，寫回饋可以附截圖。每台電腦／瀏覽器只要做一次。</p>
    <details class="adv"><summary>設定登入碼</summary>
    <ol class="steps">
      <li>按 <a href="${tokenUrl(owner)}" target="_blank" rel="noopener"><b>產生登入碼</b></a>（會打開 GitHub，權限已經幫你勾好）
        <ul class="muted"><li>「Repository access」選 <b>All repositories</b> 或勾選要管理的專案</li><li>拉到最下面按 <b>Generate token</b>，複製那串 <code>github_pat_…</code></li><li>專案不是你自己的（你是協作者）：改用 <a href="${classicTokenUrl}" target="_blank" rel="noopener">傳統登入碼</a>（勾 repo）</li></ul></li>
      <li>貼在下面，按「登入」</li>
    </ol>
    <label class="fld"><span>登入碼</span><input name="token" type="password" autocomplete="off" placeholder="github_pat_… 或 ghp_…"></label>
    <label class="row"><input type="checkbox" name="remember" checked> 記住這台電腦（共用電腦請取消）</label>
    <p class="muted">登入碼只存在你的瀏覽器、只會送到 GitHub。不要貼給別人，也不要貼在聊天裡。登入碼有期限（90 天），到期再產生一次就好。</p></details>`, [["", "先不用"], ["ok", "登入", "primary"]]);
  if (v !== "ok") return;
  const f = $("#dlg form");
  const token = f.token.value.trim();
  if (!token) { toast("沒有貼登入碼：先用 GitHub 網頁的方式就好"); return; }
  auth.save(token, f.remember.checked);
  try { const u = await verify(S.repo); renderAuth(); render(); toast(`歡迎 ${u.login}！${u.canWrite ? "" : "（這個專案你只有讀取權限）"}`); }
  catch (e) { auth.clear(); renderAuth(); toast("登入失敗：" + e.message, 7000); }
}
$("#loginBtn").addEventListener("click", loginFlow);

async function doApprove(id) {
  const c = S.data.changes.find(x => x.id === id); if (!c) return;
  const v = await dialog(c.kind === "技術" ? "同意技術提案（程式）" : "同意提案", `${target()}${c.kind === "技術" ? `<div class="banner">${I("code", 15)}<span>這是<b>技術提案</b>：由程式同意。做完會開 PR，程式審查合併後才上線。</span></div>` : ""}<p>確定同意 <b>${esc(c.title)}</b>（${esc(c.id)}）？</p>${c.confirm ? `<div class="ask">${esc(c.confirm)}</div>` : ""}<p class="muted">同意後對 AI 說「做 ${esc(c.id)}」就會開始製作。如果還有疑問，請改用「留言」。</p>`, [["", "取消"], ["ok", "同意", "ok"]]);
  if (v !== "ok") return;
  try {
    const how = await approveChange(S.repo, c, S.data.specDir, S.data.branch);
    toast((how === "already" ? "這張已經同意過了，系統寫入中" : how === "issue" ? "已同意。約 1 分鐘後任務 0.1 會自動打勾" : "已同意，已寫入任務 0.1") + `；接著對 AI 說「做 ${c.id}」`, 7000);
    markPending(c.id); render();
  } catch (e) { toast("同意失敗：" + e.message, 7000); }
}
async function doComment(id) {
  const c = S.data.changes.find(x => x.id === id); if (!c?.issue) return;
  const v = await dialog(`留言：${c.title}`, `${target()}<label class="fld"><span>想說什麼（問題、要修改的地方都可以）</span><textarea name="msg" required placeholder="例：拖尾顏色跟著街區配色，手機上請再短一點"></textarea></label><p class="muted">留言會出現在提案的討論串。留完對 AI 說「看提案」，AI 會照留言修改。</p>`, [["", "取消"], ["ok", "送出留言", "primary"]]);
  if (v !== "ok") return;
  const msg = $("#dlg form").msg.value.trim(); if (!msg) return;
  try { await comment(S.repo, c.issue.number, msg); c.issue.comments = (c.issue.comments || 0) + 1; toast("已送出留言"); render(); }
  catch (e) { toast("留言失敗：" + e.message, 7000); }
}
async function doNewIssue(kind) {
  const fb = kind === "回饋", inApp = canTriage();
  const v = await dialog(fb ? "寫回饋" : "提需求", `${target()}
    <label class="fld"><span>${fb ? "一句話說是什麼問題" : "一句話說想要什麼"}</span><input name="title" required placeholder="${fb ? "例：第 5 關球常常卡在右上角" : "例：加一個每日挑戰關卡"}"></label>
    ${fb ? `<label class="fld"><span>等級</span><select name="level"><option>🔴 必修（不改不行）</option><option selected>🟡 建議（改了會更好）</option><option>🟢 很好（請保留不要動）</option></select></label>
      <label class="fld"><span>試玩的版本或日期</span><input name="version" placeholder="v3.7.3 或 10/6"></label>
      <label class="fld"><span>用什麼玩</span><select name="device"><option>手機</option><option>平板</option><option>電腦</option></select></label>`
    : `<label class="fld"><span>優先</span><select name="priority"><option>🔴 必做</option><option selected>🟡 想做</option><option>⚪ 之後再說</option></select></label>`}
    <label class="fld"><span>${fb ? "發生什麼事／想要什麼感覺" : "玩家遇到什麼問題／想要什麼"}</span><textarea name="what" required></textarea></label>
    ${fb ? "" : `<label class="fld"><span>想法、參考（選填）</span><textarea name="idea" style="min-height:70px"></textarea></label><label class="fld"><span>怎樣算做好了（選填）</span><input name="done" placeholder="例：第 1 區新手每關最多掉 1 顆愛心"></label>`}
    ${inApp ? `<label class="fld"><span>截圖（選填，可以多張）</span><input name="shots" type="file" accept="image/*" multiple></label>` : `<p class="muted">會打開填好的 GitHub 表單：截圖可以直接拖進去；檢查一下內容（下拉選項沒帶過去的話再選一次），按 <b>Create</b>。</p>`}
    <p class="muted">名詞請用名詞表裡的名字。送出後對 AI 說「${fb ? "看回饋" : "看需求"}」。</p>`, [["", "取消"], ["ok", inApp ? "送出" : "下一步：到 GitHub 送出", "primary"]]);
  if (v !== "ok") return;
  const f = $("#dlg form");
  if (!inApp) {
    const title = `${kind}：${f.title.value.trim().replace(new RegExp(`^${kind}[：:]\\s*`), "")}`;
    const fields = fb ? { title, level: f.level.value, version: f.version.value.trim(), what: f.what.value.trim(), device: f.device.value } : { title, priority: f.priority.value, why: f.what.value.trim(), idea: f.idea.value.trim(), done: f.done.value.trim() };
    for (const k in fields) if (!fields[k]) delete fields[k];
    openWeb(web.issueForm(fb ? "feedback" : "request", fields), "已打開 GitHub：檢查一下內容，按 Create 送出");
    return;
  }
  const fields = fb
    ? { __title: f.title.value.trim(), "等級": f.level.value, "試玩的版本或日期": f.version.value.trim(), "發生什麼事／想要什麼感覺": f.what.value.trim(), "用什麼玩": f.device.value }
    : { __title: f.title.value.trim(), "優先": f.priority.value, "玩家遇到什麼問題／想要什麼": f.what.value.trim(), "想法、參考": f.idea.value.trim(), "怎樣算做好了": f.done.value.trim() };
  if (!fields.__title) return;
  toast("送出中…", 20000);
  try {
    const i = await createIssue(S.repo, kind, fields, [...(f.shots.files || [])], S.data.branch, (S.data.contentDirs || ["docs/企劃"])[0]);
    (fb ? S.data.feedback : S.data.requests).unshift({ number: i.number, title: i.title, url: i.html_url, state: "open", created: i.created_at, user: auth.user.login, labels: [kind], comments: 0 });
    toast(`已送出 #${i.number}`); render();
  } catch (e) { toast("送出失敗：" + e.message, 7000); }
}

async function doEdit(path, preset, container) {
  const el = container || $("#reader") || $("#dd"); if (!el) return;
  el.innerHTML = `<div class="muted">讀取中…</div>`;
  let file = preset;
  if (!file) try { file = await readFile(S.repo, path, S.data.branch); } catch (e) { el.innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
  const mirror = /正本在 Obsidian|鏡像自 Obsidian/.test(file.text);
  el.innerHTML = `<div class="editor">
    <div class="dochead"><span class="path">${I("edit", 13)} ${esc(path)}</span><button class="btn sm" data-ed="preview">${I("eye", 14)}預覽</button><button class="btn sm" data-ed="cancel">取消</button><button class="btn sm primary" data-ed="save">儲存</button></div>
    ${target()}
    ${mirror ? `<div class="banner">${I("refresh", 15)}<span>這份的正本在 Obsidian，兩邊雙向同步：在這裡儲存後，下次「同步企劃文件」會寫回 Obsidian（兩邊都改過會提醒，不會互相蓋掉）。</span></div>` : ""}
    <textarea id="edText" spellcheck="false">${esc(file.text)}</textarea>
    <div class="md doc" id="edPrev" hidden></div>
    <label class="fld" style="margin-top:12px"><span>這次改了什麼（會記在 GitHub 的修改紀錄）</span><input id="edMsg" placeholder="例：阿鰭的外型描述改成藍綠色"></label></div>`;
  el.querySelector("#edText").addEventListener("input", e => { S.dirty = e.target.value !== file.text; });
  const pv = el.querySelector('[data-ed="preview"]');
  pv.onclick = () => {
    const p = $("#edPrev"), ta = $("#edText"), showing = !p.hidden;
    if (!showing) p.innerHTML = window.DOMPurify && window.marked ? DOMPurify.sanitize(marked.parse(ta.value.replace(/^---\n[\s\S]*?\n---\n/, ""))) : esc(ta.value);
    p.hidden = showing; ta.hidden = !showing;
    pv.innerHTML = showing ? `${I("eye", 14)}預覽` : `${I("edit", 14)}回到編輯`;
  };
  el.querySelector('[data-ed="cancel"]').onclick = () => { if (leaveOk()) { S.dirty = false; openDoc(path, el); } };
  const saveBtn = el.querySelector('[data-ed="save"]');
  saveBtn.onclick = async () => {
    const text = $("#edText").value, msg = $("#edMsg").value.trim() || `更新 ${path.split("/").pop()}`;
    if (text === file.text) { toast("沒有改動"); return; }
    saveBtn.disabled = true; saveBtn.textContent = "儲存中…"; // 防止連按兩次
    try { const sha = await saveFile(S.repo, path, text, `內容：${msg}（管理台，${auth.user.login}）`, file.sha, S.data.branch); file = { text, sha }; S.dirty = false; remember(path, text); toast("已儲存：GitHub 上的檔案已更新"); openDoc(path, el); }
    catch (e) { toast("儲存失敗：" + e.message, 7000); saveBtn.disabled = false; saveBtn.textContent = "儲存"; }
  };
}
async function doNewDoc(catKey) {
  const cat = CATS.find(c => c.key === catKey);
  const files = (S.data.content || []).filter(f => catOf(f) === catKey);
  const folder = files[0] ? files[0].path.split("/").slice(0, -1).join("/") : `${(S.data.contentDirs || ["docs/企劃"])[0]}/知識庫/${cat?.label || "其他"}`;
  const v = await dialog(`新增${cat?.label || ""}文件`, `${target()}<label class="fld"><span>標題（也是檔名）</span><input name="title" required placeholder="例：${catKey === "chars" ? "新角色－小黑" : "第 2 區劇情"}"></label><p class="muted">會建立在 <code>${esc(folder)}/</code></p>`, [["", "取消"], ["ok", "建立", "primary"]]);
  if (v !== "ok") return;
  const title = $("#dlg form").title.value.trim().replace(/[\\/:*?"<>|]/g, "－"); if (!title) return;
  const path = `${folder}/${title}.md`;
  const text = `# ${title}\n\n`;
  if ((S.data.content || []).some(f => f.path === path)) { toast("已經有同名的文件了，請換一個標題", 6000); return; }
  if (!canWrite()) { openWeb(web.newFile(folder, title + ".md", text), "已打開 GitHub：寫好內容後按 Commit changes"); return; }
  try { const sha = await saveFile(S.repo, path, text, `內容：新增 ${title}（管理台，${auth.user.login}）`, undefined, S.data.branch); S.data.content.push({ path, name: title + ".md", ext: "md", size: 0, title }); S.doc = path; remember(path, text); render(); setTimeout(() => doEdit(path, { text, sha }), 50); toast("已建立，開始編輯吧"); }
  catch (e) { toast("建立失敗：" + e.message, 7000); }
}
async function doUpload() {
  const dir = `${(S.data.contentDirs || ["docs/企劃"])[0]}/圖`;
  const v = await dialog("上傳素材", `${target()}<label class="fld"><span>選擇檔案（圖片或聲音，可以多個）</span><input name="files" type="file" accept="image/*,audio/*" multiple required></label><p class="muted">會放到 <code>${esc(dir)}/</code>。檔名請用英文小寫＋底線（例：<code>fish_sleepy.png</code>）。</p>`, [["", "取消"], ["ok", "上傳", "primary"]]);
  if (v !== "ok") return;
  const files = [...($("#dlg form").files.files || [])]; if (!files.length) return;
  toast("上傳中…", 30000);
  try {
    const renamed = [];
    for (const file of files) {
      const r = await uploadFile(S.repo, `${dir}/${file.name}`, file, `素材：上傳 ${file.name}（管理台，${auth.user.login}）`, S.data.branch);
      const name = r.path.split("/").pop();
      if (name !== file.name) renamed.push(`${file.name} → ${name}`);
      S.data.content.push({ path: r.path, name, ext: name.split(".").pop().toLowerCase(), size: file.size, title: name.replace(/\.[^.]+$/, "") });
    }
    toast(`已上傳 ${files.length} 個檔案${renamed.length ? `（同名已自動改名：${renamed.join("、")}）` : ""}`, renamed.length ? 8000 : 3500); render();
  } catch (e) { toast("上傳失敗：" + e.message, 7000); }
}
// 寫入動作：有登入碼（而且有權限）就直接在管理台做；沒有就打開預先填好的 GitHub 網頁
document.addEventListener("click", e => {
  const t = e.target.closest("[data-approve],[data-comment],[data-newissue],[data-edit],[data-newdoc],[data-upload],[data-say],[data-role],[data-qa],[data-qafail],[data-assetgo],[data-asend],[data-aok],[data-aback]");
  if (!t) return;
  e.preventDefault();
  if (t.dataset.role) { S.role = t.dataset.role; store.set("console:role", S.role); render(); return; }
  if (t.dataset.assetgo) { S.assetFilter = t.dataset.assetgo; S.assetCat = "全部"; go("assets"); return; }
  if (t.dataset.qa) { const [id, i, v] = t.dataset.qa.split(":"); doQaSet(id, +i, v === "1"); return; }
  if (t.dataset.qafail) { const [id, i] = t.dataset.qafail.split(":"); doQaFail(id, +i); return; }
  if (t.dataset.asend) { doAssetSend(+t.dataset.asend); return; }
  if (t.dataset.aok) { doAssetReview(+t.dataset.aok, true); return; }
  if (t.dataset.aback) { doAssetReview(+t.dataset.aback, false); return; }
  if (t.dataset.say) { copySay(t.dataset.say); return; }
  const inApp = canTriage();
  if (t.dataset.approve) inApp ? doApprove(t.dataset.approve) : webApprove(t.dataset.approve);
  else if (t.dataset.comment) { const c = S.data.changes.find(x => x.id === t.dataset.comment); if (inApp) doComment(c.id); else if (c?.issue) openWeb(c.issue.url, "已打開討論串：拉到最下面留言"); }
  else if (t.dataset.newissue) doNewIssue(t.dataset.newissue);
  else if (t.dataset.edit) canWrite() ? doEdit(t.dataset.edit, null, t.closest("#reader,#dd")) : openWeb(web.edit(t.dataset.edit), "已打開 GitHub 編輯頁：改完按 Commit changes");
  else if (t.dataset.newdoc) doNewDoc(t.dataset.newdoc);
  else if (t.dataset.upload !== undefined) canWrite() ? doUpload() : openWeb(web.upload(`${(S.data.contentDirs || ["docs/企劃"])[0]}/圖`), "已打開 GitHub 上傳頁：把檔案拖進去，按 Commit changes");
});
document.addEventListener("change", e => { if (e.target.matches("[data-rolesel]")) { S.role = e.target.value; store.set("console:role", S.role); render(); } });

// ---------- 載入 ----------
const mergeProjects = (base, local) => [...base, ...local.filter(l => !base.some(b => b.repo === l.repo))];
async function fetchData(repo) {
  const url = qs.get("data") && repo === S.first ? qs.get("data") : `https://raw.githubusercontent.com/${repo}/workbench-data/data.json?t=${Date.now()}`;
  const r = await fetch(url, { cache: "no-store" });
  if (r.ok) return r.json();
  // 私人專案：raw 網址沒登入是 404 → 有登入碼就改用 API 讀 workbench-data 分支
  if (r.status === 404 && !qs.get("data") && auth.token) return (await rawFetch(repo, "data.json", "workbench-data")).json();
  throw new Error(r.status === 404 ? "讀不到這個專案的管理台資料：如果是私人專案，請先按右上角「登入」設定登入碼；不是的話，要先有 workbench Action 並跑過一次" : `讀取失敗（${r.status}）`);
}
async function load(repo) {
  S.repo = repo; $("#projName").textContent = repo; $("#reload").disabled = true;
  try {
    const d = await fetchData(repo); store.set("console:cache:" + repo, JSON.stringify(d)); setData(d, false);
  } catch (e) {
    const c = store.get("console:cache:" + repo);
    if (c) setData(JSON.parse(c), true);
    else { S.data = null; $("#side").innerHTML = ""; $("#view").innerHTML = `<div class="card err">${esc(e.message)}<p><a href="https://github.com/${esc(repo)}/actions" target="_blank" rel="noopener">看 GitHub Actions</a>・<button class="btn sm" id="toProjects">換專案</button></p></div>`; $("#toProjects").onclick = () => { S.data = { changes: [], specs: [], feedback: [], requests: [], runs: [], commits: [], links: [], content: [] }; go("projects"); }; }
  } finally { $("#reload").disabled = false; }
}
const OLD_STATUS = { 實作中: "製作中", 待結案: "待驗收", 已結案: "已完成" };
function setData(d, cached) {
  for (const c of d.changes || []) c.status = OLD_STATUS[c.status] || c.status;
  S.data = d; S.repo = d.repo || S.repo;
  $("#projName").textContent = d.name; $("#projRepo").textContent = S.repo; document.title = `${d.name}｜開發管理台`;
  $("#fresh").innerHTML = `${I("clock", 13)}${cached ? "離線資料・" : ""}更新於 ${ago(d.generatedAt)}`;
  $("#toWorkbench").href = `../workbench/?repo=${encodeURIComponent(S.repo)}`;
  store.set("console:last", S.repo);
  go(location.hash.slice(1) || "overview", false);
  if (auth.token && auth.user?.repo !== S.repo) checkAuth();
}
function switchProject(repo, push = true) {
  if (!leaveOk()) return;
  S.sel = ""; S.doc = ""; hideDetail(); closeProjMenu();
  if (push) history.pushState(null, "", urlFor(repo, "overview"));
  load(repo);
}
async function loadProjectSums() {
  for (const p of S.projects) {
    const el = document.querySelector(`[data-psum="${CSS.escape(p.repo)}"]`); if (!el) continue;
    try {
      const d = p.repo === S.repo ? S.data : await fetchData(p.repo);
      const act = d.changes.filter(c => !c.archived), plan = d.flow?.mode === "planning";
      const w = plan ? act.filter(c => (c.plan?.current ?? 7) === 4).length : act.filter(c => c.status === "待同意").length;
      el.innerHTML = `<div class="row" style="margin-bottom:4px">${w ? (plan ? `<span class="chip c-warn">需求確認 ${w}</span>` : `<span class="chip s-待同意">待同意 ${w}</span>`) : ""}<span class="chip">進行中 ${act.length}</span><span class="chip s-已完成">已完成 ${d.changes.length - act.length}</span>${plan ? "" : `<span class="chip">規則書 ${d.specs.length}</span>`}</div>更新於 ${ago(d.generatedAt)}`;
    } catch (e) { el.textContent = e.message; }
  }
}

(async () => {
  if (qs.has("mock")) await import("./mock.js?v=202610081100"); // 本機測試：假的 GitHub API，不會寫到真的 repo
  renderAuth();
  let base = [];
  try { base = (await (await fetch("projects.json", { cache: "no-store" })).json()).projects || []; } catch {}
  S.base = base;
  S.projects = mergeProjects(base, JSON.parse(store.get("console:projects") || "[]"));
  const guess = location.hostname.endsWith(".github.io") ? `${location.hostname.split(".")[0]}/${location.pathname.split("/")[1]}` : "";
  S.first = qs.get("repo") || store.get("console:last") || S.projects[0]?.repo || guess;
  load(S.first);
})();
