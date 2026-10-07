// 本機測試用：網址加 ?mock=1 時，把對 api.github.com 的呼叫換成假的回應，記錄在 window.__calls。
// 不會碰到真的 GitHub；讀取檔案內容時才會去 raw.githubusercontent.com 拿公開的檔案。
const real = window.fetch.bind(window);
window.__calls = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const b64 = s => { const b = new TextEncoder().encode(s); let x = ""; b.forEach(c => (x += String.fromCharCode(c))); return btoa(x); };
let n = 100;
window.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith("https://api.github.com")) return real(url, init);
  const method = (init.method || "GET").toUpperCase();
  const path = decodeURIComponent(new URL(u).pathname);
  const body = init.body ? JSON.parse(init.body) : null;
  window.__calls.push({ method, path, body });
  if (path === "/user") return json({ login: "demo-planner", name: "示範企劃", avatar_url: "../workbench/icon.svg" });
  let m;
  if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)$/))) return (window.__noAccess || []).includes(m[1]) ? json({ message: "Not Found" }, 404) : json({ permissions: { push: true, triage: true } });
  // Issue 內文：測試可以先放進 window.__issueBodies[編號]；PATCH 會記下來，下次 GET 拿到改過的
  window.__issueBodies = window.__issueBodies || {};
  if ((m = path.match(/\/issues\/(\d+)$/)) && method === "GET") return json({ number: +m[1], body: window.__issueBodies[m[1]] ?? "<!-- spectra-change: x -->\n### 為什麼\n…\n\n- [ ] 企劃同意\n" });
  if ((m = path.match(/\/issues\/(\d+)$/)) && method === "PATCH") { if (body?.body != null) window.__issueBodies[m[1]] = body.body; return json({ ok: true }); }
  if (path.match(/\/issues\/\d+\/comments$/)) return json({ id: 1 }, 201);
  if (path.match(/\/issues$/) && method === "POST") return json({ number: ++n, title: body.title, html_url: "#mock-issue", created_at: new Date().toISOString() }, 201);
  if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/))) {
    window.__fileText = window.__fileText || {};
    // 私人專案的原始內容（Accept: raw）：測試時把檔案放在本機 window.__rawBase 底下
    const accept = (init.headers && (init.headers.Accept || init.headers.accept)) || "";
    if (method === "GET" && /raw/.test(accept) && window.__rawBase) return real(window.__rawBase + m[2].split("/").map(encodeURIComponent).join("/"));
    if (method === "GET" && window.__fileText[m[2]] != null) return json({ content: b64(window.__fileText[m[2]]), sha: "mock-sha-3" });
    if (method === "GET") {
      const r = await real(`https://raw.githubusercontent.com/${m[1]}/main/${m[2].split("/").map(encodeURIComponent).join("/")}`);
      // 跟 GitHub 一樣原樣給（含 BOM）：r.text() 會把 BOM 吃掉
      return r.ok ? json({ content: b64(new TextDecoder("utf-8", { ignoreBOM: true }).decode(await r.arrayBuffer())), sha: "mock-sha" }) : json({ message: "Not Found" }, 404);
    }
    if (method === "PUT") {
      // 跟 GitHub 一樣：檔案已存在又沒給 sha → 422
      window.__files = window.__files || new Set();
      if (!body.sha && window.__files.has(m[2])) return json({ message: 'Invalid request.\n\n"sha" wasn\'t supplied.' }, 422);
      window.__files.add(m[2]);
      try { window.__fileText[m[2]] = new TextDecoder("utf-8", { ignoreBOM: true }).decode(Uint8Array.from(atob(body.content), c => c.charCodeAt(0))); } catch {}
      return json({ content: { sha: "mock-sha-2" } }, 201);
    }
  }
  return json({ message: "mock: 沒有處理 " + method + " " + path }, 404);
};
console.info("[mock] GitHub API 已換成假的回應");
