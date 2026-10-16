package io.github.csaben.openone;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Reconnects after a reboot or an app update. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        if (!Prefs.url(c).isEmpty()) WatchService.start(c);
    }
}
