package com.beyondstand.deepseekexport;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * DeepSeek 会话导出 —— 单 Activity + WebView。
 *
 * 页面就是 https://chat.deepseek.com（官方站，在本页正常登录即授权），
 * onPageFinished 注入 assets/dsx_core.js + assets/dsx_main.js；
 * 注入后的悬浮面板通过 window.DSExport（@JavascriptInterface）与本类通信：
 *   saveFile(name, mime, content) → MediaStore.Downloads 保存，返回 JSON 结果
 *   openDownloads()               → 打开系统下载界面
 *   toast(msg)                   → 原生提示（页内提示失效时的兜底诊断通道）
 * 只申请 INTERNET 权限；API 29+ 写 MediaStore.Downloads 无需存储权限。
 */
public class MainActivity extends Activity {

    private static final String TAG = "DSExport";
    private static final String START_URL = "https://chat.deepseek.com/";
    private static final long MAX_BYTES = 64L * 1024 * 1024; // 单文件 64MB 防御上限

    private WebView webView;
    private String coreJs;
    private String mainJs;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        setContentView(webView);
        webView.setBackgroundColor(0xFF0B1220);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);      // 注入脚本的前提
        s.setDomStorageEnabled(true);      // DeepSeek 登录态存于 localStorage
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new Bridge(), "DSExport");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                String host = u.getHost() == null ? "" : u.getHost();
                if (host.equals("chat.deepseek.com") || host.endsWith(".deepseek.com")) {
                    return false; // 官方页面留在 App 内
                }
                String scheme = u.getScheme() == null ? "" : u.getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) {
                    try { // 外链交给系统浏览器，避免 WebView 困在第三方页
                        startActivity(new Intent(Intent.ACTION_VIEW, u));
                    } catch (Exception e) {
                        toastOnUiThread("无法打开外部链接：" + u);
                    }
                }
                return true; // 其余 scheme 一律拦截
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (url == null) return;
                String host = Uri.parse(url).getHost();
                if (host != null && host.endsWith("deepseek.com")) {
                    inject(view); // 整页刷新后重新注入（JS 侧有幂等保护）
                }
            }
        });
        webView.loadUrl(START_URL);
    }

    /** 读取注入脚本（assets 不变，只读一次）。 */
    private synchronized void ensureAssets() {
        if (coreJs == null) coreJs = readAsset("dsx_core.js");
        if (mainJs == null) mainJs = readAsset("dsx_main.js");
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            return bo.toString("UTF-8");
        } catch (Exception e) {
            Log.e(TAG, "读取 assets/" + name + " 失败", e);
            return "";
        }
    }

    private void inject(final WebView view) {
        ensureAssets();
        if (coreJs != null && !coreJs.isEmpty()) {
            view.evaluateJavascript(coreJs, r -> Log.i(TAG, "dsx_core 注入完成 -> " + r));
        }
        if (mainJs != null && !mainJs.isEmpty()) {
            view.evaluateJavascript(mainJs, r -> Log.i(TAG, "dsx_main 注入完成 -> " + r));
        }
    }

    // ---------------- 生命周期 ----------------

    @Override
    public void onBackPressed() {
        // 返回键 = 网页后退（SPA 历史同样适用），退无可退才退出 App
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    // ---------------- 工具 ----------------

    private void toastOnUiThread(String msg) {
        runOnUiThread(() -> Toast.makeText(this, msg, Toast.LENGTH_LONG).show());
    }

    private static String err(String message) {
        return "{\"ok\":false,\"error\":" + JSONObject.quote(message) + "}";
    }

    /** 文件名清洗：去非法字符、限长、保证扩展名。 */
    private static String sanitizeName(String name, String mime) {
        String s = name == null ? "" : name.trim();
        s = s.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1F\\x7F]", "_");
        s = s.replaceAll("\\s+", " ").trim();
        if (s.startsWith(".")) s = "_" + s;
        if (s.length() > 120) s = s.substring(0, 120);
        if (s.isEmpty()) s = "DeepSeek_export";
        boolean html = mime != null && mime.contains("html");
        boolean md = mime != null && mime.contains("markdown");
        if (!s.toLowerCase().matches(".*\\.(html?|txt|md)$")) s += html ? ".html" : md ? ".md" : ".txt";
        return s;
    }

    // ---------------- JS 桥（window.DSExport） ----------------

    /** 注意：@JavascriptInterface 方法运行在 WebView 的后台线程。 */
    private class Bridge {

        @JavascriptInterface
        public String version() { return "0.3"; }

        /**
         * 保存文本文件到公共 Download 目录（API 29+ 无需权限）。
         * 返回 JSON 字符串：{"ok":true,"name","path","size"} 或 {"ok":false,"error"}。
         */
        @JavascriptInterface
        public String saveFile(String name, String mime, String content) {
            try {
                if (content == null) return err("内容为空");
                byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
                if (bytes.length > MAX_BYTES) return err("文件过大：" + bytes.length + " 字节");
                String safe = sanitizeName(name, mime);

                ContentValues cv = new ContentValues();
                cv.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                cv.put(MediaStore.Downloads.MIME_TYPE,
                        mime != null && mime.contains("/") ? mime
                                : (mime != null && mime.contains("html") ? "text/html" : "text/plain"));
                cv.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                cv.put(MediaStore.Downloads.IS_PENDING, 1);

                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri == null) return err("MediaStore 创建文件失败");

                OutputStream os = null;
                try {
                    os = getContentResolver().openOutputStream(uri);
                    if (os == null) return failPending(uri, "打开输出流失败");
                    os.write(bytes);
                    os.flush();
                } catch (Exception e) {
                    return failPending(uri, "写入失败：" + e.getMessage());
                } finally {
                    if (os != null) try { os.close(); } catch (Exception ignored) {}
                }

                ContentValues done = new ContentValues();
                done.put(MediaStore.Downloads.IS_PENDING, 0);
                try { getContentResolver().update(uri, done, null, null); } catch (Exception ignored) {}

                JSONObject o = new JSONObject();
                o.put("ok", true);
                o.put("name", safe);
                o.put("path", Environment.DIRECTORY_DOWNLOADS + "/" + safe);
                o.put("size", bytes.length);
                return o.toString();
            } catch (Exception e) {
                Log.e(TAG, "saveFile 失败", e);
                return err("保存失败：" + e.getMessage());
            }
        }

        /** 写入中途失败：把 IS_PENDING 的孤儿文件删掉再返回错误。 */
        private String failPending(Uri uri, String message) {
            try { getContentResolver().delete(uri, null, null); } catch (Exception ignored) {}
            return err(message);
        }

        /** 打开系统「下载」管理界面。 */
        @JavascriptInterface
        public void openDownloads() {
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(DownloadManager.ACTION_VIEW_DOWNLOADS));
                } catch (Exception e) {
                    toastOnUiThread("未找到系统下载界面，请到文件管理查看 Download 目录");
                }
            });
        }

        /** 原生提示（页内 toast 失效时的兜底诊断通道）。 */
        @JavascriptInterface
        public void toast(String msg) {
            toastOnUiThread(msg == null ? "" : msg);
        }

        /** 复制文本到系统剪贴板（纯文本无需权限；API 29+ 系统自带粘贴提示）。 */
        @JavascriptInterface
        public void copy(String text) {
            try {
                android.content.ClipboardManager cm =
                        (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                cm.setPrimaryClip(android.content.ClipData.newPlainText("DeepSeek 导出",
                        text == null ? "" : text));
                toastOnUiThread("已复制到剪贴板");
            } catch (Exception e) {
                toastOnUiThread("复制失败：" + e.getMessage());
            }
        }
    }
}
