package com.minaryhub.robotemulator;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.system.Os;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 로봇 에뮬레이터 Android 앱.
 *  1) APK 의 assets/nodejs-project.zip (서버 + 화면 + node_modules) 을 앱 저장소에 풀고 (버전이 바뀌었을 때만)
 *  2) nodejs-mobile 의 Node 로 server/index.js 를 별도 스레드에서 실행
 *  3) 서버가 응답하면 WebView 로 http://127.0.0.1:3000 을 연다
 * 프로젝트(projects/)·3D 모델(assets/)·config.json 은 사용자 데이터이므로 갱신할 때도 지우지 않는다.
 * Node 는 프로세스당 한 번만 시작할 수 있어서, 액티비티가 다시 만들어져도 서버는 그대로 둔다.
 */
public class MainActivity extends Activity {
    static {
        System.loadLibrary("node");
        System.loadLibrary("native-lib");
    }

    public native int startNodeWithArguments(String[] arguments);

    private static final String TAG = "RobotEmulator";
    private static final String URL_BASE = "http://127.0.0.1:3000/";
    private static final String[] KEEP = { "projects", "assets", "config.json" };
    private static volatile boolean nodeStarted = false;
    private static volatile String startError = null;

    private WebView web;
    private TextView status;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(0x15, 0x18, 0x1c));
        web = new WebView(this);
        web.setVisibility(View.INVISIBLE);
        status = new TextView(this);
        status.setTextColor(Color.rgb(0xe3, 0xe7, 0xec));
        status.setTextSize(16);
        status.setGravity(Gravity.CENTER);
        status.setPadding(48, 48, 48, 48);
        status.setText(ko() ? "로봇 에뮬레이터 시작 중…" : "Starting Robot Emulator…");
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        root.addView(status, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        setupWebView();

        if (!nodeStarted) {
            nodeStarted = true;
            new Thread(this::startServer, "node").start();
        }
        waitForServer(0);
    }

    private boolean ko() { return Locale.getDefault().getLanguage().equals("ko"); }

    private void setupWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        web.setWebViewClient(new WebViewClient() {
            // 에뮬레이터 화면은 WebView 안에서, 외부 링크(GitHub 이슈·후원 등)는 브라우저로
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if ("127.0.0.1".equals(u.getHost()) || "localhost".equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            // <input type="file"> (프로젝트·3D 모델·CSV 가져오기)
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                try { startActivityForResult(params.createIntent(), 1); } catch (Exception e) { fileCallback = null; return false; }
                return true;
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == 1 && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    // ---------------------------------------------------------------- 서버 시작
    private void startServer() {
        try {
            File dir = new File(getFilesDir(), "nodejs-project");
            unpackIfNeeded(dir);
            File tmp = new File(getCacheDir(), "tmp");
            tmp.mkdirs();
            Os.setenv("HOME", getFilesDir().getAbsolutePath(), true);
            Os.setenv("TMPDIR", tmp.getAbsolutePath(), true);
            Os.setenv("ROBOT_EMU_PLATFORM", "android", true);
            Log.i(TAG, "node 시작: " + dir);
            int code = startNodeWithArguments(new String[] { "node", new File(dir, "server/index.js").getAbsolutePath() });
            startError = "Node exited (" + code + ")";
        } catch (Throwable e) {
            Log.e(TAG, "서버 시작 실패", e);
            startError = e.toString();
        }
    }

    private String readAll(InputStream in) throws IOException {
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            StringBuilder b = new StringBuilder();
            String l;
            while ((l = r.readLine()) != null) b.append(l);
            return b.toString().trim();
        }
    }

    // 앱 자산 버전이 다르면 사용자 데이터만 남기고 새로 푼다
    private void unpackIfNeeded(File dir) throws IOException {
        String want = readAll(getAssets().open("bundle-version.txt"));
        File stamp = new File(dir, ".bundle-version");
        if (stamp.exists()) {
            try (InputStream in = new java.io.FileInputStream(stamp)) { if (want.equals(readAll(in))) return; }
        }
        status(ko() ? "처음 실행 준비 중 (파일 풀기)…" : "Preparing first run (unpacking)…");
        if (dir.exists()) {
            File[] list = dir.listFiles();
            if (list != null) for (File f : list) if (!keep(f.getName())) deleteTree(f);
        }
        dir.mkdirs();
        byte[] buf = new byte[1 << 16];
        int count = 0;
        try (ZipInputStream zin = new ZipInputStream(getAssets().open("nodejs-project.zip"))) {
            ZipEntry e;
            while ((e = zin.getNextEntry()) != null) {
                File out = new File(dir, e.getName());
                if (!out.getCanonicalPath().startsWith(dir.getCanonicalPath() + File.separator)) continue;   // zip 경로 조작 방지
                String top = e.getName().split("/")[0];
                if (keep(top) && out.exists()) continue;
                if (e.isDirectory()) { out.mkdirs(); continue; }
                out.getParentFile().mkdirs();
                try (OutputStream os = new FileOutputStream(out)) {
                    int n;
                    while ((n = zin.read(buf)) > 0) os.write(buf, 0, n);
                }
                if (++count % 500 == 0) status((ko() ? "파일 풀기 " : "Unpacking ") + count);
            }
        }
        try (OutputStream os = new FileOutputStream(stamp)) { os.write(want.getBytes(StandardCharsets.UTF_8)); }
        status(ko() ? "서버 시작 중…" : "Starting server…");
    }

    private static boolean keep(String name) {
        for (String k : KEEP) if (k.equals(name)) return true;
        return false;
    }

    private static void deleteTree(File f) {
        File[] list = f.listFiles();
        if (list != null) for (File c : list) deleteTree(c);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private void status(String text) { ui.post(() -> status.setText(text)); }

    // 서버가 응답할 때까지 0.5초마다 확인 → 화면 열기
    private void waitForServer(int tries) {
        new Thread(() -> {
            boolean up = false;
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(URL_BASE + "api/state").openConnection();
                c.setConnectTimeout(400);
                c.setReadTimeout(800);
                up = c.getResponseCode() == 200;
                c.disconnect();
            } catch (IOException ignored) { }
            final boolean ok = up;
            ui.post(() -> {
                if (ok) {
                    if (web.getUrl() == null) web.loadUrl(URL_BASE);
                    web.setVisibility(View.VISIBLE);
                    status.setVisibility(View.GONE);
                } else if (startError != null) {
                    status.setText((ko() ? "서버를 시작할 수 없습니다\n\n" : "Could not start the server\n\n") + startError);
                } else {
                    ui.postDelayed(() -> waitForServer(tries + 1), 500);
                }
            });
        }).start();
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true);   // 서버는 계속 실행 (앱 전환 후 돌아오면 그대로)
    }
}
