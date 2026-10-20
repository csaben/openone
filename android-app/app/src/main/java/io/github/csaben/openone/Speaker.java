package io.github.csaben.openone;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.PlaybackParams;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Agents talking back, in your ear when you're out. While headphones are connected (Bluetooth
 * or wired, never the phone's speaker) this asks the server for speech the way the desktop
 * does; the server sends it here once no computer has seen you for a few minutes. Each part
 * plays on the headphones themselves (setPreferredDevice), ducking whatever else is playing.
 * When the headphones go away it tells the server once, so the desktop gets speech again.
 */
final class Speaker {
    private static final float SPEED = 1.75f; // like the desktop's default voice speed

    private final Context ctx;
    private final AudioManager am;
    private volatile Thread loop;
    private volatile boolean stopped;

    Speaker(Context c) {
        ctx = c.getApplicationContext();
        am = ctx.getSystemService(AudioManager.class);
    }

    void start() {
        am.registerAudioDeviceCallback(new AudioDeviceCallback() {
            @Override
            public void onAudioDevicesAdded(AudioDeviceInfo[] added) { check(); }

            @Override
            public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) { check(); }
        }, new Handler(Looper.getMainLooper()));
        check();
    }

    void stop() {
        stopped = true;
        Thread t = loop;
        if (t != null) t.interrupt();
    }

    /** Headphones, or null: Bluetooth media, LE audio headsets, wired and USB headsets. */
    AudioDeviceInfo headset() {
        for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            int t = d.getType();
            if (t == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP || t == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
                    || t == AudioDeviceInfo.TYPE_WIRED_HEADSET || t == AudioDeviceInfo.TYPE_USB_HEADSET
                    || (Build.VERSION.SDK_INT >= 31 && t == AudioDeviceInfo.TYPE_BLE_HEADSET)) return d;
        }
        return null;
    }

    private synchronized void check() {
        if (stopped) return;
        if (headset() != null) {
            if (loop == null || !loop.isAlive()) {
                loop = new Thread(this::run, "openone-speak");
                loop.start();
            }
        } else if (loop != null) {
            Thread t = loop;
            loop = null;
            t.interrupt();
            // tell the server right away, so it sends speech to the desktop again
            new Thread(() -> {
                try { Api.getText(ctx, "/api/speak?for=phone&kind=phone&headset=0"); } catch (Exception ignored) {}
            }, "openone-speak-bye").start();
        }
    }

    private void run() {
        long backoff = 2000;
        while (!stopped && loop == Thread.currentThread() && headset() != null) {
            try {
                HttpURLConnection c = Api.open(ctx, "/api/speak?for=phone&kind=phone&headset=1&wait=25");
                c.setReadTimeout(40000);
                int code = c.getResponseCode();
                if (code != 200) throw new Exception("HTTP " + code);
                JSONArray parts = new JSONArray(Api.slurp(c.getInputStream()));
                c.disconnect();
                backoff = 2000;
                for (int i = 0; i < parts.length(); i++) {
                    JSONObject p = parts.getJSONObject(i);
                    String id = p.getString("id");
                    try {
                        play(id);
                    } finally {
                        try { Api.delete(ctx, "/api/speak/" + Uri.encode(id)); } catch (Exception ignored) {}
                    }
                }
            } catch (Exception e) {
                if (e instanceof InterruptedException) return;
                try { Thread.sleep(backoff); } catch (InterruptedException ie) { return; }
                backoff = Math.min(backoff * 2, 30000);
            }
        }
    }

    /** Download one part and play it on the headphones; skipped if they've gone. */
    private void play(String id) throws Exception {
        AudioDeviceInfo out = headset();
        if (out == null) return;
        File f = new File(ctx.getCacheDir(), "speak.audio");
        HttpURLConnection c = Api.open(ctx, "/api/speak/" + Uri.encode(id) + "/audio");
        c.setReadTimeout(20000);
        if (c.getResponseCode() != 200) { c.disconnect(); return; }
        try (InputStream in = c.getInputStream(); FileOutputStream o = new FileOutputStream(f)) {
            byte[] b = new byte[16384];
            for (int n; (n = in.read(b)) > 0; ) o.write(b, 0, n);
        } finally {
            c.disconnect();
        }
        out = headset();
        if (out == null) return;

        AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE) // ducks music, like directions
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build();
        AudioFocusRequest focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(attrs).build();
        CountDownLatch done = new CountDownLatch(1);
        MediaPlayer mp = new MediaPlayer();
        try {
            am.requestAudioFocus(focus);
            mp.setAudioAttributes(attrs);
            mp.setDataSource(f.getAbsolutePath());
            mp.setPreferredDevice(out); // the headphones, never the speaker
            mp.setOnCompletionListener(m -> done.countDown());
            mp.setOnErrorListener((m, what, extra) -> { done.countDown(); return true; });
            mp.prepare();
            mp.setPlaybackParams(new PlaybackParams().setSpeed(SPEED));
            mp.start();
            done.await(120, TimeUnit.SECONDS);
        } finally {
            mp.release();
            am.abandonAudioFocusRequest(focus);
            //noinspection ResultOfMethodCallIgnored
            f.delete();
        }
    }
}
