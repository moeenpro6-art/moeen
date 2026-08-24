import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:geolocator/geolocator.dart' as geolocator;
import 'package:http/http.dart' as http;

/// The server is the only authority for active collection. This value is never
/// derived from a local job status or persisted client-side state.
class ProviderTrackingStatus {
  const ProviderTrackingStatus({
    required this.requestId,
    required this.active,
    required this.status,
    required this.onTheWayCadenceMs,
    required this.inProgressCadenceMs,
  });

  final String requestId;
  final bool active;
  final String status;
  final int onTheWayCadenceMs;
  final int inProgressCadenceMs;

  int get cadenceMs => switch (status) {
    'on_the_way' => onTheWayCadenceMs,
    'in_progress' => inProgressCadenceMs,
    _ => throw const ProviderTrackingProtocolException(),
  };

  factory ProviderTrackingStatus.fromResponse(Map<String, dynamic> json) {
    final tracking = json['tracking'];
    if (tracking is! Map<dynamic, dynamic>) {
      throw const ProviderTrackingProtocolException();
    }
    return ProviderTrackingStatus.fromJson(Map<String, dynamic>.from(tracking));
  }

  factory ProviderTrackingStatus.fromJson(Map<String, dynamic> json) {
    final requestId = json['requestId'];
    final active = json['active'];
    final status = json['status'];
    final onTheWayCadenceMs = json['onTheWayCadenceMs'];
    final inProgressCadenceMs = json['inProgressCadenceMs'];
    if (requestId is! String ||
        requestId.isEmpty ||
        active is! bool ||
        status is! String ||
        !const {
          'assigned',
          'on_the_way',
          'in_progress',
          'completed',
          'cancelled',
        }.contains(status) ||
        (active && status != 'on_the_way' && status != 'in_progress') ||
        onTheWayCadenceMs is! num ||
        inProgressCadenceMs is! num) {
      throw const ProviderTrackingProtocolException();
    }
    final onTheWay = onTheWayCadenceMs.toInt();
    final inProgress = inProgressCadenceMs.toInt();
    if (onTheWayCadenceMs != onTheWay ||
        inProgressCadenceMs != inProgress ||
        onTheWay < 10000 ||
        inProgress < onTheWay) {
      throw const ProviderTrackingProtocolException();
    }
    return ProviderTrackingStatus(
      requestId: requestId,
      active: active,
      status: status,
      onTheWayCadenceMs: onTheWay,
      inProgressCadenceMs: inProgress,
    );
  }
}

/// Enforces the current server-provided sampling cadence even if the platform
/// stream produces faster or delayed position events. It never stores samples
/// and deliberately permits at most one event per cadence — missed intervals
/// are not replayed as catch-up submissions.
///
/// The gate is intentionally NOT reset when a worker stream is reconfigured or
/// paused for authority recovery: a restarted stream for the same request must
/// never emit a sample sooner than one cadence after the last collected one.
class ProviderTrackingCadenceGate {
  // Android's requested update interval is a best-effort target, not a strict
  // deadline. Without this bounded allowance, an event arriving a few
  // milliseconds before a 15-second boundary is rejected and the next platform
  // event can be almost 30 seconds after the last accepted sample.
  //
  // This affects only the earliest eligible outbound sample. It does not queue
  // coordinates, replay missed intervals, or establish local authority. The
  // server cadence remains the one outbound cadence, with at most one accepted
  // sample per cadence and a maximum one-second scheduler-jitter allowance.
  static const Duration _sourceSchedulerJitterAllowance = Duration(seconds: 1);

  DateTime? _lastCollectedAt;
  int? _lastCadenceMs;
  String? _requestId;

  bool shouldCollect(ProviderTrackingStatus status, DateTime capturedAt) {
    if (!status.active) return false;
    final normalizedCapturedAt = capturedAt.toUtc();
    if (_requestId != status.requestId) {
      _requestId = status.requestId;
      _lastCollectedAt = normalizedCapturedAt;
      _lastCadenceMs = status.cadenceMs;
      return true;
    }

    final lastCollectedAt = _lastCollectedAt;
    // A cadence/status change is authority-driven and stays strictly aligned to
    // its new server cadence. The allowance is only for scheduler jitter while
    // an unchanged stream continues at the same cadence.
    final jitterAllowance = _lastCadenceMs == status.cadenceMs
        ? _sourceSchedulerJitterAllowance
        : Duration.zero;
    final earliestEligibleAt = lastCollectedAt
        ?.add(Duration(milliseconds: status.cadenceMs))
        .subtract(jitterAllowance);
    if (lastCollectedAt == null ||
        normalizedCapturedAt.isBefore(lastCollectedAt) ||
        (earliestEligibleAt != null &&
            normalizedCapturedAt.isBefore(earliestEligibleAt))) {
      return false;
    }

    _lastCollectedAt = normalizedCapturedAt;
    _lastCadenceMs = status.cadenceMs;
    return true;
  }

  /// Seeds a replacement worker from a timestamp held only by its still-live
  /// app runtime. This is monotonic, so an older value can never move the gate
  /// backward and permit a sub-cadence submission.
  void seed(ProviderTrackingStatus status, DateTime collectedAt) {
    final normalizedCollectedAt = collectedAt.toUtc();
    if (_requestId != status.requestId ||
        _lastCollectedAt == null ||
        normalizedCollectedAt.isAfter(_lastCollectedAt!)) {
      _requestId = status.requestId;
      _lastCollectedAt = normalizedCollectedAt;
      _lastCadenceMs = status.cadenceMs;
    }
  }

  void reset() {
    _lastCollectedAt = null;
    _lastCadenceMs = null;
    _requestId = null;
  }
}

class ProviderTrackingProtocolException implements Exception {
  const ProviderTrackingProtocolException();
}

class ProviderTrackingNotFoundException implements Exception {
  const ProviderTrackingNotFoundException();
}

class ProviderTrackingConflictException implements Exception {
  const ProviderTrackingConflictException();
}

class ProviderTrackingTransportException implements Exception {
  const ProviderTrackingTransportException();
}

class ProviderTrackingRuntimeException implements Exception {
  const ProviderTrackingRuntimeException();
}

class ProviderTrackingLocationPermissionException implements Exception {
  const ProviderTrackingLocationPermissionException();
}

abstract interface class ProviderTrackingApi {
  Future<ProviderTrackingStatus> getTrackingStatus(
    String token,
    String requestId,
  );
}

/// Permission boundary for the explicit provider action that starts a journey.
/// It may check/request the platform permission, but never acquires a position.
abstract interface class ProviderTrackingPermissionGate {
  Future<bool> ensurePermission();
}

class GeolocatorProviderTrackingPermissionGate
    implements ProviderTrackingPermissionGate {
  const GeolocatorProviderTrackingPermissionGate();

  @override
  Future<bool> ensurePermission() async {
    if (!await geolocator.Geolocator.isLocationServiceEnabled()) return false;
    var permission = await geolocator.Geolocator.checkPermission();
    if (permission == geolocator.LocationPermission.denied) {
      permission = await geolocator.Geolocator.requestPermission();
    }
    return permission == geolocator.LocationPermission.always ||
        permission == geolocator.LocationPermission.whileInUse;
  }
}

abstract interface class ProviderTrackingRuntime {
  /// Starts device location acquisition only after a current active server
  /// response has been supplied to this method. Starting with an identical
  /// authority that is already running is an idempotent no-op.
  Future<void> start(ProviderTrackingStatus status, String token);

  /// Reconfigures a live service from a fresh authority response. The
  /// foreground service stays running while its cadence changes.
  Future<void> update(ProviderTrackingStatus status, String token);

  /// Stops the foreground task and all collection work.
  Future<void> stop();

  /// Clears the process-memory-only sample queue. Implementations MUST NOT
  /// persist samples to disk.
  Future<void> clearQueue();

  Future<void> dispose();

  /// Whether this runtime currently owns a running collection service.
  Future<bool> isRunning();

  /// Whether the live collector is configured with exactly this authority
  /// (same request id, status, and cadence). False while nothing is running.
  bool matches(ProviderTrackingStatus status);
}

enum ProviderTrackingRecoveryResult {
  active,
  inactive,
  conflict,
  notFound,
  networkFailure,
}

/// Reconciles every assigned job before granting the local runtime permission
/// to acquire a single location. A successfully confirmed collector stays up;
/// any revoked or unverifiable authority is fail-closed rather than an offline
/// continuation.
typedef ProviderTrackingWait = Future<void> Function(Duration delay);

/// Reconciles server authority after login, refresh, and recovery events.
///
/// Reconciliation is idempotent: an unchanged active authority (same request
/// id, status, and cadence) leaves the running foreground service and its
/// location stream untouched. A changed active authority reconfigures the
/// single existing collector; it never creates a second one. Every revoked or
/// unverifiable authority — more than one active request, none active, a
/// missing/404 authority, a protocol failure, or exhausted transport retries —
/// is fail-closed: the runtime is stopped and its queue cleared before the
/// result is reported. The server GET always happens before any runtime
/// decision, so cold recovery can never start GPS on cached local state.
class ProviderTrackingRecoveryCoordinator {
  ProviderTrackingRecoveryCoordinator({
    required this.api,
    required this.runtime,
    List<Duration> retryDelays = const [
      Duration(seconds: 1),
      Duration(seconds: 2),
      Duration(seconds: 5),
    ],
    ProviderTrackingWait? wait,
  }) : _retryDelays = List<Duration>.unmodifiable(retryDelays),
       _wait = wait ?? Future<void>.delayed;

  final ProviderTrackingApi api;
  final ProviderTrackingRuntime runtime;
  final List<Duration> _retryDelays;
  final ProviderTrackingWait _wait;

  Future<void> stopAndClear() async {
    await runtime.stop();
    await runtime.clearQueue();
  }

  Future<void> _reconciliationTail = Future<void>.value();

  /// Serializes dashboard/recovery reconciliation so overlapping refreshes
  /// cannot both observe a cold runtime and start separate collectors.
  Future<ProviderTrackingRecoveryResult> reconcile({
    required String token,
    required Iterable<String> requestIds,
  }) async {
    final previous = _reconciliationTail;
    final completion = Completer<void>();
    _reconciliationTail = completion.future;
    await previous;
    try {
      return await _reconcile(token: token, requestIds: requestIds);
    } finally {
      completion.complete();
    }
  }

  Future<ProviderTrackingRecoveryResult> _reconcile({
    required String token,
    required Iterable<String> requestIds,
  }) async {
    final uniqueIds = requestIds.toSet().toList(growable: false);
    if (uniqueIds.isEmpty) {
      // No candidate request can authorize device location acquisition.
      await stopAndClear();
      return ProviderTrackingRecoveryResult.inactive;
    }

    // Read current server authority first. The already-running collector is
    // deliberately left untouched while the read is in flight, so a refresh
    // that confirms the same authority is a true no-op for the runtime.
    List<ProviderTrackingStatus>? statuses;
    var missingAuthority = false;
    var stoppedForAmbiguousAuthority = false;
    for (var attempt = 0; attempt <= _retryDelays.length; attempt += 1) {
      try {
        // Do not begin or alter collection until every current job authority
        // has returned, including explicitly inactive requests.
        final read = await _readStatuses(token, uniqueIds);
        statuses = read.statuses;
        missingAuthority = read.missingAuthority;
        break;
      } on ProviderTrackingTransportException {
        // A transport failure leaves authority unresolved. Stop before waiting
        // or retrying so no location is collected on stale server authority.
        if (!stoppedForAmbiguousAuthority) {
          await stopAndClear();
          stoppedForAmbiguousAuthority = true;
        }
        if (attempt == _retryDelays.length) {
          return ProviderTrackingRecoveryResult.networkFailure;
        }
        await _wait(_retryDelays[attempt]);
      } on ProviderTrackingConflictException {
        await stopAndClear();
        return ProviderTrackingRecoveryResult.inactive;
      } on ProviderTrackingProtocolException {
        await stopAndClear();
        return ProviderTrackingRecoveryResult.inactive;
      }
    }

    if (statuses == null) {
      await stopAndClear();
      return ProviderTrackingRecoveryResult.inactive;
    }
    if (missingAuthority) {
      // The request may have become terminal or been reassigned between the
      // dashboard read and the authority read. It cannot grant collection.
      await stopAndClear();
      return ProviderTrackingRecoveryResult.notFound;
    }
    final active = statuses.where((status) => status.active).toList();

    if (active.length > 1) {
      await stopAndClear();
      return ProviderTrackingRecoveryResult.conflict;
    }
    if (active.isEmpty) {
      await stopAndClear();
      return ProviderTrackingRecoveryResult.inactive;
    }
    final authority = active.single;

    if (await runtime.isRunning()) {
      if (runtime.matches(authority)) {
        // Idempotent no-op: same active request with the same cadence. The
        // running foreground service and its location stream are neither
        // stopped nor rebuilt.
        return ProviderTrackingRecoveryResult.active;
      }
      try {
        // Changed cadence/status: reconfigure the single existing collector in
        // place; never tear the foreground service down and never create a
        // second location stream.
        await runtime.update(authority, token);
      } on ProviderTrackingRuntimeException {
        // A failed in-place update leaves collector ownership ambiguous. Stop
        // rather than attempting a second start; the next fresh authority read
        // may safely start one collector from a known stopped state.
        await stopAndClear();
        rethrow;
      }
      return ProviderTrackingRecoveryResult.active;
    }

    // Cold recovery: start device acquisition only after this fresh
    // authenticated GET above returned an active authority.
    await runtime.start(authority, token);
    return ProviderTrackingRecoveryResult.active;
  }

  Future<_AuthorityRead> _readStatuses(
    String token,
    List<String> requestIds,
  ) async {
    final statuses = <ProviderTrackingStatus>[];
    var missingAuthority = false;
    for (final requestId in requestIds) {
      try {
        final status = await api.getTrackingStatus(token, requestId);
        if (status.requestId != requestId) {
          throw const ProviderTrackingProtocolException();
        }
        statuses.add(status);
      } on ProviderTrackingNotFoundException {
        // The request may have become terminal or been reassigned between the
        // dashboard read and the authority read. It cannot grant collection.
        missingAuthority = true;
      }
    }
    return _AuthorityRead(
      statuses: statuses,
      missingAuthority: missingAuthority,
    );
  }
}

class _AuthorityRead {
  const _AuthorityRead({
    required this.statuses,
    required this.missingAuthority,
  });

  final List<ProviderTrackingStatus> statuses;
  final bool missingAuthority;
}

class ProviderTrackingRuntimeEvent {
  const ProviderTrackingRuntimeEvent({
    required this.type,
    required this.requestId,
  });

  final String type;
  final String requestId;

  factory ProviderTrackingRuntimeEvent.fromMessage(Map<dynamic, dynamic> json) {
    final type = json['event'];
    final requestId = json['requestId'];
    if (type is! String || requestId is! String || requestId.isEmpty) {
      throw const ProviderTrackingProtocolException();
    }
    return ProviderTrackingRuntimeEvent(type: type, requestId: requestId);
  }
}

/// Initializes the Android foreground-service integration without asking for
/// GPS, notification, battery, or alarm permissions. The service itself is
/// started only by [FlutterProviderTrackingRuntime.start] after authority.
void initializeProviderTrackingForegroundTask() {
  FlutterForegroundTask.initCommunicationPort();
  FlutterForegroundTask.init(
    androidNotificationOptions: AndroidNotificationOptions(
      channelId: 'moeen_provider_tracking',
      channelName: 'تتبع مهام معين',
      channelDescription: 'يظهر هذا الإشعار أثناء تتبع المهمة النشطة فقط.',
      onlyAlertOnce: true,
    ),
    iosNotificationOptions: const IOSNotificationOptions(
      showNotification: false,
      playSound: false,
    ),
    foregroundTaskOptions: _foregroundTaskOptions(15000),
  );
}

bool _isAndroidPlatform() => Platform.isAndroid;

ForegroundTaskOptions _foregroundTaskOptions(int cadenceMs) {
  return ForegroundTaskOptions(
    eventAction: ForegroundTaskEventAction.repeat(cadenceMs),
    // Recovery must be driven by a fresh authenticated app launch and GET.
    autoRunOnBoot: false,
    autoRunOnMyPackageReplaced: false,
    allowAutoRestart: false,
    // Removing the UI task is not an authority transition. Keep an authorized
    // location FGS alive until a terminal server result, logout, reassignment,
    // or permission loss explicitly tears it down.
    stopWithTask: false,
    allowWakeLock: true,
    allowWifiLock: false,
  );
}

/// Android foreground-service runtime. It keeps only an in-memory worker
/// configuration and in-memory sample queue; it uses no plugin persistence API.
class FlutterProviderTrackingRuntime implements ProviderTrackingRuntime {
  FlutterProviderTrackingRuntime({
    required String baseUrl,
    required this._onEvent,
    bool Function()? shouldProbePlatformService,
  }) : _baseUrl = baseUrl.replaceFirst(RegExp(r'/$'), ''),
       _shouldProbePlatformService =
           shouldProbePlatformService ?? _isAndroidPlatform {
    FlutterForegroundTask.addTaskDataCallback(_onTaskData);
  }

  final String _baseUrl;
  final void Function(ProviderTrackingRuntimeEvent event) _onEvent;
  final bool Function() _shouldProbePlatformService;
  bool _serviceStartedByThisRuntime = false;
  ProviderTrackingStatus? _configuredStatus;
  // Process-memory-only marker for a replacement worker. No coordinates are
  // retained, written to storage, or sent to the UI isolate. The request id
  // prevents a prior request's cadence state being applied after reassignment.
  DateTime? _lastCollectedAt;
  String? _lastCollectedRequestId;
  bool _disposed = false;

  @override
  Future<void> start(ProviderTrackingStatus status, String token) async {
    if (!status.active) {
      throw const ProviderTrackingLocationPermissionException();
    }
    if (!await _hasLocationPermissionAndEnabledService()) {
      // Permission loss revokes local acquisition even when this UI isolate was
      // recreated and only inherited the platform foreground service.
      try {
        if (_shouldProbePlatformService() &&
            await FlutterForegroundTask.isRunningService) {
          await _stopPlatformServiceAndVerifyStopped();
        }
      } on ProviderTrackingRuntimeException {
        rethrow;
      } catch (_) {
        throw const ProviderTrackingRuntimeException();
      }
      throw const ProviderTrackingLocationPermissionException();
    }
    if (_serviceStartedByThisRuntime && matches(status) && await isRunning()) {
      // Idempotent: an identical authorization keeps the running service and
      // its location stream untouched.
      return;
    }

    try {
      // Never carry a cadence timestamp across a server-authorized request
      // change; collection state is scoped to the request that produced it.
      if (_lastCollectedRequestId != null &&
          _lastCollectedRequestId != status.requestId) {
        _lastCollectedAt = null;
        _lastCollectedRequestId = null;
      }
      if (_serviceStartedByThisRuntime && !await isRunning()) {
        // The worker ended outside this isolate. Its configuration is no longer
        // live, so this fresh authority may create one replacement worker.
        _serviceStartedByThisRuntime = false;
        _configuredStatus = null;
      }
      if (_serviceStartedByThisRuntime) {
        // Owned but configured differently: fail-closed clean restart.
        await stop();
      } else if (await FlutterForegroundTask.isRunningService) {
        if (_shouldProbePlatformService()) {
          // The app UI isolate may be recreated while the authorized Android
          // FGS continues. A fresh trusted authority adopts that live service
          // and configures its existing worker instead of tearing the FGS down
          // and creating a second collector.
          //
          // The plugin gives a persisted stopWithTask preference precedence over
          // the manifest flag. Refresh it before adoption so an FGS inherited
          // from an earlier process/configuration cannot be stopped when the
          // Activity becomes invisible after Home is pressed.
          try {
            await _refreshForegroundServiceOptions(status);
          } on ProviderTrackingRuntimeException {
            // The inherited worker cannot be trusted if its persisted service
            // options could not be refreshed. Do not leave it collecting while
            // the runtime reports that adoption failed.
            await _stopPlatformServiceAndVerifyStopped();
            rethrow;
          }
          _serviceStartedByThisRuntime = true;
          _configuredStatus = status;
          _sendConfiguration(status, token);
          return;
        }
        // A non-Android test/platform service cannot be adopted as an Android
        // location FGS. Tear it down before creating the fresh worker.
        await _stopPlatformServiceAndVerifyStopped();
      }
      FlutterForegroundTask.init(
        androidNotificationOptions: AndroidNotificationOptions(
          channelId: 'moeen_provider_tracking',
          channelName: 'تتبع مهام معين',
          channelDescription: 'يظهر هذا الإشعار أثناء تتبع المهمة النشطة فقط.',
          onlyAlertOnce: true,
        ),
        iosNotificationOptions: const IOSNotificationOptions(
          showNotification: false,
          playSound: false,
        ),
        foregroundTaskOptions: _foregroundTaskOptions(status.cadenceMs),
      );
      final result = await FlutterForegroundTask.startService(
        serviceId: 4103,
        serviceTypes: const [ForegroundServiceTypes.location],
        notificationTitle: 'معين — تتبع الطلب نشط',
        notificationText: 'رقم الطلب: ${status.requestId}',
        callback: providerTrackingForegroundTaskStartCallback,
      );
      if (result is ServiceRequestFailure) {
        throw ProviderTrackingRuntimeException();
      }
      _serviceStartedByThisRuntime = true;
      _configuredStatus = status;
      // The worker begins blank and cannot call location APIs until this
      // current, server-authorized configuration arrives in memory.
      _sendConfiguration(status, token);
    } catch (_) {
      // A failed foreground-service start is fail-closed: it never starts a
      // fallback foreground/background GPS listener.
      _serviceStartedByThisRuntime = false;
      _configuredStatus = null;
      throw const ProviderTrackingRuntimeException();
    }
  }

  /// Checks only. Permission requests belong to the explicit UI action, not
  /// recovery or foreground-service startup after a server-authority read.
  Future<bool> _hasLocationPermissionAndEnabledService() async {
    if (!await geolocator.Geolocator.isLocationServiceEnabled()) return false;
    final permission = await geolocator.Geolocator.checkPermission();
    return permission == geolocator.LocationPermission.always ||
        permission == geolocator.LocationPermission.whileInUse;
  }

  @override
  Future<bool> isRunning() async =>
      _serviceStartedByThisRuntime &&
      !_disposed &&
      await FlutterForegroundTask.isRunningService;

  @override
  bool matches(ProviderTrackingStatus status) {
    final configured = _configuredStatus;
    return _serviceStartedByThisRuntime &&
        configured != null &&
        configured.requestId == status.requestId &&
        configured.status == status.status &&
        configured.onTheWayCadenceMs == status.onTheWayCadenceMs &&
        configured.inProgressCadenceMs == status.inProgressCadenceMs;
  }

  @override
  Future<void> update(ProviderTrackingStatus status, String token) async {
    if (matches(status) && await isRunning()) return;
    final configured = _configuredStatus;
    if (!status.active ||
        configured == null ||
        configured.requestId != status.requestId ||
        !await isRunning()) {
      throw const ProviderTrackingRuntimeException();
    }
    try {
      // The worker cancels/replaces its stream in-memory while this foreground
      // service remains running; it never falls back to a local cadence.
      _sendConfiguration(status, token);
      _configuredStatus = status;
    } catch (_) {
      throw const ProviderTrackingRuntimeException();
    }
  }

  Future<void> _refreshForegroundServiceOptions(
    ProviderTrackingStatus status,
  ) async {
    final result = await FlutterForegroundTask.updateService(
      foregroundTaskOptions: _foregroundTaskOptions(status.cadenceMs),
      notificationTitle: 'معين — تتبع الطلب نشط',
      notificationText: 'رقم الطلب: ${status.requestId}',
    );
    if (result is ServiceRequestFailure) {
      throw const ProviderTrackingRuntimeException();
    }
  }

  void _sendConfiguration(ProviderTrackingStatus status, String token) {
    FlutterForegroundTask.sendDataToTask({
      'command': 'configure',
      'baseUrl': _baseUrl,
      'requestId': status.requestId,
      'token': token,
      'status': status.status,
      'onTheWayCadenceMs': status.onTheWayCadenceMs,
      'inProgressCadenceMs': status.inProgressCadenceMs,
      if (_lastCollectedAt != null)
        'lastCollectedAt': _lastCollectedAt!.toIso8601String(),
    });
  }

  @override
  Future<void> clearQueue() async {
    // Recovery runs during ordinary dashboard/widget startup too. Before this
    // runtime starts a server-authorized worker there is no process-memory queue
    // it owns, so avoid waiting on a foreground-service platform channel.
    if (!_serviceStartedByThisRuntime) return;
    try {
      FlutterForegroundTask.sendDataToTask(const {'command': 'clearQueue'});
    } catch (_) {
      // A missing platform implementation in a widget test has no collector.
      // Production worker teardown also clears the memory queue in onDestroy.
    }
  }

  @override
  Future<void> stop() async {
    final ownsLiveWorker = _serviceStartedByThisRuntime;
    try {
      if (ownsLiveWorker) {
        FlutterForegroundTask.sendDataToTask(const {'command': 'stop'});
      }
      // A recreated UI isolate has no local ownership marker for an Android
      // foreground service that survived it. Revoked, zero, or unverifiable
      // authority must still explicitly stop that inherited platform service.
      if (ownsLiveWorker ||
          (_shouldProbePlatformService() &&
              await FlutterForegroundTask.isRunningService)) {
        await _stopPlatformServiceAndVerifyStopped();
      }
    } on ProviderTrackingRuntimeException {
      rethrow;
    } catch (_) {
      // The explicit worker stop command is sent before stopping an owned
      // service; do not start a replacement collector when platform teardown
      // fails. Automatic restart remains disabled until a fresh GET authority.
      throw const ProviderTrackingRuntimeException();
    } finally {
      // The old service is never a future authority source. A teardown failure
      // is propagated, never converted into an OFF result; a later authority
      // response must explicitly create a fresh worker.
      _serviceStartedByThisRuntime = false;
      _configuredStatus = null;
      // Preserve only this process-memory cadence marker. A fresh
      // server-authorized start of the same request seeds the new worker so an
      // immediate Android stream emission cannot create a sub-cadence POST.
    }
  }

  Future<void> _stopPlatformServiceAndVerifyStopped() async {
    final result = await FlutterForegroundTask.stopService();
    if (result is ServiceRequestFailure ||
        (_shouldProbePlatformService() &&
            await FlutterForegroundTask.isRunningService)) {
      throw const ProviderTrackingRuntimeException();
    }
  }

  void _onTaskData(Object data) {
    if (_disposed || data is! Map<dynamic, dynamic>) return;
    try {
      final event = ProviderTrackingRuntimeEvent.fromMessage(data);
      // A delayed message from a prior worker must not update the active
      // request's cadence gate or stop its replacement collector.
      if (event.requestId != _configuredStatus?.requestId) return;
      if (event.type == 'sample_collected') {
        final capturedAt = data['capturedAt'];
        if (capturedAt is String) {
          final parsed = DateTime.tryParse(capturedAt);
          if (parsed != null && !parsed.isAfter(DateTime.now().toUtc())) {
            final normalized = parsed.toUtc();
            if (_lastCollectedAt == null ||
                _lastCollectedRequestId != event.requestId ||
                normalized.isAfter(_lastCollectedAt!)) {
              _lastCollectedAt = normalized;
              _lastCollectedRequestId = event.requestId;
            }
          }
        }
        return;
      }
      if (const {
        'unauthorized',
        'not_found',
        'inactive',
        'location_unavailable',
        'network',
        'stopped',
      }.contains(event.type)) {
        _serviceStartedByThisRuntime = false;
        _configuredStatus = null;
        // Terminal worker events cannot prove platform teardown completed. A
        // later fail-closed reconciliation probes and confirms that no FGS
        // remains before it reports collection as off or starts a replacement.
        // Keep only the latest collection timestamp in process memory. If a
        // fresh authority later starts this same request, its replacement gate
        // must reject an immediate post-recovery stream emission.
      }
      _onEvent(event);
    } catch (_) {
      // Worker messages never contain coordinates; malformed data cannot grant
      // authority or trigger acquisition.
    }
  }

  @override
  Future<void> dispose() async {
    _disposed = true;
    FlutterForegroundTask.removeTaskDataCallback(_onTaskData);
  }
}

@pragma('vm:entry-point')
void providerTrackingForegroundTaskStartCallback() {
  FlutterForegroundTask.setTaskHandler(ProviderTrackingTaskHandler());
}

class _ProviderTrackingWorkerConfig {
  const _ProviderTrackingWorkerConfig({
    required this.baseUrl,
    required this.token,
    required this.status,
    this.lastCollectedAt,
  });

  final String baseUrl;
  final String token;
  final ProviderTrackingStatus status;
  final DateTime? lastCollectedAt;
}

class _ProviderSample {
  const _ProviderSample({
    required this.latitude,
    required this.longitude,
    required this.accuracyMeters,
    required this.capturedAt,
  });

  final double latitude;
  final double longitude;
  final double accuracyMeters;
  final DateTime capturedAt;
}

/// Runs in the foreground-service isolate. It intentionally starts with no
/// authority configuration, so a service resurrected without an app-led GET
/// has no path to device location APIs.
/// Foreground-isolate worker. Its constructor accepts test-only transport and
/// retry seams while the production callback uses the same fail-closed defaults.
class ProviderTrackingTaskHandler extends TaskHandler {
  static const _sampleMaximumAge = Duration(minutes: 5);
  static const _queueMaximumSize = 100;

  ProviderTrackingTaskHandler({
    http.Client? client,
    List<Duration> authorityRetryDelays = const <Duration>[
      Duration(seconds: 1),
      Duration(seconds: 2),
      Duration(seconds: 5),
    ],
    ProviderTrackingWait? wait,
  }) : _client = client ?? http.Client(),
       _authorityRetryDelays = List<Duration>.unmodifiable(
         authorityRetryDelays,
       ),
       _wait = wait ?? Future<void>.delayed;

  final http.Client _client;
  final List<Duration> _authorityRetryDelays;
  final ProviderTrackingWait _wait;
  final List<_ProviderSample> _queue = <_ProviderSample>[];
  final ProviderTrackingCadenceGate _cadenceGate =
      ProviderTrackingCadenceGate();
  _ProviderTrackingWorkerConfig? _configuration;
  StreamSubscription<geolocator.Position>? _positionSubscription;
  Future<void> _configurationTail = Future<void>.value();
  bool _busy = false;
  bool _stopped = false;

  @override
  Future<void> onStart(DateTime timestamp, TaskStarter starter) async {
    // Do not collect GPS here. The main isolate must first perform an
    // authenticated GET /tracking and explicitly configure this new worker.
  }

  @override
  void onRepeatEvent(DateTime timestamp) {
    // Position samples come only from the current cadence-configured stream.
    // This foreground-task tick intentionally never reaches a location API.
  }

  @override
  void onReceiveData(Object data) {
    if (data is! Map<dynamic, dynamic>) return;
    final command = data['command'];
    if (command == 'stop') {
      unawaited(_stopAndNotify('stopped'));
      return;
    }
    if (command == 'clearQueue') {
      _queue.clear();
      return;
    }
    if (command == 'configure') {
      final config = _configurationFromMessage(data);
      if (config == null || _stopped) return;
      unawaited(_configureSerially(config));
    }
  }

  Future<void> _configureSerially(_ProviderTrackingWorkerConfig config) async {
    final previous = _configurationTail;
    final completion = Completer<void>();
    _configurationTail = completion.future;
    await previous;
    try {
      await _applyConfiguration(config);
    } finally {
      completion.complete();
    }
  }

  _ProviderTrackingWorkerConfig? _configurationFromMessage(
    Map<dynamic, dynamic> data,
  ) {
    final baseUrl = data['baseUrl'];
    final token = data['token'];
    final requestId = data['requestId'];
    final status = data['status'];
    final onTheWayCadenceMs = data['onTheWayCadenceMs'];
    final inProgressCadenceMs = data['inProgressCadenceMs'];
    final lastCollectedAt = data['lastCollectedAt'];
    if (baseUrl is! String ||
        token is! String ||
        token.isEmpty ||
        requestId is! String ||
        status is! String ||
        onTheWayCadenceMs is! int ||
        inProgressCadenceMs is! int) {
      return null;
    }
    try {
      final tracking = ProviderTrackingStatus(
        requestId: requestId,
        active: true,
        status: status,
        onTheWayCadenceMs: onTheWayCadenceMs,
        inProgressCadenceMs: inProgressCadenceMs,
      );
      // Verify the status/cadence before it can be used to call GPS APIs.
      tracking.cadenceMs;
      DateTime? parsedLastCollectedAt;
      if (lastCollectedAt != null) {
        if (lastCollectedAt is! String) return null;
        parsedLastCollectedAt = DateTime.tryParse(lastCollectedAt)?.toUtc();
        if (parsedLastCollectedAt == null ||
            parsedLastCollectedAt.isAfter(DateTime.now().toUtc())) {
          return null;
        }
      }
      final uri = Uri.tryParse(baseUrl);
      if (uri == null ||
          !(uri.scheme == 'http' || uri.scheme == 'https') ||
          uri.host.isEmpty) {
        return null;
      }
      return _ProviderTrackingWorkerConfig(
        baseUrl: baseUrl.replaceFirst(RegExp(r'/$'), ''),
        token: token,
        status: tracking,
        lastCollectedAt: parsedLastCollectedAt,
      );
    } catch (_) {
      return null;
    }
  }

  bool _hasSameCollectorConfiguration(
    _ProviderTrackingWorkerConfig left,
    _ProviderTrackingWorkerConfig right,
  ) {
    return left.baseUrl == right.baseUrl &&
        left.token == right.token &&
        left.status.requestId == right.status.requestId &&
        left.status.status == right.status.status &&
        left.status.onTheWayCadenceMs == right.status.onTheWayCadenceMs &&
        left.status.inProgressCadenceMs == right.status.inProgressCadenceMs;
  }

  Future<void> _applyConfiguration(_ProviderTrackingWorkerConfig config) async {
    final existing = _configuration;
    if (existing != null &&
        _positionSubscription != null &&
        _hasSameCollectorConfiguration(existing, config)) {
      // Repeated stable authority is a true no-op. Keep the same location
      // subscription and FGS; a duplicate message must never toggle Android
      // GPS registration or recreate a collector.
      final lastCollectedAt = config.lastCollectedAt;
      if (lastCollectedAt != null) {
        _cadenceGate.seed(config.status, lastCollectedAt);
      }
      return;
    }

    // Reconfigure the live stream in memory. The foreground service itself
    // remains running so the provider does not see a notification/service gap
    // while the server changes cadence from on-the-way to in-progress.
    final previousSubscription = _positionSubscription;
    _positionSubscription = null;
    await previousSubscription?.cancel();
    _configuration = config;
    final lastCollectedAt = config.lastCollectedAt;
    if (lastCollectedAt != null) {
      _cadenceGate.seed(config.status, lastCollectedAt);
    }
    final result = await FlutterForegroundTask.updateService(
      foregroundTaskOptions: _foregroundTaskOptions(config.status.cadenceMs),
      notificationTitle: 'معين — تتبع الطلب نشط',
      notificationText: 'رقم الطلب: ${config.status.requestId}',
    );
    if (result is ServiceRequestFailure) {
      await _stopAndNotify('network');
      return;
    }
    if (_configuration != config || _stopped) return;
    _positionSubscription =
        geolocator.Geolocator.getPositionStream(
          locationSettings: geolocator.AndroidSettings(
            accuracy: geolocator.LocationAccuracy.high,
            distanceFilter: 0,
            intervalDuration: Duration(milliseconds: config.status.cadenceMs),
          ),
        ).listen(
          (position) => unawaited(_onNewPosition(config, position)),
          onError: (error, stackTrace) {
            unawaited(_stopAndNotify('location_unavailable'));
          },
          cancelOnError: true,
        );
  }

  Future<void> _onNewPosition(
    _ProviderTrackingWorkerConfig config,
    geolocator.Position position,
  ) async {
    if (_stopped || _busy || _configuration != config) return;
    _busy = true;
    try {
      if (!await _hasLocationPermissionAndEnabledService()) {
        await _stopAndNotify('location_unavailable');
        return;
      }
      // Recheck after the platform stream emits: a concurrent pause/recovery
      // may have revoked authority while this sample was being delivered.
      if (_configuration != config || _stopped) return;
      final capturedAt = DateTime.now().toUtc();
      // Android may emit faster than intervalDuration after a network or GNSS
      // change. The server-supplied cadence is the final client-side throttle;
      // skipped intervals are deliberately not queued for later catch-up.
      if (!_cadenceGate.shouldCollect(config.status, capturedAt)) return;
      final sample = _ProviderSample(
        latitude: position.latitude,
        longitude: position.longitude,
        accuracyMeters: position.accuracy,
        capturedAt: capturedAt,
      );
      if (!_isValidSample(sample)) {
        await _recoverAfterSampleRejection(config);
        return;
      }
      // Carry only the collection timestamp to the live main isolate. It is
      // never persisted and is used solely to seed a same-process replacement
      // worker's cadence gate; no coordinate data leaves this worker.
      _sendEvent('sample_collected', config.status.requestId, capturedAt);
      _enqueue(sample);
      await _submitOldest(config);
    } catch (_) {
      // GPS loss and all unexpected acquisition faults revoke collection; they
      // must never become an offline coordinate buffer.
      await _stopAndNotify('location_unavailable');
    } finally {
      _busy = false;
    }
  }

  Future<bool> _hasLocationPermissionAndEnabledService() async {
    if (!await geolocator.Geolocator.isLocationServiceEnabled()) return false;
    final permission = await geolocator.Geolocator.checkPermission();
    return permission == geolocator.LocationPermission.always ||
        permission == geolocator.LocationPermission.whileInUse;
  }

  bool _isValidSample(_ProviderSample sample) {
    return sample.latitude.isFinite &&
        sample.latitude >= -90 &&
        sample.latitude <= 90 &&
        sample.longitude.isFinite &&
        sample.longitude >= -180 &&
        sample.longitude <= 180 &&
        sample.accuracyMeters.isFinite &&
        sample.accuracyMeters >= 0;
  }

  void _enqueue(_ProviderSample sample) {
    _pruneQueue();
    if (_queue.length >= _queueMaximumSize) _queue.removeAt(0);
    _queue.add(sample);
  }

  void _pruneQueue() {
    final oldestAllowed = DateTime.now().toUtc().subtract(_sampleMaximumAge);
    _queue.removeWhere((sample) => sample.capturedAt.isBefore(oldestAllowed));
  }

  Future<void> _submitOldest(_ProviderTrackingWorkerConfig config) async {
    _pruneQueue();
    if (_queue.isEmpty || _configuration != config || _stopped) return;
    final sample = _queue.first;
    http.Response response;
    try {
      response = await _client.post(
        Uri.parse(
          '${config.baseUrl}/provider/service-requests/${config.status.requestId}/location',
        ),
        headers: <String, String>{
          'Authorization': 'Bearer ${config.token}',
          'Content-Type': 'application/json',
        },
        body: jsonEncode(<String, Object>{
          'latitude': sample.latitude,
          'longitude': sample.longitude,
          'accuracyMeters': sample.accuracyMeters,
          'capturedAt': sample.capturedAt.toIso8601String(),
        }),
      );
    } catch (_) {
      await _recoverAfterNetworkFailure(config);
      return;
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      _queue.remove(sample);
      return;
    }
    if (response.statusCode == 401) {
      await _stopAndNotify('unauthorized');
      return;
    }
    if (response.statusCode == 404) {
      await _stopAndNotify('not_found');
      return;
    }
    if (response.statusCode >= 500) {
      await _recoverAfterNetworkFailure(config);
      return;
    }
    // 409 and every rejected sample fail closed, then re-read server authority.
    await _recoverAfterSampleRejection(config);
  }

  Future<void> _recoverAfterSampleRejection(
    _ProviderTrackingWorkerConfig config,
  ) async {
    await _pauseAndClear();
    final result = await _readAndApplyAuthority(config);
    if (result == _AuthorityReadResult.networkFailure) {
      await _boundedAuthorityRetry(config);
    }
  }

  Future<void> _recoverAfterNetworkFailure(
    _ProviderTrackingWorkerConfig config,
  ) async {
    await _pauseAndClear();
    await _boundedAuthorityRetry(config);
  }

  Future<void> _pauseAndClear() async {
    _configuration = null;
    _queue.clear();
    // Keep the last accepted timestamp while recovering this same request.
    // The replacement stream may emit immediately, but it must not submit a
    // sub-cadence catch-up sample after an authority/network recovery.
    final subscription = _positionSubscription;
    _positionSubscription = null;
    await subscription?.cancel();
  }

  Future<void> _boundedAuthorityRetry(
    _ProviderTrackingWorkerConfig config,
  ) async {
    // All retry time is collector-off time. No local cadence or GPS fallback.
    for (final delay in _authorityRetryDelays) {
      if (_stopped || _configuration != null) return;
      await _wait(delay);
      if (_stopped || _configuration != null) return;
      final result = await _readAndApplyAuthority(config);
      if (result != _AuthorityReadResult.networkFailure) return;
    }
    await _stopAndNotify('network');
  }

  Future<_AuthorityReadResult> _readAndApplyAuthority(
    _ProviderTrackingWorkerConfig previous,
  ) async {
    http.Response response;
    try {
      response = await _client.get(
        Uri.parse(
          '${previous.baseUrl}/provider/service-requests/${previous.status.requestId}/tracking',
        ),
        headers: <String, String>{'Authorization': 'Bearer ${previous.token}'},
      );
    } catch (_) {
      return _AuthorityReadResult.networkFailure;
    }
    if (response.statusCode == 401) {
      await _stopAndNotify('unauthorized');
      return _AuthorityReadResult.terminal;
    }
    if (response.statusCode == 404) {
      await _stopAndNotify('not_found');
      return _AuthorityReadResult.terminal;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return _AuthorityReadResult.networkFailure;
    }
    try {
      final decoded = jsonDecode(response.body);
      if (decoded is! Map<dynamic, dynamic>) {
        return _AuthorityReadResult.networkFailure;
      }
      final status = ProviderTrackingStatus.fromResponse(
        Map<String, dynamic>.from(decoded),
      );
      if (!status.active || status.requestId != previous.status.requestId) {
        await _stopAndNotify('inactive');
        return _AuthorityReadResult.terminal;
      }
      await _configureSerially(
        _ProviderTrackingWorkerConfig(
          baseUrl: previous.baseUrl,
          token: previous.token,
          status: status,
        ),
      );
      if (_configuration == null) return _AuthorityReadResult.networkFailure;
      _sendEvent('authority_restored', status.requestId);
      return _AuthorityReadResult.active;
    } catch (_) {
      return _AuthorityReadResult.networkFailure;
    }
  }

  Future<void> _stopAndNotify(String event) async {
    final requestId = _configuration?.status.requestId;
    _stopped = true;
    _configuration = null;
    _queue.clear();
    _cadenceGate.reset();
    final subscription = _positionSubscription;
    _positionSubscription = null;
    await subscription?.cancel();
    if (requestId != null) _sendEvent(event, requestId);
    await FlutterForegroundTask.stopService();
  }

  void _sendEvent(String event, String requestId, [DateTime? capturedAt]) {
    // Never expose coordinate data, bearer tokens, or server response bodies to
    // the UI isolate or logs. The optional timestamp is process-memory-only
    // cadence state for a same-process replacement worker.
    FlutterForegroundTask.sendDataToMain(<String, String>{
      'event': event,
      'requestId': requestId,
      if (capturedAt != null)
        'capturedAt': capturedAt.toUtc().toIso8601String(),
    });
  }

  @override
  Future<void> onDestroy(DateTime timestamp, bool isTimeout) async {
    _stopped = true;
    _configuration = null;
    _queue.clear();
    await _positionSubscription?.cancel();
    _positionSubscription = null;
    _client.close();
  }
}

enum _AuthorityReadResult { active, terminal, networkFailure }
