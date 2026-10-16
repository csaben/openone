package io.github.csaben.openone;

import android.content.Context;
import android.content.SharedPreferences;

/** The openone server's address, set on first launch. */
final class Prefs {
    private Prefs() {}

    private static SharedPreferences p(Context c) {
        return c.getSharedPreferences("openone", Context.MODE_PRIVATE);
    }

    static String url(Context c) {
        return p(c).getString("url", "");
    }

    static void setUrl(Context c, String url) {
        p(c).edit().putString("url", url.replaceAll("/+$", "")).apply();
    }

    static boolean flag(Context c, String name) {
        return p(c).getBoolean(name, false);
    }

    static void setFlag(Context c, String name) {
        p(c).edit().putBoolean(name, true).apply();
    }
}
