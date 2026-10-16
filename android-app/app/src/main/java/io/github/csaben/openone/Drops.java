package io.github.csaben.openone;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.MediaStore;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;

/**
 * Things a computer sent to the phone (the tray's "Send clipboard to phone", Explorer's
 * Send to). Links: a notification that opens them. Text: one that copies it. Files: saved
 * to Downloads right away, with a notification that opens them. Each is taken off the
 * server once it's here.
 */
final class Drops {
    private Drops() {}

    static final String CH_DROP = "drops";

    /** Blocking: call off the main thread. */
    static void receive(Context c, JSONObject d) {
        String id = d.optString("id");
        String from = d.optString("from", "your computer");
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CH_DROP, "Sent from your computer", NotificationManager.IMPORTANCE_HIGH));
        String tag = "drop:" + id;
        try {
            if ("file".equals(d.optString("kind"))) {
                Uri saved = save(c, d);
                Intent open = new Intent(Intent.ACTION_VIEW).setDataAndType(saved, d.optString("mime", "*/*"))
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                nm.notify(tag, 1, base(c, "Saved " + d.optString("name") + " from " + from, "In Downloads. Tap to open.")
                        .setContentIntent(PendingIntent.getActivity(c, tag.hashCode(), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
                        .build());
            } else {
                String text = d.optString("text");
                JSONArray links = d.optJSONArray("links");
                Intent copy = ActionReceiver.intent(c, "copy", tag).putExtra("text", text);
                PendingIntent copyPi = PendingIntent.getBroadcast(c, (tag + "#copy").hashCode(), copy, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                Notification.Builder b = base(c, links != null && links.length() > 0 ? "Link from " + from : "Text from " + from, text)
                        .setStyle(new Notification.BigTextStyle().bigText(text));
                for (int i = 0; links != null && i < links.length() && i < 2; i++) {
                    Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse(links.optString(i))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    PendingIntent pi = PendingIntent.getActivity(c, (tag + "#" + i).hashCode(), view, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                    if (i == 0) b.setContentIntent(pi);
                    b.addAction(new Notification.Action.Builder(null, links.length() > 1 ? "Open " + (i + 1) : "Open", pi).build());
                }
                if (links == null || links.length() == 0) b.setContentIntent(copyPi);
                b.addAction(new Notification.Action.Builder(null, "Copy", copyPi).build());
                nm.notify(tag, 1, b.build());
            }
            Api.delete(c, "/api/drops/" + Uri.encode(id));
        } catch (Exception e) {
            nm.notify(tag, 1, base(c, "Couldn't receive from " + from, String.valueOf(e.getMessage())).build());
        }
    }

    private static Notification.Builder base(Context c, String title, String text) {
        return new Notification.Builder(c, CH_DROP)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(title)
                .setContentText(text)
                .setAutoCancel(true)
                .setGroup("drop:" + title); // not bundled under "Connected"
    }

    /** The file into Downloads (MediaStore, no storage permission needed). */
    private static Uri save(Context c, JSONObject d) throws Exception {
        HttpURLConnection conn = Api.open(c, "/api/drops/" + Uri.encode(d.optString("id")) + "/file");
        conn.setReadTimeout(120000);
        if (conn.getResponseCode() != 200) throw new Exception("HTTP " + conn.getResponseCode());
        ContentResolver cr = c.getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.Downloads.DISPLAY_NAME, d.optString("name", "file"));
        v.put(MediaStore.Downloads.MIME_TYPE, d.optString("mime", "application/octet-stream"));
        v.put(MediaStore.Downloads.IS_PENDING, 1);
        Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        if (uri == null) throw new Exception("couldn't create the file in Downloads");
        try (InputStream in = conn.getInputStream(); OutputStream out = cr.openOutputStream(uri)) {
            byte[] buf = new byte[1 << 16];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        } catch (Exception e) {
            cr.delete(uri, null, null);
            throw e;
        } finally {
            conn.disconnect();
        }
        v.clear();
        v.put(MediaStore.Downloads.IS_PENDING, 0);
        cr.update(uri, v, null, null);
        return uri;
    }
}
