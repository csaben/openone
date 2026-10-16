package io.github.csaben.openone;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.util.ArrayList;
import java.util.List;

/**
 * "openone" in the share sheet: sends links, text or files to a computer. With one
 * computer online it goes straight there; with several it asks which (and remembers).
 * There, links open in the browser, text goes on the clipboard, files land in Downloads.
 */
public class ShareActivity extends Activity {
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (Prefs.url(this).isEmpty()) {
            toast("Open openone once to set its server first");
            finish();
            return;
        }
        new Thread(this::pickAndSend, "openone-share").start();
    }

    private void pickAndSend() {
        List<String> pcs = new ArrayList<>();
        try {
            JSONArray all = new JSONArray(Api.getText(this, "/api/devices"));
            for (int i = 0; i < all.length(); i++) if (!"phone".equals(all.optString(i))) pcs.add(all.optString(i));
        } catch (Exception e) {
            done("Couldn't reach openone: " + e.getMessage());
            return;
        }
        String last = getSharedPreferences("openone", 0).getString("shareTo", "");
        if (pcs.isEmpty() && !last.isEmpty()) pcs.add(last); // asleep or offline: it gets it when it's back
        if (pcs.isEmpty()) {
            done("No computer is running openone right now");
            return;
        }
        if (pcs.size() == 1) {
            send(pcs.get(0));
            return;
        }
        String[] names = pcs.toArray(new String[0]);
        runOnUiThread(() -> new AlertDialog.Builder(this)
                .setTitle("Send to")
                .setItems(names, (d, which) -> new Thread(() -> send(names[which])).start())
                .setOnCancelListener(d -> finish())
                .show());
    }

    private void send(String to) {
        getSharedPreferences("openone", 0).edit().putString("shareTo", to).apply();
        Intent i = getIntent();
        try {
            List<Uri> files = new ArrayList<>();
            if (Intent.ACTION_SEND_MULTIPLE.equals(i.getAction())) {
                @SuppressWarnings("deprecation") ArrayList<Uri> many = i.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (many != null) files.addAll(many);
            } else {
                @SuppressWarnings("deprecation") Uri one = i.getParcelableExtra(Intent.EXTRA_STREAM);
                if (one != null) files.add(one);
            }
            String text = i.getStringExtra(Intent.EXTRA_TEXT);
            if (files.isEmpty() && (text == null || text.trim().isEmpty())) {
                done("Nothing to send");
                return;
            }
            for (Uri u : files) sendFile(to, u);
            if (files.isEmpty()) {
                String subject = i.getStringExtra(Intent.EXTRA_SUBJECT);
                String body = subject != null && !subject.isEmpty() && !text.contains(subject) ? subject + "\n" + text : text;
                Api.post(this, "/api/drops", new JSONObject().put("to", to).put("from", "phone").put("text", body));
            }
            done(files.size() > 1 ? "Sent " + files.size() + " files to " + to : "Sent to " + to);
        } catch (Exception e) {
            done("Couldn't send: " + e.getMessage());
        }
    }

    private void sendFile(String to, Uri u) throws Exception {
        ContentResolver cr = getContentResolver();
        String name = "file";
        try (Cursor c = cr.query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && c.getString(0) != null) name = c.getString(0);
        }
        String mime = cr.getType(u);
        HttpURLConnection conn = Api.open(this, "/api/drops/file?to=" + Uri.encode(to) + "&from=phone&name=" + Uri.encode(name));
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setChunkedStreamingMode(1 << 16);
        conn.setReadTimeout(120000);
        conn.setRequestProperty("content-type", mime == null ? "application/octet-stream" : mime);
        try (InputStream in = cr.openInputStream(u); OutputStream out = conn.getOutputStream()) {
            byte[] buf = new byte[1 << 16];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        }
        int code = conn.getResponseCode();
        conn.disconnect();
        if (code >= 400) throw new Exception(name + ": HTTP " + code);
    }

    private void done(String msg) {
        runOnUiThread(() -> {
            toast(msg);
            finish();
        });
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }
}
