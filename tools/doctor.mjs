// 檢查環境：換電腦、換帳號後跑一次，看缺什麼、怎麼補。
// 用法：node tools/doctor.mjs     （或對 AI 說「檢查環境」）
import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

const run = cmd => { try { return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch (e) { return null; } };
const rows = [];
const check = (name, ok, detail, fix) => rows.push({ name, ok, detail, fix });

const nodeMajor = +process.versions.node.split(".")[0];
check("Node.js 22 以上", nodeMajor >= 22, `目前 ${process.versions.node}`, "到 https://nodejs.org 下載 LTS 版安裝");

const git = run("git --version");
check("git", !!git, git || "沒有安裝", "到 https://git-scm.com 下載安裝");
const remote = git && run("git remote get-url origin");
check("專案有連到 GitHub", !!remote, remote || "沒有 origin", "用 gh repo clone <帳號>/<專案> 重新下載");

const ghv = run("gh --version");
check("GitHub CLI（gh）", !!ghv, ghv ? ghv.split("\n")[0] : "沒有安裝", "到 https://cli.github.com 下載安裝");
if (ghv) {
  const status = run("gh auth status 2>&1") || "";
  const user = (status.match(/account (\S+)/) || [])[1];
  const scopes = (status.match(/Token scopes: (.+)/) || [])[1] || "";
  check("gh 已登入", !!user, user ? `帳號 ${user}` : "沒有登入",
    "請 AI 在它的終端機執行 gh auth login -h github.com -s workflow，再到 https://github.com/login/device 輸入代碼");
  if (user) check("gh 有 workflow 權限（推送自動化設定要用）", /workflow/.test(scopes), scopes || "（看不到）",
    "請 AI 執行 gh auth refresh -h github.com -s workflow，再到 https://github.com/login/device 輸入代碼");
}

const spxa = run("spxa --version");
check("Spectra 指令（spxa）", !!spxa, spxa || "沒有安裝", "npm install -g @kaochenlong/spxa");
const skills = existsSync(".claude/skills") ? readdirSync(".claude/skills").filter(n => n.startsWith("spectra-")) : [];
check("Spectra skills（/spectra-* 指令）", skills.length >= 10, `${skills.length} 個`, "在專案資料夾執行 spxa init --tools claude");
check("Spectra 設定檔", existsSync(".spectra.yaml"), existsSync(".spectra.yaml") ? "有" : "沒有", "spxa init --tools claude");

const hasNodeTests = existsSync("tests") && readdirSync("tests").some(f => /\.test\.(mjs|js)$/.test(f));
const tests = hasNodeTests ? run("node --test 2>&1") : "";
const pass = tests && (tests.match(/# pass (\d+)/) || [])[1], fail = tests && (tests.match(/# fail (\d+)/) || [])[1];
if (hasNodeTests) check("自動測試", tests !== null && fail === "0", tests === null ? "有測試失敗" : `${pass} 項通過、${fail} 項失敗`, "對 AI 說「測試沒過，幫我看」");
else check("（選用）自動測試", false, "這個專案沒有 node --test 的測試（看 CLAUDE.md 的測試方式）", "—");

check("（選用）本機通知設定", existsSync("tools/notify.config.json"), existsSync("tools/notify.config.json") ? "有" : "沒有（只影響電腦右下角通知）", "複製 tools/notify.config.example.json 成 notify.config.json 並填主題");

console.log("\n🩺 環境檢查\n");
for (const r of rows) console.log(`${r.ok ? "✅" : r.name.startsWith("（選用）") ? "⚪" : "❌"} ${r.name}：${r.detail}${r.ok ? "" : `\n   → 怎麼補：${r.fix}`}`);
const bad = rows.filter(r => !r.ok && !r.name.startsWith("（選用）"));
console.log(bad.length ? `\n還有 ${bad.length} 項要補。` : "\n全部 OK，可以開始工作了 🎉");
console.log("雲端的東西（工作台、GitHub、Notion）不用檢查：換電腦不影響。Notion／Figma／Google Drive 連接器請對 AI 說「檢查連接器」。");
process.exitCode = bad.length ? 1 : 0;
