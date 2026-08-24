package com.moeen.moeen_provider

import android.os.Bundle
import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // flutter_foreground_task consults this persisted value before the
        // manifest's stopWithTask flag when Android removes the UI task. Clear
        // a value left by an earlier configuration before Flutter/plugin setup
        // can observe app visibility. This grants no tracking authority and
        // never starts a service; server-authorized Dart runtime paths still
        // own service start and every fail-closed stop.
        getSharedPreferences(
            "com.pravera.flutter_foreground_task.prefs.FOREGROUND_TASK_OPTIONS",
            MODE_PRIVATE,
        ).edit().putBoolean("stopWithTask", false).commit()
        super.onCreate(savedInstanceState)
    }
}
