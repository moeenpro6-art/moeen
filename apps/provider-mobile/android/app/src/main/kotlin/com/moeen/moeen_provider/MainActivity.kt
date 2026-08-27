package com.moeen.moeen_provider

import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import com.pravera.flutter_foreground_task.FlutterForegroundTaskLifecycleListener
import com.pravera.flutter_foreground_task.FlutterForegroundTaskPlugin
import com.pravera.flutter_foreground_task.FlutterForegroundTaskStarter
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine

class MainActivity : FlutterActivity(), FlutterForegroundTaskLifecycleListener {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        flutterEngine.plugins.add(ProviderTrackingServiceAuthorityPlugin())
    }

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
        FlutterForegroundTaskPlugin.addTaskLifecycleListener(this)
        super.onCreate(savedInstanceState)
    }

    override fun onDestroy() {
        FlutterForegroundTaskPlugin.removeTaskLifecycleListener(this)
        super.onDestroy()
    }

    override fun onEngineCreate(flutterEngine: FlutterEngine?) {
        logLifecycle("task.engine.create")
        if (flutterEngine != null) {
            flutterEngine.plugins.add(ProviderTrackingServiceAuthorityPlugin())
        }
    }

    override fun onTaskStart(starter: FlutterForegroundTaskStarter) {
        logLifecycle("task.start", "starter=${starter.name}")
    }

    override fun onTaskRepeatEvent() {}

    override fun onTaskDestroy() {
        logLifecycle("task.destroy")
        ProviderTrackingServiceAuthorityPlugin.onForegroundTaskDestroyed()
    }

    override fun onEngineWillDestroy() {
        logLifecycle("task.engine.destroy")
    }

    private fun logLifecycle(event: String, reason: String? = null) {
        val fields = mutableListOf(
            "tMonoNs=${SystemClock.elapsedRealtimeNanos()}",
            "event=$event",
        )
        reason?.let { fields.add("reason=$it") }
        Log.i("MoeenTrackingLifecycle", fields.joinToString(" "))
    }
}
