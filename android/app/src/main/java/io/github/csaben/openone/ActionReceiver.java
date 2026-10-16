package io.github.csaben.openone;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import org.json.JSONObject;

/** A button on a notification: answer an ask or a menu, mark an agent seen, or reply. */
public class ActionReceiver extends BroadcastReceiver {
    static final String REPLY = "reply";

    static Intent intent(Context c, String kind, String tag) {
        return new Intent(c, ActionReceiver.class).putExtra("kind", kind).putExtra("tag", tag);
    }

    @Override
    public void onReceive(Context c, Intent i) {
        PendingResult done = goAsync();
        new Thread(() -> {
            String tag = i.getStringExtra("tag");
            try {
                act(c, i);
                WatchService.forget(c, tag);
            } catch (Exception e) {
                failed(c, tag, e.getMessage());
            } finally {
                done.finish();
            }
        }).start();
    }

    private static void act(Context c, Intent i) throws Exception {
        String kind = i.getStringExtra("kind");
        String key = Uri.encode(i.getStringExtra("key") == null ? "" : i.getStringExtra("key"));
        switch (kind == null ? "" : kind) {
            case "ask":
                Api.post(c, "/api/asks/" + Uri.encode(i.getStringExtra("id")) + "/answer",
                        new JSONObject().put("option", i.getStringExtra("option")).put("by", "phone"));
                break;
            case "answer":
                Api.post(c, "/api/panes/" + key + "/answer", new JSONObject().put("n", i.getIntExtra("n", 0)));
                break;
            case "seen":
                Api.post(c, "/api/panes/" + key + "/seen", null);
                break;
            case "reply": {
                Bundle in = RemoteInput.getResultsFromIntent(i);
                CharSequence text = in == null ? null : in.getCharSequence(REPLY);
                if (text == null || text.toString().trim().isEmpty()) return;
                Api.post(c, "/api/panes/" + key + "/reply", new JSONObject().put("text", text.toString()));
                break;
            }
            default:
                throw new Exception("unknown action " + kind);
        }
    }

    private static void failed(Context c, String tag, String why) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        nm.notify(tag, WatchService.ITEM_ID, new Notification.Builder(c, WatchService.CH_ASK)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Couldn't reach openone")
                .setContentText(why == null ? "Is Tailscale on?" : why)
                .setAutoCancel(true)
                .build());
    }
}
