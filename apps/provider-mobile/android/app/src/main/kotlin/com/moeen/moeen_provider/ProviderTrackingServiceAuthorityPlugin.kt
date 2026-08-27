package com.moeen.moeen_provider

import android.content.Context
import android.os.SystemClock
import android.util.Log
import com.pravera.flutter_foreground_task.service.ForegroundService
import com.pravera.flutter_foreground_task.service.ForegroundServiceManager
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

internal enum class ProviderTrackingStopDecision(val wireValue: String) {
    REQUESTED("requested"),
    ALREADY_STOPPED("alreadyStopped"),
    STALE("stale"),
}

/**
 * Pure process-memory state machine for Moeen's one provider location FGS.
 * Callers synchronize every operation and run [dispatchStop] inside that same
 * critical section so ownership validation and the global Android stop command
 * cannot be separated by a replacement generation claim.
 */
internal data class ProviderTrackingRuntimeOrder(
    val engineSequence: Long,
    val runtimeSequence: Long,
) : Comparable<ProviderTrackingRuntimeOrder> {
    override fun compareTo(other: ProviderTrackingRuntimeOrder): Int {
        val engineComparison = engineSequence.compareTo(other.engineSequence)
        return if (engineComparison != 0) {
            engineComparison
        } else {
            runtimeSequence.compareTo(other.runtimeSequence)
        }
    }
}

internal class ProviderTrackingServiceAuthorityState {
    private var latestRuntimeEpoch = 0
    private var latestRuntimeId: String? = null
    private var latestRuntimeOrder = ProviderTrackingRuntimeOrder(-1L, -1L)
    private var currentGeneration: String? = null
    private var pendingStopId: String? = null
    private var lastObservedServiceRunning = false
    private val stoppedGenerations = linkedSetOf<String>()
    private val completedZeroAuthorityStops = linkedSetOf<String>()

    fun beginRuntime(
        runtimeId: String,
        engineSequence: Long = latestRuntimeOrder.engineSequence + 1,
        runtimeSequence: Long = 0,
    ): Int {
        val order = ProviderTrackingRuntimeOrder(engineSequence, runtimeSequence)
        if (order < latestRuntimeOrder) return -1
        if (order == latestRuntimeOrder && runtimeId != latestRuntimeId) return -1
        if (runtimeId == latestRuntimeId && order == latestRuntimeOrder) {
            return latestRuntimeEpoch
        }
        latestRuntimeEpoch += 1
        latestRuntimeId = runtimeId
        latestRuntimeOrder = order
        return latestRuntimeEpoch
    }

    fun claimGeneration(
        runtimeId: String,
        runtimeEpoch: Int,
        generation: String,
        serviceRunning: Boolean,
    ): Boolean {
        observeServiceState(serviceRunning)
        if (runtimeId != latestRuntimeId || runtimeEpoch != latestRuntimeEpoch) return false
        if (pendingStopId != null && serviceRunning) return false
        currentGeneration = generation
        pendingStopId = null
        return true
    }

    fun ownsGeneration(generation: String): Boolean = currentGeneration == generation

    fun releaseGeneration(generation: String) {
        if (currentGeneration == generation) currentGeneration = null
    }

    fun stopGeneration(
        generation: String,
        serviceRunning: Boolean,
        dispatchStop: () -> Unit,
    ): ProviderTrackingStopDecision {
        observeServiceState(serviceRunning)
        return when {
            currentGeneration != generation -> {
                if (stoppedGenerations.contains(generation)) {
                    ProviderTrackingStopDecision.ALREADY_STOPPED
                } else {
                    ProviderTrackingStopDecision.STALE
                }
            }
            pendingStopId != null -> ProviderTrackingStopDecision.ALREADY_STOPPED
            !serviceRunning -> {
                currentGeneration = null
                remember(stoppedGenerations, generation)
                ProviderTrackingStopDecision.ALREADY_STOPPED
            }
            else -> {
                currentGeneration = null
                pendingStopId = "generation:$generation"
                remember(stoppedGenerations, generation)
                dispatchStop()
                ProviderTrackingStopDecision.REQUESTED
            }
        }
    }

    fun stopForZeroAuthority(
        runtimeId: String,
        runtimeEpoch: Int,
        stopRequestId: String,
        serviceRunning: Boolean,
        dispatchStop: () -> Unit,
    ): ProviderTrackingStopDecision {
        observeServiceState(serviceRunning)
        return when {
            runtimeId != latestRuntimeId || runtimeEpoch != latestRuntimeEpoch -> {
                ProviderTrackingStopDecision.STALE
            }
            completedZeroAuthorityStops.contains(stopRequestId) -> {
                ProviderTrackingStopDecision.ALREADY_STOPPED
            }
            pendingStopId != null -> ProviderTrackingStopDecision.ALREADY_STOPPED
            !serviceRunning -> {
                currentGeneration = null
                remember(completedZeroAuthorityStops, stopRequestId)
                ProviderTrackingStopDecision.ALREADY_STOPPED
            }
            else -> {
                currentGeneration = null
                pendingStopId = "zero:$stopRequestId"
                remember(completedZeroAuthorityStops, stopRequestId)
                dispatchStop()
                ProviderTrackingStopDecision.REQUESTED
            }
        }
    }

    fun onForegroundTaskDestroyed(serviceRunning: Boolean) {
        observeServiceState(serviceRunning)
        // onTaskDestroy runs before flutter_foreground_task flips its global
        // running state to false. A delayed destroy from an older worker must
        // not clear a stop pending for a live replacement generation.
        if (!serviceRunning) pendingStopId = null
    }

    private fun observeServiceState(serviceRunning: Boolean) {
        if (serviceRunning && !lastObservedServiceRunning) {
            stoppedGenerations.clear()
            completedZeroAuthorityStops.clear()
        }
        lastObservedServiceRunning = serviceRunning
    }

    private fun remember(set: LinkedHashSet<String>, value: String) {
        set.add(value)
        while (set.size > 32) set.remove(set.first())
    }
}

/**
 * Process-memory ownership gate for Moeen's one provider location foreground
 * service. Both the UI and foreground-worker Flutter engines attach here, so a
 * stale engine cannot invoke the plugin's global stop path after a newer runtime
 * or worker generation has taken ownership.
 */
class ProviderTrackingServiceAuthorityPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
    companion object {
        private const val CHANNEL =
            "com.moeen.moeen_provider/provider_tracking_service_authority"

        private val lock = Any()
        private val authorityState = ProviderTrackingServiceAuthorityState()
        private var nextEngineSequence = 0L

        private fun allocateEngineSequence(): Long = synchronized(lock) {
            nextEngineSequence++
        }

        fun onForegroundTaskDestroyed() {
            val serviceRunning = ForegroundService.isRunningServiceState.value
            logLifecycle(
                event = "native.task.destroy.observed",
                reason = "serviceRunning=$serviceRunning",
            )
            synchronized(lock) {
                authorityState.onForegroundTaskDestroyed(serviceRunning)
            }
        }

        private fun logLifecycle(
            event: String,
            runtimeId: String? = null,
            generation: String? = null,
            reason: String? = null,
        ) {
            val fields = mutableListOf(
                "tMonoNs=${SystemClock.elapsedRealtimeNanos()}",
                "event=$event",
            )
            runtimeId?.let { fields.add("runtime=$it") }
            generation?.let { fields.add("generation=$it") }
            reason?.let { fields.add("reason=$it") }
            Log.i("MoeenTrackingLifecycle", fields.joinToString(" "))
        }
    }

    private lateinit var applicationContext: Context
    private lateinit var channel: MethodChannel
    private var engineSequence = -1L

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        applicationContext = binding.applicationContext
        engineSequence = allocateEngineSequence()
        channel = MethodChannel(binding.binaryMessenger, CHANNEL)
        channel.setMethodCallHandler(this)
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel.setMethodCallHandler(null)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "beginRuntime" -> beginRuntime(call, result)
            "claimGeneration" -> claimGeneration(call, result)
            "ownsGeneration" -> ownsGeneration(call, result)
            "releaseGeneration" -> releaseGeneration(call, result)
            "stopGeneration" -> stopGeneration(call, result)
            "stopForZeroAuthority" -> stopForZeroAuthority(call, result)
            else -> result.notImplemented()
        }
    }

    private fun beginRuntime(call: MethodCall, result: MethodChannel.Result) {
        val runtimeId = call.stringArgument("runtimeId") ?: return invalid(result)
        val runtimeSequence = call.longArgument("runtimeSequence") ?: return invalid(result)
        val epoch = synchronized(lock) {
            authorityState.beginRuntime(
                runtimeId = runtimeId,
                engineSequence = engineSequence,
                runtimeSequence = runtimeSequence,
            )
        }
        logLifecycle(
            event = "authority.beginRuntime.decision",
            runtimeId = runtimeId,
            reason = "engineSequence=$engineSequence runtimeSequence=$runtimeSequence epoch=$epoch",
        )
        result.success(epoch)
    }

    private fun claimGeneration(call: MethodCall, result: MethodChannel.Result) {
        val runtimeId = call.stringArgument("runtimeId") ?: return invalid(result)
        val runtimeEpoch = call.longArgument("runtimeEpoch") ?: return invalid(result)
        val generation = call.stringArgument("generation") ?: return invalid(result)
        val serviceRunning = ForegroundService.isRunningServiceState.value
        val claimed = synchronized(lock) {
            authorityState.claimGeneration(
                runtimeId = runtimeId,
                runtimeEpoch = runtimeEpoch.toInt(),
                generation = generation,
                serviceRunning = serviceRunning,
            )
        }
        logLifecycle(
            event = "authority.claimGeneration.decision",
            runtimeId = runtimeId,
            generation = generation,
            reason = "epoch=$runtimeEpoch serviceRunning=$serviceRunning claimed=$claimed",
        )
        result.success(claimed)
    }

    private fun ownsGeneration(call: MethodCall, result: MethodChannel.Result) {
        val generation = call.stringArgument("generation") ?: return invalid(result)
        val owns = synchronized(lock) { authorityState.ownsGeneration(generation) }
        logLifecycle(
            event = "authority.ownsGeneration.decision",
            generation = generation,
            reason = "owns=$owns",
        )
        result.success(owns)
    }

    private fun releaseGeneration(call: MethodCall, result: MethodChannel.Result) {
        val generation = call.stringArgument("generation") ?: return invalid(result)
        synchronized(lock) { authorityState.releaseGeneration(generation) }
        logLifecycle(event = "authority.releaseGeneration", generation = generation)
        result.success(null)
    }

    private fun stopGeneration(call: MethodCall, result: MethodChannel.Result) {
        val generation = call.stringArgument("generation") ?: return invalid(result)
        val decision = synchronized(lock) {
            authorityState.stopGeneration(
                generation = generation,
                serviceRunning = ForegroundService.isRunningServiceState.value,
            ) {
                requestGlobalStop(generation = generation, reason = "generation_stop")
            }
        }
        logLifecycle(
            event = "authority.stopGeneration.decision",
            generation = generation,
            reason = decision.wireValue,
        )
        result.success(decision.wireValue)
    }

    private fun stopForZeroAuthority(call: MethodCall, result: MethodChannel.Result) {
        val runtimeId = call.stringArgument("runtimeId") ?: return invalid(result)
        val runtimeEpoch = call.longArgument("runtimeEpoch") ?: return invalid(result)
        val stopRequestId = call.stringArgument("stopRequestId") ?: return invalid(result)
        val decision = synchronized(lock) {
            authorityState.stopForZeroAuthority(
                runtimeId = runtimeId,
                runtimeEpoch = runtimeEpoch.toInt(),
                stopRequestId = stopRequestId,
                serviceRunning = ForegroundService.isRunningServiceState.value,
            ) {
                requestGlobalStop(runtimeId = runtimeId, reason = "zero_authority")
            }
        }
        logLifecycle(
            event = "authority.stopForZeroAuthority.decision",
            runtimeId = runtimeId,
            reason = decision.wireValue,
        )
        result.success(decision.wireValue)
    }

    private fun requestGlobalStop(
        runtimeId: String? = null,
        generation: String? = null,
        reason: String,
    ) {
        // Keep the dependency's normal global stop contract, but dispatch it
        // inside the same synchronized ownership transaction that authorized
        // this exact caller. This avoids a check-then-act gap in which a fresh
        // replacement generation could claim the service before stop dispatch.
        logLifecycle(
            event = "native.globalStop.dispatch",
            runtimeId = runtimeId,
            generation = generation,
            reason = reason,
        )
        ForegroundServiceManager().stop(applicationContext)
    }


    private fun MethodCall.stringArgument(name: String): String? =
        argument<String>(name)?.takeIf { it.isNotEmpty() }

    private fun MethodCall.longArgument(name: String): Long? =
        (argument<Number>(name))?.toLong()

    private fun invalid(result: MethodChannel.Result) {
        result.error("invalid_arguments", "Invalid provider tracking ownership request.", null)
    }
}
