# DeepSeek 会话导出（安卓 App）

在手机上把你在 DeepSeek（chat.deepseek.com）的会话导出为 HTML / TXT 文件。

- App 内嵌 DeepSeek 官网登录页，**在本页正常登录即授权**——不采集账号密码、不读取 DeepSeek 官方 App。
- 会话是账号级同步的：WebView 登录官网即可看到手机上聊的全部会话。
- 登录后页面出现「DS导出」悬浮胶囊（可拖动），展开面板即可导出，文件保存到系统 **Download** 目录并弹确认。

token 只在本机 WebView 内用于同源接口请求，不上传、不落盘；导出的文件保存在你自己手机的下载目录。

## 下载 APK（无需本地安卓环境）

本仓库用 GitHub Actions 自动构建：

1. 打开 **Actions → build-apk → 最新一次绿色运行**；
2. 底部 Artifacts 下载 `app-debug-apk`（zip 里是 `app-debug.apk`）——在 GitHub 页面下载 artifact 需要登录 GitHub 账号；
   命令行等价：`gh run download -R Beyondstand/deepseek-export-android -n app-debug-apk`。

## 安装（侧载 debug 包）

- 把 `app-debug.apk` 传到手机点击安装；
- 系统提示「未知来源 / 安装未知应用」时允许即可（debug 签名，仅自用）；
- MIUI 等国产系统可能还要求开启「未知来源」并登录账号确认，属系统行为。

## 使用（当前版本 v0.2）

1. 打开 App → 自动加载 chat.deepseek.com → 正常登录（登录即授权，本 App 不碰账号密码、不读官方 App）；
2. 登录后胶囊圆点变绿；点进任意一个会话（地址变为 /a/…）；
3. 轻点「⬇ DS导出」胶囊（长按可拖动到任意位置）展开面板；
4. 「格式:HTML/TXT」选好格式 → 点「📤 导出当前对话」；
5. 成功后页内 + 系统双弹确认，文件出现在手机「下载」目录：`DeepSeek_<标题>_<时间戳>.html/txt`；
6. 「📂 下载目录」直接跳到系统下载界面。

诊断：状态行实时显示登录态与最近动作结果；底部徽章 API/已存/失败计数；「诊断日志」可展开——出问题时把内容照抄/截图反馈即可。

> 历史版本 v0.1（骨架自检版，无需登录）的 APK 仍在对应 Actions 运行里可下载，可用于在遇到导出问题时区分「注入/桥接问题」还是「接口问题」：v0.1 的「测试保存」能成功说明注入与保存链路正常。

## 路线图（小步提交，先真机验证再叠加）

- [x] v0.1 工程骨架 + Actions 出 APK + 桥接链路自检
- [x] v0.2 拉取接口，导出**当前对话**为 HTML/TXT（真机验证点①）
- [ ] v0.3 全部会话列表 + 批量导出（页内弹层，逐个或全部）
- [ ] v0.4 分享到其他应用 / 在线临时链接（读完即删）

## 常见问题

- **点导出提示 INVALID_TOKEN / 未登录**：在 App 内的 DeepSeek 页面退出重登一次，再回到会话页导出。
- **Download 里找不到文件**：用面板上的「📂 打开下载目录」，或用文件管理器进入内部存储 Download 目录。
- **导出内容**：HTML 里思考过程折叠展示、联网搜索保留标题+链接；TXT 为纯文本同结构。

## 免责

非官方工具，仅用于导出你自己的账号数据；接口来自网页端公开行为，若官方改版可能需要更新脚本。

## 开发

- 单 Activity + WebView，Java，零第三方依赖，minSdk 29 / targetSdk 34；
- `app/src/main/assets/dsx_core.js`：归一化/分支裁剪/HTML/TXT 渲染纯函数（与网页版工具共用同源代码），`node tests/dsx_core.test.mjs` 可单测；
- `app/src/main/assets/dsx_main.js`：注入后的悬浮面板 UI 与原生桥（`window.DSExport`）胶水逻辑；
- `MainActivity.java`：WebView 容器 + `saveFile`（MediaStore.Downloads）/`openDownloads`/`toast` 桥；
- 修改后 push 即触发 Actions 出新 APK。
