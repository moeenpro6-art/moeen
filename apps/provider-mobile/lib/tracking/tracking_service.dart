import 'package:flutter/foundation.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:moeen_provider/provider_tracking.dart';

import 'tracking_models.dart';

/// Fetches the server-authoritative state for one provider-owned request.
///
/// The returned `tracking.active` field is the only authorization source for
/// future device-location acquisition. A request status alone is never enough.
typedef TrackingStatusLoader =
    Future<ProviderTrackingStatusResponseDto> Function(String requestId);

/// Small boundary around the foreground-task plugin for a later tracking phase.
///
/// Phase 4.1 never starts this service: it has no GPS acquisition yet. The
/// controller exists so [stopTracking] can safely stop an already-running
/// foreground service during lifecycle hand-off or future phase upgrades.
abstract interface class TrackingForegroundServiceController {
  Future<void> stop();
}

class FlutterTrackingForegroundServiceController
    implements TrackingForegroundServiceController {
  const FlutterTrackingForegroundServiceController();

  @override
  Future<void> stop() async {
    // A no-op stop is expected before a future phase ever starts the service.
    // Never surface plugin/service internals to the operational UI.
    providerTrackingLifecycleLog(
      'flutter.stopService.request',
      reason: 'legacy_tracking_service',
    );
    await FlutterForegroundTask.stopService();
    providerTrackingLifecycleLog(
      'flutter.stopService.return',
      reason: 'legacy_tracking_service',
    );
  }
}

/// Phase 4.1 tracking foundation.
///
/// `startTracking` performs one server-authority read and records no locations.
/// It deliberately does not call geolocator, subscribe to a position stream,
/// enqueue a [ProviderSample], persist a coordinate, or start a foreground
/// service. Future phases may add those behaviors only *after* the current
/// authority response has `tracking.active == true`.
class TrackingService {
  TrackingService({
    required TrackingStatusLoader loadStatus,
    TrackingForegroundServiceController? foregroundService,
    void Function(String message)? log,
  }) : _loadTrackingStatus = loadStatus,
       _foregroundService =
           foregroundService ??
           const FlutterTrackingForegroundServiceController(),
       _log = log ?? debugPrint;

  final TrackingStatusLoader _loadTrackingStatus;
  final TrackingForegroundServiceController _foregroundService;
  final void Function(String message) _log;

  TrackingState? _lastServerState;
  String? _activeRequestId;

  /// The most recent server state. It is not persisted and holds no coordinate.
  TrackingState? get lastServerState => _lastServerState;

  /// True only if the immediately observed server authority remains active.
  bool isTrackingActive() =>
      _lastServerState?.active == true &&
      _activeRequestId != null &&
      _lastServerState?.requestId == _activeRequestId;

  /// Reconciles authority before any future location acquisition can be added.
  ///
  /// Prior local authority is cleared before the request, so a failed, stale,
  /// or mismatched response is fail-closed. Returns false when the server says
  /// tracking is inactive. In either case no GPS platform API is reached. On
  /// success Phase 4.1 logs a non-sensitive status only.
  Future<bool> startTracking(String requestId) async {
    // Never let a previous response authorize a later acquisition attempt.
    // Stopping a foreground service remains the explicit [stopTracking] action.
    _activeRequestId = null;
    _lastServerState = null;

    final response = await _loadTrackingStatus(requestId);
    final state = response.tracking;
    if (state.requestId != requestId) {
      throw const FormatException('Tracking authority request mismatch');
    }

    _lastServerState = state;
    if (!state.active) return false;

    _activeRequestId = requestId;
    _log('Provider tracking authority confirmed for request $requestId.');
    return true;
  }

  /// Clears local authority and stops the foreground-service integration.
  ///
  /// No coordinate is read, sent, stored, or logged.
  Future<void> stopTracking() async {
    _activeRequestId = null;
    _lastServerState = null;
    await _foregroundService.stop();
  }
}
