/* dsx_core.js 单元测试（零依赖）：node tests/dsx_core.test.mjs
 * 与网页版工具共用同一份核心纯函数（shared.js 原样拷入 assets）。 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DSExp = require("../app/src/main/assets/dsx_core.js");

// ---------------- 归一化（含分支裁剪） ----------------
const cs = { id: "sess-1", title: "测试会话", updated_at: 1763400000, model_type: "deepseek_reasoner", current_message_id: 5 };
const msgs = [
  { message_id: 1, parent_id: null, role: "USER", inserted_at: 1, fragments: [{ type: "REQUEST", content: "你好" }] },
  { message_id: 2, parent_id: 1, role: "ASSISTANT", inserted_at: 2, fragments: [{ type: "THINK", content: "旧思考" }, { type: "RESPONSE", content: "被重新生成的旧回答" }] },
  { message_id: 3, parent_id: 1, role: "ASSISTANT", inserted_at: 3, fragments: [{ type: "THINK", content: "当前思考" }, { type: "RESPONSE", content: "正式回答" }] },
  { message_id: 4, parent_id: 3, role: "USER", inserted_at: 4, fragments: [{ type: "REQUEST", content: "继续" }] },
  { message_id: 5, parent_id: 4, role: "ASSISTANT", inserted_at: 5, fragments: [
    { type: "TOOL_SEARCH", queries: ["q"], results: [{ title: "t", url: "u" }] },
    { type: "RESPONSE", content: "最终回答" },
  ] },
];
const s = DSExp.normalizeSession(cs, msgs);
assert.equal(s.messages.length, 4, "只保留当前分支");
assert.deepEqual(s.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
assert.equal(s.messages[1].thinking, "当前思考");
assert.equal(s.messages[3].searches[0].results[0].url, "u");
assert.equal(DSExp.normalizeSession({ id: "x" }, msgs).messages.length, 5, "叶子缺失则全保留");
const legacy = DSExp.normalizeSession({ id: "l", title: "legacy", current_message_id: 9 },
  [{ id: 9, parent_id: null, role: "USER", content: "老格式", thinking_content: "老思考" }]);
assert.equal(legacy.messages[0].content, "老格式");
assert.equal(legacy.messages[0].thinking, "老思考");

// ---------------- 官方 conversations.json 容错 ----------------
const conv = DSExp.officialToSession({
  id: "c1", title: "官方导出",
  messages: [{ role: "human", content: "hi" }, { role: "gpt", content: "hello" }],
});
assert.equal(conv.messages[0].role, "user");
assert.equal(conv.messages[1].role, "assistant");

// ---------------- 文件名清洗 ----------------
assert.equal(DSExp.sanitizeFilename('a/b:c*d?e"f'), "a_b_c_d_e_f");
assert.equal(DSExp.sanitizeFilename("   .  "), "会话");
assert.ok(DSExp.sanitizeFilename("x".repeat(80)).length <= 40);

// ---------------- XSS 转义 ----------------
const evil = DSExp.renderMessagesHtml([{ role: "user", inserted_at: 0, content: "<script>alert('xss')</script>", thinking: "", searches: [] }]);
assert.ok(!evil.includes("<script>alert"), "内容不得原样输出 <script>");
assert.ok(evil.includes("&lt;script&gt;"));

// ---------------- TXT ----------------
const txt = DSExp.buildTxt(s);
assert.ok(txt.startsWith("DeepSeek 会话记录\n"));
assert.ok(txt.includes("【用户】") && txt.includes("【DeepSeek】"));
assert.ok(txt.includes("（思考过程）") && txt.includes("当前思考"));
assert.ok(txt.includes("（联网搜索：q）"));
assert.ok(!txt.includes("被重新生成的旧回答"), "TXT 不含被裁分支");
assert.ok(txt.trimEnd().endsWith("（完）"));

// ---------------- HTML 导出 ----------------
const html = DSExp.buildHtml(s);
assert.ok(html.startsWith("<!doctype html>"));
assert.ok(html.includes("<style>"));
assert.ok(html.includes("msg user") && html.includes("msg ai"));
assert.ok(html.includes("DeepSeek 对话导出"));

// ---------------- Markdown 导出 ----------------
const md = DSExp.buildMd(s);
assert.ok(md.startsWith("# DeepSeek 会话：测试会话"));
assert.ok(md.includes("## 👤 用户") && md.includes("## 🤖 DeepSeek"));
assert.ok(md.includes("> 💭 **思考过程**") && md.includes("> 当前思考"));
assert.ok(md.includes("**🔍 联网搜索**：q"));
assert.ok(md.includes("- [t](u)"));
assert.ok(md.includes("最终回答"));
assert.ok(!md.includes("被重新生成的旧回答"), "MD 不含被裁分支");
assert.ok(md.includes("由 DeepSeek 会话导出工具生成 · 非官方"));

// ---------------- 分段复制（大对话按 unit 拆分） ----------------
const longPlain = Array.from({ length: 30 }, (_, i) =>
  "【" + (i % 2 ? "DeepSeek" : "用户") + "】 第" + i + "条\n" + "内容".repeat(200) + " 第" + i + "条结束"
).join("\n\n");
const unitsLong = DSExp.splitPlainUnits(longPlain, 2000);
assert.ok(unitsLong.length >= 5, "拆成多段");
unitsLong.forEach((u) => assert.ok(u.length <= 2000, "每段不超预算"));
const rejoined = unitsLong.join("\n");
for (let i = 0; i < 30; i++) assert.ok(rejoined.includes("第" + i + "条结束"), "第 " + i + " 条不丢");
assert.equal(rejoined.split("【用户】").length - 1, 15, "用户消息标记不丢");

const oversize = DSExp.splitPlainUnits("【用户】 超长\n" + "长".repeat(9000), 2000);
assert.ok(oversize.length >= 5, "超长单条被硬切成多段");
oversize.forEach((u) => assert.ok(u.length <= 2000, "硬切段不超预算"));
assert.ok(oversize.join("").includes("长"), "内容保留");

console.log("✅ dsx_core.js 全部测试通过");
