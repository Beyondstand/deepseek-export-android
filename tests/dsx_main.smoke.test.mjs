/* dsx_main.js 冒烟测试：vm 里搭最小 DOM/原生桥/接口桩，
 * 跑通 boot → 导出当前对话(HTML) → 格式切换(TXT) → INVALID_TOKEN 分支。
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
    this.style = {};
    this.textContent = "";
    this.parentNode = null;
    this.handlers = {};
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
  get offsetWidth() { return 40; }
  get offsetHeight() { return 20; }
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
const DSExport = {
  version: () => "0.2-test",
  saveFile(name, mime, content) {
    saves.push({ name, mime, content });
    return JSON.stringify({ ok: true, name, path: "Download/" + name, size: content.length });
  },
  openDownloads() {},
  toast() {},
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
const box = {
  envelope: {
    code: 0, msg: "",
    data: {
      biz_code: 0,
      biz_data: {
        chat_session: { id: "smoke-1", title: "测试会话", current_message_id: 5, model_type: "chat" },
        chat_messages: MSGS,
      },
    },
  },
};
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

/* ---------------- 断言 ---------------- */
await sleep(120); // boot + 首帧

assert.ok(document.getElementById("dsx-pill"), "悬浮胶囊已注入");
assert.ok(document.getElementById("dsx-sheet"), "底部面板已注入");
assert.ok(exportBtn(), "「导出当前对话」按钮存在");

// 1) HTML 导出
exportBtn().onclick();
await sleep(200);
assert.equal(fetchCalls, 1, "发起 1 次接口请求");
assert.equal(saves.length, 1, "经原生桥保存 1 个文件");
assert.match(saves[0].name, /^DeepSeek_测试会话_\d{8}-\d{6}\.html$/, "文件名 = 前缀+标题+时间戳.html");
assert.ok(saves[0].content.startsWith("<!doctype html>"), "HTML 文档头");
assert.ok(saves[0].content.includes("最终回答"), "包含当前分支内容");
assert.ok(!saves[0].content.includes("被重新生成的旧回答"), "HTML 不含被裁剪的旧分支");
let toastEl = document.getElementById("dsx-toast");
assert.ok(toastEl && toastEl.textContent.includes("已导出"), "页内确认 toast");

// 2) 格式切换 → TXT 导出
const fmtBtn = allElements.find((e) => e.textContent === "格式:HTML");
assert.ok(fmtBtn, "格式按钮存在");
fmtBtn.onclick();
assert.equal(fmtBtn.textContent, "格式:TXT", "按钮文案切换");
assert.equal(store.get("dsx_fmt"), "txt", "格式记忆到 localStorage");
exportBtn().onclick();
await sleep(200);
assert.equal(saves.length, 2);
assert.match(saves[1].name, /^DeepSeek_测试会话_\d{8}-\d{6}\.txt$/);
assert.ok(saves[1].content.startsWith("DeepSeek 会话记录"), "TXT 文件头");
assert.ok(saves[1].content.includes("（思考过程）") && saves[1].content.includes("当前思考"));

// 3) INVALID_TOKEN → 明确提示重新登录，不落文件
box.envelope = { code: 40003, msg: "INVALID_TOKEN", data: { biz_code: 40003, biz_data: null } };
exportBtn().onclick();
await sleep(200);
assert.equal(saves.length, 2, "失败时不产生新文件");
toastEl = document.getElementById("dsx-toast");
assert.ok(toastEl.textContent.includes("登录已失效"), "INVALID_TOKEN 有明确提示");

console.log("✅ dsx_main.js 冒烟测试通过（注入/导出/双格式/无效token 分支）");
process.exit(0);
