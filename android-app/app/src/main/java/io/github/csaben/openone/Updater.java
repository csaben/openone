package io.github.csaben.openone;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.provider.Settings;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Updates from the openone server: GET /api/app says which build is newest. When it's
 * newer than this one, a notification offers it; tapping that (or "Update app" in the
 * panel's menu) downloads the APK and hands it to Android's installer, which asks once.
 */
final class Updater {
    private Updater() {}

    static final String CH_UPDATE = "update";
    static final int NOTE_ID = 9;

    static long installed(Context c) {
        try {
            return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).getLongVersionCode();
        } catch (PackageManager.NameNotFoundException e) {
            return 0;
        }
    }

    static String installedName(Context c) {
        try {
            return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName;
        } catch (PackageManager.NameNotFoundException e) {
            return "?";
        }
    }

    /** The newest build if it's newer than this one, else null. Blocking. */
    static JSONObject newer(Context c) {
        try {
            JSONObject j = Api.get(c, "/api/app");
            return j.optLong("versionCode") > installed(c) && !j.optString("apkUrl").isEmpty() ? j : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** From the service: tell about a newer build, once per version. Blocking. */
    static void check(Context c) {
        JSONObject j = newer(c);
        if (j == null) return;
        long v = j.optLong("versionCode");
        if (c.getSharedPreferences("openone", 0).getLong("toldVersion", 0) == v) return;
        c.getSharedPreferences("openone", 0).edit().putLong("toldVersion", v).apply();
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new android.app.NotificationChannel(CH_UPDATE, "App updates", NotificationManager.IMPORTANCE_DEFAULT));
        Intent open = new Intent(c, MainActivity.class).putExtra("update", true).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        nm.notify(NOTE_ID, new Notification.Builder(c, CH_UPDATE)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("openone " + j.optString("versionName") + " is ready")
                .setContentText("Tap to update (you have " + installedName(c) + ")")
                .setAutoCancel(true)
                .setContentIntent(PendingIntent.getActivity(c, 9, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
                .build());
    }

    /** From the activity: check, download and install. Says what's happening in toasts. */
    static void run(Activity a) {
        if (!a.getPackageManager().canRequestPackageInstalls()) {
            toast(a, "Allow openone to install updates, then tap Update again");
            a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.getPackageName())));
            return;
        }
        toast(a, "Checking for an update…");
        new Thread(() -> {
            JSONObject j = newer(a);
            if (j == null) {
                toast(a, "openone " + installedName(a) + " is the newest");
                return;
            }
            toast(a, "Downloading openone " + j.optString("versionName") + "…");
            try {
                install(a, j.optString("apkUrl"));
                a.getSystemService(NotificationManager.class).cancel(NOTE_ID);
            } catch (Exception e) {
                toast(a, "Update failed: " + e.getMessage());
            }
        }).start();
    }

    private static void install(Context c, String apkUrl) throws Exception {
        PackageInstaller pi = c.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(c.getPackageName());
        int id = pi.createSession(params);
        try (PackageInstaller.Session s = pi.openSession(id)) {
            HttpURLConnection conn = (HttpURLConnection) new URL(apkUrl).openConnection();
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(60000);
            if (conn.getResponseCode() != 200) throw new Exception("download: HTTP " + conn.getResponseCode());
            try (InputStream in = conn.getInputStream(); OutputStream out = s.openWrite("openone.apk", 0, conn.getContentLengthLong())) {
                byte[] buf = new byte[1 << 16];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                s.fsync(out);
            }
            Intent done = new Intent(c, Status.class);
            s.commit(PendingIntent.getBroadcast(c, id, done, PendingIntent.FLAG_MUTABLE | PendingIntent.FLAG_UPDATE_CURRENT).getIntentSender());
        }
    }

    private static void toast(Activity a, String msg) {
        a.runOnUiThread(() -> Toast.makeText(a, msg, Toast.LENGTH_LONG).show());
    }

    /** The installer's answer: it needs the user's OK (show its prompt), or it's done. */
    public static class Status extends BroadcastReceiver {
        @Override
        public void onReceive(Context c, Intent i) {
            int st = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                @SuppressWarnings("deprecation") Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT); // the typed form needs API 33
                if (confirm != null) c.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } else if (st != PackageInstaller.STATUS_SUCCESS) {
                Toast.makeText(c, "Update failed: " + i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE), Toast.LENGTH_LONG).show();
            }
        }
    }
}
