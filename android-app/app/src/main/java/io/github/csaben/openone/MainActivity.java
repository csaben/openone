package io.github.csaben.openone;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * The openone panel (the server's web page) full screen, plus first-run setup: the
 * server's address, notification permission and an exemption from battery optimization
 * so the connection survives the screen being off.
 */
public class MainActivity extends Activity {
    private WebView web;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (Prefs.url(this).isEmpty()) setup(null);
        else open();
        maybeUpdate(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        maybeUpdate(intent);
    }

    // the "update is ready" notification opens the app with this
    private void maybeUpdate(Intent i) {
        if (i != null && i.getBooleanExtra("update", false)) {
            i.removeExtra("update");
            Updater.run(this);
        }
    }

    private void open() {
        askPermissions();
        WatchService.start(this);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0b0c0e"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // the panel's ⋯ menu shows "Server address" when this is there (see server/web/web.js)
        web.addJavascriptInterface(new Bridge(), "OOApp");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (u.toString().startsWith(Prefs.url(MainActivity.this))) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, u)); // other links open in the browser
                return true;
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) setup("Couldn't load " + Prefs.url(MainActivity.this) + ": " + e.getDescription()
                        + "\n\nIs Tailscale on?");
            }
        });
        setContentView(web);
        web.loadUrl(Prefs.url(this) + "/");
    }

    private void askPermissions() {
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
        PowerManager pm = getSystemService(PowerManager.class);
        if (!pm.isIgnoringBatteryOptimizations(getPackageName()) && !Prefs.flag(this, "askedBattery")) {
            Prefs.setFlag(this, "askedBattery");
            try {
                startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
            } catch (Exception ignored) {
            }
        }
    }

    /** The server address form; also shown when the page can't load. */
    private void setup(String error) {
        if (web != null) {
            web.destroy();
            web = null;
        }
        int pad = dp(24);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_VERTICAL);
        box.setPadding(pad, pad, pad, pad);
        box.setBackgroundColor(Color.parseColor("#0b0c0e"));

        TextView title = text("openone", 28, "#f1f2f4");
        TextView hint = text("Your openone server's address on your tailnet, like https://my-server.tailnet-name.ts.net:8951", 15, "#9a9ea8");
        hint.setPadding(0, dp(8), 0, dp(16));
        EditText url = new EditText(this);
        url.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        url.setSingleLine(true);
        url.setText(Prefs.url(this));
        url.setHint("https://…");
        url.setTextColor(Color.parseColor("#eeeff1"));
        url.setHintTextColor(Color.parseColor("#6c707a"));
        Button go = new Button(this);
        go.setText(error == null ? "Connect" : "Retry");
        TextView err = text(error == null ? "" : error, 14, "#ef8a7a");
        err.setPadding(0, dp(16), 0, 0);

        go.setOnClickListener(v -> {
            String u = url.getText().toString().trim();
            if (!u.matches("^https?://.+")) {
                err.setText("Start it with https://");
                return;
            }
            Prefs.setUrl(this, u);
            WatchService.reconnect(this);
            open();
        });
        box.addView(title);
        box.addView(hint);
        box.addView(url, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        box.addView(go);
        box.addView(err);
        setContentView(box);
    }

    private TextView text(String s, int sp, String color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(Color.parseColor(color));
        return t;
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        if (!Prefs.url(this).isEmpty()) new Thread(() -> Updater.check(this), "openone-update").start();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        if (web == null) {
            moveTaskToBack(true);
            return;
        }
        // the page closes its open sheet or menu first (window.ooBack in server/web/web.js)
        web.evaluateJavascript("!!(window.ooBack && window.ooBack())", v -> {
            if ("true".equals(v)) return;
            if (web.canGoBack()) web.goBack();
            else moveTaskToBack(true);
        });
    }


    /** What the page can ask of the app. */
    private class Bridge {
        @JavascriptInterface
        public void changeServer() {
            runOnUiThread(() -> setup(null));
        }

        @JavascriptInterface
        public String version() {
            return Updater.installedName(MainActivity.this);
        }

        @JavascriptInterface
        public void update() {
            runOnUiThread(() -> Updater.run(MainActivity.this));
        }
    }
}
