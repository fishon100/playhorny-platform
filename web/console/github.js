// 管理台的 GitHub 寫入：登入（登入碼）、同意、留言、開回饋／需求、上傳檔案、編輯內容
// 登入碼只存在這台瀏覽器（localStorage，或勾「只在這次」時存 sessionStorage），只會送到 api.github.com。
import { setQaItem, failQaItem, updateAssetRow } from "./shared.js?v=202610072300";
const KEY = "console:auth";
const API = "https://api.github.com";

const safe = fn => { try { return fn(); } catch { return null; } };
export const auth = {
  token: safe(() => sessionStorage.getItem(KEY)) || safe(() => localStorage.getItem(KEY)) || "",
  user: null,
  save(token, remember) {
    this.token = token;
    safe(() => (remember ? localStorage : sessionStorage).setItem(KEY, token));
    safe(() => (remember ? sessionStorage : localStorage).removeItem(KEY));
  },
  clear() { this.token = ""; this.user = null; safe(() => localStorage.removeItem(KEY)); safe(() => sessionStorage.removeItem(KEY)); },
};

export async function gh(path, { method = "GET", body } = {}) {
  if (!auth.token) throw new Error("還沒登入");
  const r = await fetch(path.startsWith("http") ? path : API + path, {
    method,
    headers: { Authorization: `Bearer ${auth.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) throw new Error("登入碼無效或過期了，請重新登入");
  if (r.status === 403 || r.status === 404) throw new Error(`沒有權限（${r.status}）：登入碼要包含這個專案，並有 Issues 與 Contents 的讀寫權限`);
  if (r.status === 409) throw new Error("檔案剛被別人改過，請重新整理後再改一次");
  if (r.status === 422) { const t = await r.text(); const e = new Error(/sha/.test(t) ? "已經有同名的檔案了，請換一個名字" : `GitHub 不接受這個內容：${t.slice(0, 160)}`); e.status = 422; throw e; }
  if (!r.ok) throw new Error(`GitHub 回應 ${r.status}：${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}

/** 驗證登入碼，並確認對這個專案有寫入權限 */
export async function verify(repo) {
  const user = await gh("/user"); // 登入碼本身無效 → 這裡就會丟錯（真的沒登入）
  let p = {}, noAccess = false;
  try { p = (await gh(`/repos/${repo}`)).permissions || {}; }
  catch { noAccess = true; } // 登入碼沒包含這個專案：保持登入，只是這個專案不能寫
  auth.user = { login: user.login, avatar: user.avatar_url, name: user.name || user.login, repo, noAccess, canWrite: !!(p.push || p.maintain || p.admin), canTriage: !!(p.triage || p.push || p.maintain || p.admin) };
  return auth.user;
}

/** 預先填好權限的「產生登入碼」連結（fine-grained token） */
export function tokenUrl(owner) {
  const q = new URLSearchParams({ name: "開發管理台", description: "開發管理台：同意提案、留言、寫回饋、編輯企劃內容", target_name: owner, expires_in: "90", contents: "write", issues: "write", metadata: "read" });
  return `https://github.com/settings/personal-access-tokens/new?${q}`;
}
export const classicTokenUrl = "https://github.com/settings/tokens/new?scopes=repo&description=%E9%96%8B%E7%99%BC%E7%AE%A1%E7%90%86%E5%8F%B0";

// ---- UTF-8 與 base64 ----
const b64encode = str => { const bytes = new TextEncoder().encode(str); let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
// ignoreBOM：保留檔案開頭的 BOM（Excel 開 CSV 靠它認中文；預設會被吃掉，存回去就變亂碼）
const b64decode = b64 => new TextDecoder("utf-8", { ignoreBOM: true }).decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), c => c.charCodeAt(0)));
const bufToB64 = buf => { const bytes = new Uint8Array(buf); let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const encPath = p => p.split("/").map(encodeURIComponent).join("/");
const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });

/** 讀原始內容（私人專案：raw 網址要登入才看得到，改用登入碼走 API）。回傳 fetch 的 Response */
export async function rawFetch(repo, path, branch = "main") {
  if (!auth.token) throw new Error("這是私人專案：請先登入（設定登入碼）");
  const r = await fetch(`${API}/repos/${repo}/contents/${encPath(path)}?ref=${encodeURIComponent(branch)}`, { headers: { Authorization: `Bearer ${auth.token}`, Accept: "application/vnd.github.raw", "X-GitHub-Api-Version": "2022-11-28" } });
  if (r.status === 401) throw new Error("登入碼無效或過期了，請重新登入");
  if (!r.ok) throw new Error(r.status === 404 ? "找不到檔案（或登入碼沒有包含這個專案）" : `GitHub 回應 ${r.status}`);
  return r;
}
/** 讀檔（拿 sha 給之後的儲存用） */
export async function readFile(repo, path, branch = "main") {
  const f = await gh(`/repos/${repo}/contents/${encPath(path)}?ref=${encodeURIComponent(branch)}`);
  return { text: b64decode(f.content || ""), sha: f.sha };
}
/** 存檔（新檔不用 sha） */
export async function saveFile(repo, path, text, message, sha, branch = "main") {
  const r = await gh(`/repos/${repo}/contents/${encPath(path)}`, { method: "PUT", body: { message, content: b64encode(text), branch, ...(sha ? { sha } : {}) } });
  return r.content?.sha;
}
/** 上傳圖片或其他二進位檔。同名檔案已存在時自動改名（檔名-2、檔名-3…），不會蓋掉別人的檔案。回傳 { path, url } */
export async function uploadFile(repo, path, file, message, branch = "main") {
  const content = bufToB64(await file.arrayBuffer());
  const dot = path.lastIndexOf("."), stem = dot > path.lastIndexOf("/") ? path.slice(0, dot) : path, ext = dot > path.lastIndexOf("/") ? path.slice(dot) : "";
  for (let n = 1; n <= 20; n++) {
    const p = n === 1 ? path : `${stem}-${n}${ext}`;
    try {
      await gh(`/repos/${repo}/contents/${encPath(p)}`, { method: "PUT", body: { message, content, branch } });
      return { path: p, url: `https://raw.githubusercontent.com/${repo}/${branch}/${encPath(p)}` };
    } catch (e) { if (e.status !== 422) throw e; }
  }
  throw new Error("同名檔案太多了，請換一個檔名");
}

const APPROVE_RE = /^- \[( |x|X)\] (企劃|程式)同意/m;   // 企劃提案＝企劃同意、技術提案＝程式同意
const TASK_RE = /^- \[( |x|X)\] 0\.1 .*$/m;
/** 同意提案：有 Issue 就在 Issue 上打勾（Actions 會寫回 tasks.md）；沒有 Issue 就直接改 tasks.md */
export async function approveChange(repo, change, specDir, branch) {
  const who = auth.user?.login || "管理台", role = change.kind === "技術" ? "程式" : "企劃";
  if (change.issue?.number) {
    const issue = await gh(`/repos/${repo}/issues/${change.issue.number}`);
    if (!APPROVE_RE.test(issue.body || "")) throw new Error("這個 Issue 裡找不到「同意」勾選框");
    if (/^- \[[xX]\] (企劃|程式)同意/m.test(issue.body)) return "already"; // 已經同意過（例如重新整理後又按一次）：不重複留言
    await gh(`/repos/${repo}/issues/${change.issue.number}`, { method: "PATCH", body: { body: issue.body.replace(APPROVE_RE, (m, x, r) => `- [x] ${r}同意`) } });
    await gh(`/repos/${repo}/issues/${change.issue.number}/comments`, { method: "POST", body: { body: `👍 ${who} 在管理台同意了這張提案。` } });
    return "issue";
  }
  const path = `${specDir}/changes/${change.folder}/tasks.md`;
  const { text, sha } = await readFile(repo, path, branch);
  if (!TASK_RE.test(text)) throw new Error("tasks.md 沒有「0.1」確認這一項");
  const next = text.replace(TASK_RE, line => /^- \[[xX]\]/.test(line) ? line : line.replace(/^- \[ \]/, "- [x]").replace(/\s*$/, `（${role}於管理台同意（${who}），${today()}）`));
  await saveFile(repo, path, next, `${role}同意：${change.id}（管理台，${who}）`, sha, branch);
  return "tasks";
}

/** 試玩清單：勾／取消第 i 項（讀最新內容再改，不會蓋掉別人剛勾的） */
export async function qaSet(repo, number, i, done) {
  const issue = await gh(`/repos/${repo}/issues/${number}`);
  const body = setQaItem(issue.body || "", i, done);
  if (body !== issue.body) await gh(`/repos/${repo}/issues/${number}`, { method: "PATCH", body: { body } });
  return body;
}
/** 試玩清單：第 i 項不通過，標上回饋編號 */
export async function qaFail(repo, number, i, feedbackNumber) {
  const issue = await gh(`/repos/${repo}/issues/${number}`);
  const body = failQaItem(issue.body || "", i, feedbackNumber);
  await gh(`/repos/${repo}/issues/${number}`, { method: "PATCH", body: { body } });
  return body;
}
/** 素材清單：改某一列（狀態、交件、意見），讀最新的再改；回傳新的內容 */
export async function saveAssetRow(repo, path, rowIndex, name, changes, message, branch = "main") {
  const { text, sha } = await readFile(repo, path, branch);
  const next = updateAssetRow(text, rowIndex, name, changes);
  const newSha = await saveFile(repo, path, next, message, sha, branch);
  return { text: next, sha: newSha };
}

export const comment = (repo, number, text) => gh(`/repos/${repo}/issues/${number}/comments`, { method: "POST", body: { body: text } });

/** 開回饋／需求 Issue（內文格式跟 GitHub 表單一樣，AI 讀起來一致） */
export async function createIssue(repo, kind, fields, images = [], branch = "main", contentDir = "docs/企劃") {
  const who = auth.user?.login || "管理台";
  const urls = [];
  for (const file of images) {
    const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const path = `${contentDir}/圖/${kind}/${stamp}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
    urls.push((await uploadFile(repo, path, file, `${kind}截圖（管理台，${who}）`, branch)).url);
  }
  fields = { ...fields, __title: String(fields.__title || "").replace(new RegExp(`^${kind}[：:]\\s*`), "") }; // 使用者自己打了「回饋：」就不要重複
  const { __title, ...rest } = fields;
  const sections = Object.entries(rest).filter(([, v]) => v).map(([k, v]) => `### ${k}\n\n${v}`);
  if (urls.length) sections.push(`### 截圖\n\n${urls.map(u => `![截圖](${u})`).join("\n")}`);
  sections.push(`---\n_由 ${who} 在開發管理台填寫_`);
  return gh(`/repos/${repo}/issues`, { method: "POST", body: { title: `${kind}：${__title}`, body: sections.join("\n\n"), labels: [kind] } });
}
