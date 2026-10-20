package io.github.csaben.openone;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Small blocking HTTP calls to the openone server. Call off the main thread. */
final class Api {
    private Api() {}

    static JSONObject post(Context c, String path, JSONObject body) throws IOException {
        HttpURLConnection conn = open(c, path);
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setRequestProperty("content-type", "application/json");
        byte[] data = (body == null ? "{}" : body.toString()).getBytes(StandardCharsets.UTF_8);
        try (OutputStream out = conn.getOutputStream()) {
            out.write(data);
        }
        return read(conn);
    }

    static JSONObject get(Context c, String path) throws IOException {
        return read(open(c, path));
    }

    /** The raw body, for answers that aren't an object (a JSON array). */
    static String getText(Context c, String path) throws IOException {
        HttpURLConnection conn = open(c, path);
        int code = conn.getResponseCode();
        if (code >= 400) throw new IOException("HTTP " + code);
        String text = slurp(conn.getInputStream());
        conn.disconnect();
        return text;
    }

    static void delete(Context c, String path) throws IOException {
        HttpURLConnection conn = open(c, path);
        conn.setRequestMethod("DELETE");
        conn.getResponseCode();
        conn.disconnect();
    }

    static HttpURLConnection open(Context c, String path) throws IOException {
        String base = Prefs.url(c);
        if (base.isEmpty()) throw new IOException("no server set");
        HttpURLConnection conn = (HttpURLConnection) new URL(base + path).openConnection();
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(15000);
        return conn;
    }

    private static JSONObject read(HttpURLConnection conn) throws IOException {
        int code = conn.getResponseCode();
        InputStream in = code < 400 ? conn.getInputStream() : conn.getErrorStream();
        String text = in == null ? "" : slurp(in);
        conn.disconnect();
        JSONObject j;
        try {
            j = text.trim().startsWith("{") ? new JSONObject(text) : new JSONObject();
        } catch (Exception e) {
            j = new JSONObject();
        }
        if (code >= 400) throw new IOException(j.optString("error", "HTTP " + code));
        return j;
    }

    static String slurp(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] b = new byte[8192];
        for (int n; (n = in.read(b)) > 0; ) buf.write(b, 0, n);
        in.close();
        return buf.toString("UTF-8");
    }
}
