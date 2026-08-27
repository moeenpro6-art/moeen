package com.moeen.moeen_provider

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProviderTrackingServiceAuthorityStateTest {
    @Test
    fun delayedOldGenerationStopCannotDispatchAgainstReplacement() {
        val authority = ProviderTrackingServiceAuthorityState()
        val epoch = authority.beginRuntime("runtime-1")
        assertTrue(authority.claimGeneration("runtime-1", epoch, "generation-1", false))

        // Generation 1 began teardown in Dart, then fresh trusted recovery
        // claimed generation 2 before generation 1 reached this native gate.
        assertTrue(authority.claimGeneration("runtime-1", epoch, "generation-2", false))
        var globalStops = 0

        val decision = authority.stopGeneration("generation-1", true) {
            globalStops += 1
        }

        assertEquals(ProviderTrackingStopDecision.STALE, decision)
        assertEquals(0, globalStops)
        assertTrue(authority.ownsGeneration("generation-2"))
    }

    @Test
    fun currentGenerationStopDispatchesOnceAndDuplicateIsHarmless() {
        val authority = ProviderTrackingServiceAuthorityState()
        val epoch = authority.beginRuntime("runtime-1")
        assertTrue(authority.claimGeneration("runtime-1", epoch, "generation-1", false))
        var globalStops = 0

        val first = authority.stopGeneration("generation-1", true) {
            globalStops += 1
        }
        val duplicate = authority.stopGeneration("generation-1", true) {
            globalStops += 1
        }

        assertEquals(ProviderTrackingStopDecision.REQUESTED, first)
        assertEquals(ProviderTrackingStopDecision.ALREADY_STOPPED, duplicate)
        assertEquals(1, globalStops)
    }

    @Test
    fun freshRuntimeCanStopInheritedServiceWithZeroAuthority() {
        val authority = ProviderTrackingServiceAuthorityState()
        val epoch = authority.beginRuntime("runtime-1")
        var globalStops = 0

        val decision = authority.stopForZeroAuthority(
            runtimeId = "runtime-1",
            runtimeEpoch = epoch,
            stopRequestId = "zero-authority-1",
            serviceRunning = true,
        ) {
            globalStops += 1
        }

        assertEquals(ProviderTrackingStopDecision.REQUESTED, decision)
        assertEquals(1, globalStops)
    }

    @Test
    fun staleRuntimeCannotUseZeroAuthorityStopAgainstReplacement() {
        val authority = ProviderTrackingServiceAuthorityState()
        val oldEpoch = authority.beginRuntime("runtime-1")
        assertTrue(authority.claimGeneration("runtime-1", oldEpoch, "generation-1", false))
        val replacementEpoch = authority.beginRuntime("runtime-2")
        assertTrue(
            authority.claimGeneration(
                "runtime-2",
                replacementEpoch,
                "generation-2",
                true,
            ),
        )
        var globalStops = 0

        val decision = authority.stopForZeroAuthority(
            runtimeId = "runtime-1",
            runtimeEpoch = oldEpoch,
            stopRequestId = "old-zero-authority-stop",
            serviceRunning = true,
        ) {
            globalStops += 1
        }

        assertEquals(ProviderTrackingStopDecision.STALE, decision)
        assertEquals(0, globalStops)
        assertTrue(authority.ownsGeneration("generation-2"))
    }

    @Test
    fun olderRuntimeCannotRegisterLateAndStopNewerReplacement() {
        val authority = ProviderTrackingServiceAuthorityState()
        val replacementEpoch = authority.beginRuntime(
            runtimeId = "runtime-2",
            engineSequence = 1,
            runtimeSequence = 2,
        )
        assertTrue(
            authority.claimGeneration(
                "runtime-2",
                replacementEpoch,
                "generation-2",
                true,
            ),
        )
        var globalStops = 0

        val staleEpoch = authority.beginRuntime(
            runtimeId = "runtime-1",
            engineSequence = 1,
            runtimeSequence = 1,
        )
        val decision = authority.stopForZeroAuthority(
            runtimeId = "runtime-1",
            runtimeEpoch = staleEpoch,
            stopRequestId = "old-zero-authority-stop",
            serviceRunning = true,
        ) {
            globalStops += 1
        }

        assertEquals(-1, staleEpoch)
        assertEquals(ProviderTrackingStopDecision.STALE, decision)
        assertEquals(0, globalStops)
        assertTrue(authority.ownsGeneration("generation-2"))
    }

    @Test
    fun olderEngineCannotRegisterLateAndStopNewerReplacement() {
        val authority = ProviderTrackingServiceAuthorityState()
        val replacementEpoch = authority.beginRuntime(
            runtimeId = "runtime-2",
            engineSequence = 2,
            runtimeSequence = 0,
        )
        assertTrue(
            authority.claimGeneration(
                "runtime-2",
                replacementEpoch,
                "generation-2",
                true,
            ),
        )
        var globalStops = 0

        val staleEpoch = authority.beginRuntime(
            runtimeId = "runtime-1",
            engineSequence = 1,
            runtimeSequence = 50,
        )
        val decision = authority.stopForZeroAuthority(
            runtimeId = "runtime-1",
            runtimeEpoch = staleEpoch,
            stopRequestId = "old-engine-zero-authority-stop",
            serviceRunning = true,
        ) {
            globalStops += 1
        }

        assertEquals(-1, staleEpoch)
        assertEquals(ProviderTrackingStopDecision.STALE, decision)
        assertEquals(0, globalStops)
        assertTrue(authority.ownsGeneration("generation-2"))
    }

    @Test
    fun queuedStopBlocksReplacementUntilOldServiceIsDestroyed() {
        val authority = ProviderTrackingServiceAuthorityState()
        val epoch = authority.beginRuntime("runtime-1")
        assertTrue(authority.claimGeneration("runtime-1", epoch, "generation-1", false))
        assertEquals(
            ProviderTrackingStopDecision.REQUESTED,
            authority.stopGeneration("generation-1", true) {},
        )

        assertFalse(authority.claimGeneration("runtime-1", epoch, "generation-2", true))

        authority.onForegroundTaskDestroyed(serviceRunning = false)
        assertTrue(authority.claimGeneration("runtime-1", epoch, "generation-2", false))
    }

    @Test
    fun delayedOldDestroyCannotClearAReplacementPendingStop() {
        val authority = ProviderTrackingServiceAuthorityState()
        val epoch = authority.beginRuntime("runtime-1")
        assertTrue(authority.claimGeneration("runtime-1", epoch, "generation-2", false))
        assertEquals(
            ProviderTrackingStopDecision.REQUESTED,
            authority.stopGeneration("generation-2", true) {},
        )

        authority.onForegroundTaskDestroyed(serviceRunning = true)

        assertFalse(authority.claimGeneration("runtime-1", epoch, "generation-3", true))
    }
}