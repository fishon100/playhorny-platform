// 本機預覽用的管理台資料（不碰 GitHub：沒有 Issue、commit、部署紀錄）
// 用法：node tools/workbench/local-data.mjs [專案根目錄] > web/console/demo.json
//      然後 node tools/serve.mjs，開 http://localhost:8080/console/?repo=local/preview&data=demo.json
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readSpectra, indexContent, PLAN_STAGES } from "./lib.mjs";

const root = resolve(process.argv[2] || ".");
const cfgPath = join(root, "workbench.config.json");
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
const specDir = cfg.spec_dir || "docs/spectra";
const planning = cfg.flow === "planning";
const changesDir = planning ? specDir : `${specDir}/changes`;
const contentDirs = cfg.content_dirs || ["docs/企劃"];
const repo = cfg.repo || "local/preview";
const { changes, specs } = readSpectra(root, specDir, { flow: planning ? "planning" : "game", changesDir: planning ? specDir : undefined });
const data = {
  generatedAt: new Date().toISOString(),
  repo, repoUrl: `https://github.com/${repo}`, specDir, changesDir, private: false, branch: "main",
  contentDirs, content: indexContent(root, contentDirs), assets: null,
  name: cfg.name || repo, links: cfg.links || [], tools: cfg.tools || [],
  flow: planning ? { mode: "planning", stages: PLAN_STAGES } : { mode: "game" },
  changes, specs, requests: [], feedback: [], commits: [], runs: [], pulls: [],
};
process.stdout.write(JSON.stringify(data, null, 1));
