package io.github.csaben.openone;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;

/**
 * One live connection to the openone server's event stream (GET /api/events), kept open
 * in a foreground service. Every state update is compared with what's already on screen:
 *
 *   ask       a question for you (Hermes, automic-clark, an agent's ask tool): its
 *             options as buttons
 *   input     an agent waiting at a menu: the menu's options as buttons
 *   done      an agent that finished a turn: "Got it" and an inline Reply
 *
 * A notification goes away once its item does (answered here, on the desk or anywhere).
 */
public class WatchService extends Service {
    static final String CH_STATUS = "status";
    static final String CH_ASK = "asks";
    static final String CH_INPUT = "waiting";
    static final String CH_DONE = "done";
    static final int STATUS_ID = 1;
    static final int ITEM_ID = 7; // items are told apart by their tag
    static final String ACTION_RECONNECT = "reconnect";

    private volatile boolean running;
    private volatile HttpURLConnection conn;
    private volatile boolean retryNow;
    private Thread thread;
    private NotificationManager nm;
    /** tag -> signature of what's posted, so a changed question re-posts and the same one doesn't */
    private final Map<String, String> shown = new HashMap<>();
    private boolean first = true;

    static void start(Context c) {
        c.startForegroundService(new Intent(c, WatchService.class));
    }

    static void reconnect(Context c) {
        c.startForegroundService(new Intent(c, WatchService.class).setAction(ACTION_RECONNECT));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        nm = getSystemService(NotificationManager.class);
        channels(nm);
        startForeground(STATUS_ID, status("Connecting…"), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        speaker = new Speaker(this);
        speaker.start();
    }

    /** agents' spoken replies, on your headphones when you're away from the computer */
    private Speaker speaker;

    static void channels(NotificationManager nm) {
        NotificationChannel s = new NotificationChannel(CH_STATUS, "Connection", NotificationManager.IMPORTANCE_MIN);
        s.setDescription("The always-on note that keeps openone connected");
        s.setShowBadge(false);
        NotificationChannel a = new NotificationChannel(CH_ASK, "Questions", NotificationManager.IMPORTANCE_HIGH);
        a.setDescription("Questions for you, like confirming a calendar event or handing a key to an agent");
        NotificationChannel i = new NotificationChannel(CH_INPUT, "Agent waiting", NotificationManager.IMPORTANCE_HIGH);
        i.setDescription("An agent stopped at a menu and needs your answer");
        NotificationChannel d = new NotificationChannel(CH_DONE, "Agent finished", NotificationManager.IMPORTANCE_DEFAULT);
        d.setDescription("An agent finished its turn");
        for (NotificationChannel ch : new NotificationChannel[]{s, a, i, d}) nm.createNotificationChannel(ch);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (thread == null) {
            running = true;
            thread = new Thread(this::loop, "openone-events");
            thread.start();
        } else if (intent != null && ACTION_RECONNECT.equals(intent.getAction())) {
            retryNow = true;
            HttpURLConnection c = conn;
            if (c != null) c.disconnect(); // the loop reconnects (maybe to a new address)
            thread.interrupt(); // or stops waiting out its backoff
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (speaker != null) speaker.stop();
        HttpURLConnection c = conn;
        if (c != null) c.disconnect();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ---------- the event stream ----------

    private void loop() {
        long backoff = 2000;
        while (running) {
            try {
                HttpURLConnection c = Api.open(this, "/api/events");
                c.setReadTimeout(75000); // the server pings every 20 s; silence this long = dead link
                c.setRequestProperty("accept", "text/event-stream");
                conn = c;
                if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
                backoff = 2000;
                checkUpdate();
                BufferedReader in = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
                String event = "message";
                StringBuilder data = new StringBuilder();
                for (String line; (line = in.readLine()) != null; ) {
                    if (line.isEmpty()) {
                        if (data.length() > 0) handle(event, data.toString());
                        event = "message";
                        data.setLength(0);
                    } else if (line.startsWith("event:")) {
                        event = line.substring(6).trim();
                    } else if (line.startsWith("data:")) {
                        if (data.length() > 0) data.append('\n');
                        data.append(line.substring(5).trim());
                    }
                }
            } catch (Exception e) {
                if (!running) return;
                setStatus("Reconnecting… (" + shortError(e) + ")");
            } finally {
                HttpURLConnection c = conn;
                if (c != null) c.disconnect();
            }
            if (!running) return;
            if (retryNow) {
                retryNow = false;
                backoff = 2000;
                continue;
            }
            try {
                Thread.sleep(backoff);
            } catch (InterruptedException ignored) {
                // a reconnect request: go again now
            }
            backoff = retryNow ? 2000 : Math.min(backoff * 2, 30000);
            retryNow = false;
        }
    }

    private long checkedAt;

    /** On each (re)connect, at most every 30 minutes: is there a newer app build? */
    private void checkUpdate() {
        if (System.currentTimeMillis() - checkedAt < 30 * 60_000L) return;
        checkedAt = System.currentTimeMillis();
        new Thread(() -> Updater.check(this), "openone-update").start();
    }

    private static String shortError(Exception e) {
        String m = e.getMessage();
        if (m == null || m.isEmpty()) m = e.getClass().getSimpleName();
        return m.length() > 60 ? m.substring(0, 60) : m;
    }

    private void handle(String event, String data) {
        if (!"state".equals(event)) return;
        try {
            apply(new JSONObject(data));
        } catch (Exception ignored) {
        }
    }

    /** drops already being received, so a state update mid-download doesn't start it twice */
    private final Set<String> dropsTaken = new HashSet<>();

    private synchronized void apply(JSONObject s) {
        checkUpdate(); // throttled; a long-lived connection still notices new builds
        JSONArray drops = s.optJSONArray("drops");
        for (int i = 0; drops != null && i < drops.length(); i++) {
            JSONObject d = drops.optJSONObject(i);
            if (d == null || !dropsTaken.add(d.optString("id"))) continue;
            new Thread(() -> Drops.receive(this, d), "openone-drop").start();
        }
        Set<String> want = new HashSet<>();
        boolean quiet = first; // what was already waiting when we connected: post it, but silently
        first = false;
        int n = 0;

        JSONArray asks = s.optJSONArray("asks");
        for (int i = 0; asks != null && i < asks.length(); i++) {
            JSONObject a = asks.optJSONObject(i);
            if (a == null) continue;
            String tag = "ask:" + a.optString("id");
            want.add(tag);
            n++;
            String sig = a.optString("title") + a.optJSONArray("options");
            if (!sig.equals(shown.get(tag))) post(tag, sig, askNote(a, tag, quiet));
        }

        JSONArray panes = s.optJSONArray("panes");
        for (int i = 0; panes != null && i < panes.length(); i++) {
            JSONObject p = panes.optJSONObject(i);
            if (p == null || p.optString("kind").isEmpty() || !p.optBoolean("unseen")) continue;
            String st = p.optString("state");
            String key = p.optString("key");
            if ("input".equals(st)) {
                String tag = "in:" + key;
                want.add(tag);
                n++;
                String sig = p.optString("question") + p.optJSONArray("options");
                if (!sig.equals(shown.get(tag))) post(tag, sig, inputNote(p, tag, quiet));
            } else if ("idle".equals(st)) {
                String tag = "done:" + key;
                want.add(tag);
                if (!shown.containsKey(tag)) post(tag, "", doneNote(p, tag, quiet));
            }
        }

        for (Iterator<String> it = shown.keySet().iterator(); it.hasNext(); ) {
            String tag = it.next();
            if (!want.contains(tag)) {
                nm.cancel(tag, ITEM_ID);
                it.remove();
            }
        }
        setStatus(n == 0 ? "Connected" : "Connected · " + n + " waiting on you");
    }

    private void post(String tag, String sig, Notification n) {
        shown.put(tag, sig);
        nm.notify(tag, ITEM_ID, n);
    }

    /** Called by ActionReceiver once it acted on a notification, so it isn't posted again. */
    static void forget(Context c, String tag) {
        c.getSystemService(NotificationManager.class).cancel(tag, ITEM_ID);
    }

    // ---------- notifications ----------

    private Notification.Builder base(String channel, String tag, boolean quiet) {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        Notification.Builder b = new Notification.Builder(this, channel)
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(0xFFE5A03A)
                .setContentIntent(PendingIntent.getActivity(this, tag.hashCode(), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
                .setAutoCancel(false)
                .setOnlyAlertOnce(true)
                // a group of its own, so Android doesn't bundle it under the "Connected" note
                // with its buttons one tap deeper
                .setGroup(tag);
        // already waiting when we connected: show it without a sound (a group that only
        // alerts for its summary, which never comes, is how the framework API says "silent")
        if (quiet) b.setGroupAlertBehavior(Notification.GROUP_ALERT_SUMMARY);
        return b;
    }

    private Notification askNote(JSONObject a, String tag, boolean quiet) {
        String body = a.optString("body");
        String from = a.optString("from");
        Notification.Builder b = base(CH_ASK, tag, quiet)
                .setContentTitle(a.optString("title"))
                .setContentText(body.isEmpty() ? from : body)
                .setSubText(from)
                .setStyle(new Notification.BigTextStyle().bigText(body.isEmpty() ? from : body))
                .setCategory(Notification.CATEGORY_REMINDER);
        JSONArray opts = a.optJSONArray("options");
        for (int i = 0; opts != null && i < opts.length() && i < 3; i++) {
            JSONObject o = opts.optJSONObject(i);
            Intent act = ActionReceiver.intent(this, "ask", tag)
                    .putExtra("id", a.optString("id"))
                    .putExtra("option", o.optString("id"));
            b.addAction(new Notification.Action.Builder(null, o.optString("label"), pending(act, tag + "#" + i)).build());
        }
        return b.build();
    }

    private Notification inputNote(JSONObject p, String tag, boolean quiet) {
        String who = p.optString("kind") + " · " + p.optString("label");
        String q = p.optString("question", "Waiting for your answer");
        Notification.Builder b = base(CH_INPUT, tag, quiet)
                .setContentTitle(who + " needs you")
                .setContentText(q)
                .setSubText(p.optString("host"))
                .setStyle(new Notification.BigTextStyle().bigText(q))
                .setCategory(Notification.CATEGORY_REMINDER);
        JSONArray opts = p.optJSONArray("options");
        int n = opts == null ? 0 : Math.min(opts.length(), 3);
        for (int i = 0; i < n; i++) {
            JSONObject o = opts.optJSONObject(i);
            Intent act = ActionReceiver.intent(this, "answer", tag)
                    .putExtra("key", p.optString("key"))
                    .putExtra("n", o.optInt("n"));
            b.addAction(new Notification.Action.Builder(null, o.optInt("n") + ". " + o.optString("label"), pending(act, tag + "#" + i)).build());
        }
        if (n == 0) b.addAction(replyAction(p, tag));
        return b.build();
    }

    private Notification doneNote(JSONObject p, String tag, boolean quiet) {
        String who = p.optString("kind") + " · " + p.optString("label");
        String sum = p.optString("summary", p.optString("title", "Finished"));
        Intent seen = ActionReceiver.intent(this, "seen", tag).putExtra("key", p.optString("key"));
        return base(CH_DONE, tag, quiet)
                .setContentTitle(who + " finished")
                .setContentText(sum)
                .setSubText(p.optString("host"))
                .setStyle(new Notification.BigTextStyle().bigText(sum))
                .addAction(new Notification.Action.Builder(null, "Got it", pending(seen, tag + "#seen")).build())
                .addAction(replyAction(p, tag))
                .setDeleteIntent(pending(seen, tag + "#swipe")) // swiping it away counts as seen too
                .build();
    }

    private Notification.Action replyAction(JSONObject p, String tag) {
        Intent act = ActionReceiver.intent(this, "reply", tag).putExtra("key", p.optString("key"));
        PendingIntent pi = PendingIntent.getBroadcast(this, (tag + "#reply").hashCode(), act,
                PendingIntent.FLAG_MUTABLE | PendingIntent.FLAG_UPDATE_CURRENT); // RemoteInput fills it in
        RemoteInput in = new RemoteInput.Builder(ActionReceiver.REPLY).setLabel("Reply to " + p.optString("label")).build();
        return new Notification.Action.Builder(null, "Reply", pi).addRemoteInput(in).build();
    }

    private PendingIntent pending(Intent i, String code) {
        return PendingIntent.getBroadcast(this, code.hashCode(), i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification status(String text) {
        Intent open = new Intent(this, MainActivity.class);
        return new Notification.Builder(this, CH_STATUS)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("openone")
                .setContentText(text)
                .setGroup("status")
                .setOngoing(true)
                .setShowWhen(false)
                .setContentIntent(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE))
                .build();
    }

    private String lastStatus = "";

    private void setStatus(String text) {
        if (text.equals(lastStatus)) return;
        lastStatus = text;
        nm.notify(STATUS_ID, status(text));
    }
}
