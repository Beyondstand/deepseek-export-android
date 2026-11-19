/* dsx_main.js 冒烟测试（v0.4）：vm 里搭最小 DOM/原生桥/接口桩，
 * 跑通 boot → 导出 MD → 一键复制 → 发给千问（接手提示词+全文）→ INVALID_TOKEN 分支。
 * 运行：node tests/dsx_main.smoke.test.mjs */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const DSExp = require("../app/src/main/assets/dsx_core.js");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 最小 DOM 桩 ---------------- */
class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.textContent = "";
    this.parentNode = null;
    this.handlers = {};
    // 模拟真实 DOM：cssText 赋值会把 k:v; 声明解析成 style 上的 camelCase 属性
    const styleObj = {};
    Object.defineProperty(styleObj, "cssText", {
      set(v) {
        for (const k of Object.keys(this)) delete this[k];
        String(v).split(";").forEach((d) => {
          const i = d.indexOf(":");
          if (i > 0) {
            const key = d.slice(0, i).trim().replace(/-([a-z])/g, (m, c) => c.toUpperCase());
            this[key] = d.slice(i + 1).trim();
          }
        });
        this._cssText = String(v);
      },
      get() { return this._cssText || ""; },
    });
    this.style = styleObj;
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
  addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0 }; }
  get offsetWidth() { return 60; }
  get offsetHeight() { return 24; }
}
const allElements = [];
function findId(rootEl, id) {
  for (const c of rootEl.children || []) {
    if (c.id === id) return c;
    const r = c.children ? findId(c, id) : null;
    if (r) return r;
  }
  return null;
}
const body = new FakeElement("body");
const document = {
  body,
  createElement(tag) { const e = new FakeElement(tag); allElements.push(e); return e; },
  createTextNode(t) { return { textContent: t, parentNode: null }; },
  getElementById(id) { return findId(body, id); },
};

/* ---------------- localStorage 桩（已登录） ---------------- */
const store = new Map([["userToken", JSON.stringify({ value: "fake-token" })]]);
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};

/* ---------------- 原生桥桩 ---------------- */
const saves = [];
const copies = [];
const shares = [];
const DSExport = {
  version: () => "0.4-test",
  saveFile(name, mime, content) {
    saves.push({ name, mime, content });
    return JSON.stringify({ ok: true, name, path: "Download/" + name, size: content.length });
  },
  openDownloads() {},
  toast() {},
  copy(text) { copies.push(text); },
  shareText(text) { shares.push(text); },
};

/* ---------------- 接口桩（与已验证的包络一致） ---------------- */
const MSGS = [
  { message_id: 1, parent_id: null, role: "USER", inserted_at: 1, fragments: [{ type: "REQUEST", content: "你好" }] },
  { message_id: 2, parent_id: 1, role: "ASSISTANT", inserted_at: 2, fragments: [{ type: "THINK", content: "旧思考" }, { type: "RESPONSE", content: "被重新生成的旧回答" }] },
  { message_id: 3, parent_id: 1, role: "ASSISTANT", inserted_at: 3, fragments: [{ type: "THINK", content: "当前思考" }, { type: "RESPONSE", content: "正式回答" }] },
  { message_id: 4, parent_id: 3, role: "USER", inserted_at: 4, fragments: [{ type: "REQUEST", content: "继续" }] },
  { message_id: 5, parent_id: 4, role: "ASSISTANT", inserted_at: 5, fragments: [
    { type: "TOOL_SEARCH", queries: ["q"], results: [{ title: "t", url: "u" }] },
    { type: "RESPONSE", content: "最终回答" },
  ] },
];
const OK_ENVELOPE = () => ({
  code: 0, msg: "",
  data: { biz_code: 0, biz_data: {
    chat_session: { id: "smoke-1", title: "测试会话", current_message_id: 5, model_type: "chat" },
    chat_messages: MSGS,
  } },
});
const box = { envelope: OK_ENVELOPE() };
let fetchCalls = 0;
const fetchStub = () => {
  fetchCalls++;
  return Promise.resolve({ json: () => Promise.resolve(box.envelope) });
};

/* ---------------- 装载 dsx_main.js ---------------- */
const sandbox = {
  DSExp, DSExport,
  console,
  setTimeout, setInterval, clearTimeout, clearInterval,
  localStorage, document,
  location: { pathname: "/a/chat/s/smoke-session-1" },
  innerWidth: 390, innerHeight: 800,
  fetch: fetchStub,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  readFileSync(path.join(ROOT, "app/src/main/assets/dsx_main.js"), "utf8"),
  sandbox,
  { filename: "dsx_main.js" },
);

const exportBtn = () => allElements.find((e) => e.textContent === "📤 导出当前对话");
const feedBtn = () => allElements.find((e) => e.textContent === "🤖 发给千问");
const btnByText = (t) => allElements.find((e) => e.textContent === t);

/* ---------------- 断言 ---------------- */
await sleep(120); // boot + 首帧

assert.ok(document.getElementById("dsx-pill"), "悬浮胶囊已注入");
const pill = document.getElementById("dsx-pill");
assert.ok(pill.style.cssText.includes("#2563eb"), "胶囊为亮蓝底（更醒目）");
assert.ok(pill.style.cssText.includes("font:700 15px"), "胶囊字体加大加粗");
assert.ok(document.getElementById("dsx-sheet"), "底部面板已注入");
assert.ok(exportBtn(), "「导出当前对话」按钮存在");
assert.ok(feedBtn(), "「发给千问」按钮存在");
assert.ok(!allElements.some((e) => typeof e.textContent === "string" && /^格式:/.test(e.textContent)),
  "格式切换按钮已移除（仅 Markdown）");

// 1) 导出 → Markdown 文件 + App 内缓存
exportBtn().onclick();
await sleep(200);
assert.equal(fetchCalls, 1, "发起 1 次接口请求");
assert.equal(saves.length, 1, "经原生桥保存 1 个文件");
assert.match(saves[0].name, /^DeepSeek_测试会话_\d{8}-\d{6}\.md$/, "文件名 = 前缀+标题+时间戳.md");
assert.ok(saves[0].mime.includes("markdown"), "MIME 为 markdown");
assert.ok(saves[0].content.startsWith("# DeepSeek 会话：测试会话"), "MD 文档头");
assert.ok(saves[0].content.includes("最终回答"), "包含当前分支内容");
assert.ok(saves[0].content.includes("> 💭 **思考过程**"), "思考过程为引用块");
assert.ok(!saves[0].content.includes("被重新生成的旧回答"), "MD 不含被裁剪的旧分支");
let toastEl = document.getElementById("dsx-toast");
assert.ok(toastEl && toastEl.textContent.includes("已导出"), "页内确认 toast");
assert.ok(allElements.some((e) => e.textContent === "API 1 · 已存 1 · 失败 0"), "计数徽章更新");

// 2) App 内缓存 → 一键复制（走原生剪贴板桥）
const cached = JSON.parse(store.get("dsx_exports"));
assert.equal(cached.length, 1, "导出全文已持久化到 App 内");
assert.equal(cached[0].name, saves[0].name);
const copyBtn = btnByText("复制");
assert.ok(copyBtn, "最近导出有「复制」按钮");
copyBtn.onclick();
assert.equal(copies.length, 1, "调用原生剪贴板桥");
assert.equal(copies[0], saves[0].content, "复制的是全文 Markdown");
toastEl = document.getElementById("dsx-toast");
assert.ok(toastEl.textContent.includes("已复制"), "复制确认 toast");

// 3) 「查看」就地展开全文
const viewBtn = btnByText("查看");
viewBtn.onclick();
const contentBox = viewBtn.parentNode.parentNode.children[1];
assert.equal(contentBox.style.display, "block", "查看展开内容");
assert.equal(contentBox.textContent, saves[0].content, "展开内容为全文");

// 4) 发给千问：当前对话 → 接手提示词 + 全文 → 系统分享面板
feedBtn().onclick();
await sleep(200);
assert.equal(fetchCalls, 2, "发起 1 次接口请求（拉取当前对话）");
assert.equal(shares.length, 1, "调起系统分享面板");
assert.ok(shares[0].startsWith("我想让你「接手」一段我和另一个 AI 助手（DeepSeek）的对话。"),
  "分享文本以接手提示词开头");
assert.ok(shares[0].includes("1. 把它当作你自己的对话记忆"), "提示词含继承上下文要求");
assert.ok(shares[0].includes("（以下为完整对话记录）"), "提示词与正文有分隔");
assert.ok(shares[0].includes("# DeepSeek 会话：测试会话"), "正文为完整 MD");
assert.ok(shares[0].includes("最终回答") && shares[0].includes("👤 用户"), "正文含用户/助手消息");
assert.ok(!shares[0].includes("被重新生成的旧回答"), "正文不含被裁剪的旧分支");
assert.ok(allElements.some((e) => e.textContent === "API 2 · 已存 1 · 失败 0"), "计数徽章更新");

// 5) 「最近导出」条目上的「千问」链接：分享已存内容（不重新拉接口）
const feedLink = btnByText("千问");
assert.ok(feedLink, "最近导出条目有「千问」链接");
feedLink.onclick();
assert.equal(shares.length, 2, "再次调起分享");
assert.ok(shares[1].startsWith(shares[0].slice(0, 120)), "同样以接手提示词开头");
assert.ok(shares[1].includes("最终回答"), "正文为缓存全文");
assert.equal(fetchCalls, 2, "未重复拉接口");

// 6) INVALID_TOKEN → 明确提示重新登录，不落文件不进缓存不分享
box.envelope = { code: 40003, msg: "INVALID_TOKEN", data: { biz_code: 40003, biz_data: null } };
exportBtn().onclick();
await sleep(200);
assert.equal(saves.length, 1, "失败时不产生新文件");
assert.equal(JSON.parse(store.get("dsx_exports")).length, 1, "失败时不新增缓存");
toastEl = document.getElementById("dsx-toast");
assert.ok(toastEl.textContent.includes("登录已失效"), "INVALID_TOKEN 有明确提示");

// 7) 千问拉取遇 INVALID_TOKEN 同样不分享
feedBtn().onclick();
await sleep(200);
assert.equal(shares.length, 2, "失败时不调分享");
assert.ok(allElements.some((e) => e.textContent === "API 4 · 已存 1 · 失败 2"), "计数徽章更新");

// 8) 再导一次（成功）→ 文件与缓存各 +1
box.envelope = OK_ENVELOPE();
exportBtn().onclick();
await sleep(200);
assert.equal(saves.length, 2);
const cached2 = JSON.parse(store.get("dsx_exports"));
assert.equal(cached2.length, 2, "缓存 2 条");
assert.equal(cached2[0].name, saves[1].name, "最新在前");
assert.ok(allElements.some((e) => e.textContent === "API 5 · 已存 2 · 失败 2"), "最终计数徽章");

console.log("✅ dsx_main.js 冒烟测试通过（注入/MD导出/复制/发给千问/无效token 分支）");
process.exit(0);
