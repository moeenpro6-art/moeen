import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:flutter_foreground_task/flutter_foreground_task_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart' as geolocator;
import 'package:moeen_provider/provider_tracking.dart';

void main() {
  late FlutterForegroundTaskPlatform previousForegroundPlatform;
  late geolocator.GeolocatorPlatform previousGeolocatorPlatform;
  late _ForegroundPlatform foreground;
  late _GeolocatorPlatform geolocatorPlatform;

  setUp(() {
    previousForegroundPlatform = FlutterForegroundTaskPlatform.instance;
    previousGeolocatorPlatform = geolocator.GeolocatorPlatform.instance;
    FlutterForegroundTask.resetStatic();
    foreground = _ForegroundPlatform();
    geolocatorPlatform = _GeolocatorPlatform();
    FlutterForegroundTaskPlatform.instance = foreground;
    geolocator.GeolocatorPlatform.instance = geolocatorPlatform;
    FlutterForegroundTask.skipServiceResponseCheck = true;
  });

  tearDown(() {
    FlutterForegroundTask.resetStatic();
    FlutterForegroundTaskPlatform.instance = previousForegroundPlatform;
    geolocator.GeolocatorPlatform.instance = previousGeolocatorPlatform;
  });

  test(
    'permission gate returns false before requesting when GPS is disabled',
    () async {
      geolocatorPlatform.serviceEnabled = false;

      final granted = await const GeolocatorProviderTrackingPermissionGate()
          .ensurePermission();

      expect(granted, isFalse);
      expect(geolocatorPlatform.checkCalls, 0);
      expect(geolocatorPlatform.requestCalls, 0);
    },
  );

  test(
    'permission gate requests a denied permission and accepts usable grants',
    () async {
      geolocatorPlatform.permission = geolocator.LocationPermission.denied;
      geolocatorPlatform.requestedPermission =
          geolocator.LocationPermission.always;

      final granted = await const GeolocatorProviderTrackingPermissionGate()
          .ensurePermission();

      expect(granted, isTrue);
      expect(geolocatorPlatform.checkCalls, 1);
      expect(geolocatorPlatform.requestCalls, 1);
    },
  );

  test(
    'permission gate rejects permanently denied permission without a request',
    () async {
      geolocatorPlatform.permission =
          geolocator.LocationPermission.deniedForever;

      final granted = await const GeolocatorProviderTrackingPermissionGate()
          .ensurePermission();

      expect(granted, isFalse);
      expect(geolocatorPlatform.checkCalls, 1);
      expect(geolocatorPlatform.requestCalls, 0);
    },
  );

  test('foreground initialization configures fail-closed task options', () {
    initializeProviderTrackingForegroundTask();

    final options = FlutterForegroundTask.foregroundTaskOptions!;
    expect(FlutterForegroundTask.isInitialized, isTrue);
    expect(
      FlutterForegroundTask.androidNotificationOptions!.channelId,
      'moeen_provider_tracking',
    );
    expect(options.autoRunOnBoot, isFalse);
    expect(options.autoRunOnMyPackageReplaced, isFalse);
    expect(options.allowAutoRestart, isFalse);
    expect(options.stopWithTask, isFalse);
    expect(options.allowWifiLock, isFalse);
  });

  test(
    'foreground entry callback installs a blank fail-closed worker',
    () async {
      providerTrackingForegroundTaskStartCallback();
      final handler = foreground.handler!;

      await handler.onStart(DateTime.utc(2026), TaskStarter.developer);
      handler.onRepeatEvent(DateTime.utc(2026));

      expect(handler, isA<ProviderTrackingTaskHandler>());
      expect(geolocatorPlatform.checkCalls, 0);
      expect(foreground.updateCalls, 0);
    },
  );

  test(
    'runtime starts only with active current authority and sends ephemeral configuration',
    () async {
      final events = <ProviderTrackingRuntimeEvent>[];
      final runtime = FlutterProviderTrackingRuntime(
        baseUrl: 'https://api.example.test/',
        onEvent: events.add,
      );
      final authority = _status();

      await runtime.start(authority, 'provider-session');

      expect(foreground.startCalls, 1);
      expect(foreground.running, isTrue);
      expect(foreground.taskMessages, hasLength(1));
      expect(foreground.taskMessages.single, {
        'command': 'configure',
        'baseUrl': 'https://api.example.test',
        'requestId': 'MOE-1001',
        'token': 'provider-session',
        'status': 'on_the_way',
        'onTheWayCadenceMs': 15000,
        'inProgressCadenceMs': 60000,
      });
      expect(events, isEmpty);
    },
  );

  test(
    'runtime replaces a lost service with one worker and preserves its in-memory cadence marker',
    () async {
      final events = <ProviderTrackingRuntimeEvent>[];
      final runtime = FlutterProviderTrackingRuntime(
        baseUrl: 'https://api.example.test',
        onEvent: events.add,
      );
      final collectedAt = DateTime.now().toUtc();

      await runtime.start(_status(), 'provider-session');
      FlutterForegroundTask.dataCallbacks.single({
        'event': 'sample_collected',
        'requestId': 'MOE-1001',
        'capturedAt': collectedAt.toIso8601String(),
      });
      // The worker died outside the main isolate. Reconciliation will see the
      // platform service is gone and must create exactly one replacement, not
      // report a stale local configuration as still running.
      foreground.running = false;

      await runtime.start(_status(), 'provider-session');

      expect(foreground.startCalls, 2);
      expect(foreground.running, isTrue);
      expect(events, isEmpty);
      expect(foreground.taskMessages.last, {
        'command': 'configure',
        'baseUrl': 'https://api.example.test',
        'requestId': 'MOE-1001',
        'token': 'provider-session',
        'status': 'on_the_way',
        'onTheWayCadenceMs': 15000,
        'inProgressCadenceMs': 60000,
        'lastCollectedAt': collectedAt.toIso8601String(),
      });
    },
  );

  test(
    'runtime preserves a same-request cadence marker through a fail-closed stop',
    () async {
      final runtime = FlutterProviderTrackingRuntime(
        baseUrl: 'https://api.example.test',
        onEvent: (_) {},
      );
      final collectedAt = DateTime.now().toUtc();

      await runtime.start(_status(), 'provider-session');
      FlutterForegroundTask.dataCallbacks.single({
        'event': 'sample_collected',
        'requestId': 'MOE-1001',
        'capturedAt': collectedAt.toIso8601String(),
      });
      await runtime.stop();
      await runtime.start(_status(), 'provider-session');

      expect(foreground.startCalls, 2);
      expect(foreground.taskMessages.last, {
        'command': 'configure',
        'baseUrl': 'https://api.example.test',
        'requestId': 'MOE-1001',
        'token': 'provider-session',
        'status': 'on_the_way',
        'onTheWayCadenceMs': 15000,
        'inProgressCadenceMs': 60000,
        'lastCollectedAt': collectedAt.toIso8601String(),
      });
    },
  );

  test(
    'runtime preserves a same-request cadence marker after a terminal worker event',
    () async {
      final runtime = FlutterProviderTrackingRuntime(
        baseUrl: 'https://api.example.test',
        onEvent: (_) {},
      );
      final collectedAt = DateTime.now().toUtc();

      await runtime.start(_status(), 'provider-session');
      FlutterForegroundTask.dataCallbacks.single({
        'event': 'sample_collected',
        'requestId': 'MOE-1001',
        'capturedAt': collectedAt.toIso8601String(),
      });
      FlutterForegroundTask.dataCallbacks.single({
        'event': 'network',
        'requestId': 'MOE-1001',
      });
      await runtime.start(_status(), 'provider-session');

      expect(foreground.startCalls, 2);
      expect(foreground.taskMessages.last, {
        'command': 'configure',
        'baseUrl': 'https://api.example.test',
        'requestId': 'MOE-1001',
        'token': 'provider-session',
        'status': 'on_the_way',
        'onTheWayCadenceMs': 15000,
        'inProgressCadenceMs': 60000,
        'lastCollectedAt': collectedAt.toIso8601String(),
      });
    },
  );

  test(
    'runtime never seeds a different request with the previous request cadence marker',
    () async {
      final runtime = FlutterProviderTrackingRuntime(
        baseUrl: 'https://api.example.test',
        onEvent: (_) {},
      );
      final collectedAt = DateTime.now().toUtc();

      await runtime.start(_status(), 'provider-session');
      FlutterForegroundTask.dataCallbacks.single({
        'event': 'sample_collected',
        'requestId': 'MOE-1001',
        'capturedAt': collectedAt.toIso8601String(),
      });
      await runtime.stop();
      await runtime.start(_status(requestId: 'MOE-1002'), 'provider-session');

      expect(foreground.taskMessages.last, {
        'command': 'configure',
        'baseUrl': 'https://api.example.test',
        'requestId': 'MOE-1002',
        'token': 'provider-session',
        'status': 'on_the_way',
        'onTheWayCadenceMs': 15000,
        'inProgressCadenceMs': 60000,
      });
    },
  );

  test(
    'runtime ignores a stale sample event after the authority changes request',
    () async {
      final runtime = FlutterProviderTrackingRuntime(
        baseUrl: 'https://api.example.test',
        onEvent: (_) {},
      );
      final collectedAt = DateTime.now().toUtc();

      await runtime.start(_status(), 'provider-session');
      await runtime.stop();
      await runtime.start(_status(requestId: 'MOE-1002'), 'provider-session');
      FlutterForegroundTask.dataCallbacks.single({
        'event': 'sample_collected',
        'requestId': 'MOE-1001',
        'capturedAt': collectedAt.toIso8601String(),
      });
      await runtime.update(
        _status(requestId: 'MOE-1002', status: 'in_progress'),
        'provider-session',
      );

      expect(foreground.taskMessages.last, {
        'command': 'configure',
        'baseUrl': 'https://api.example.test',
        'requestId': 'MOE-1002',
        'token': 'provider-session',
        'status': 'in_progress',
        'onTheWayCadenceMs': 15000,
        'inProgressCadenceMs': 60000,
      });
    },
  );

  test('runtime rejects an in-place update for a different request', () async {
    final runtime = FlutterProviderTrackingRuntime(
      baseUrl: 'https://api.example.test',
      onEvent: (_) {},
    );

    await runtime.start(_status(), 'provider-session');

    await expectLater(
      runtime.update(
        _status(requestId: 'MOE-1002', status: 'in_progress'),
        'provider-session',
      ),
      throwsA(isA<ProviderTrackingRuntimeException>()),
    );
    expect(foreground.startCalls, 1);
    expect(foreground.stopCalls, 0);
    expect(foreground.taskMessages, hasLength(1));
  });

  test(
    'runtime denies inactive authority or unavailable location before service startup',
    () async {
      final runtime = FlutterProviderTrackingRuntime(
        baseUrl: 'https://api.example.test',
        onEvent: (_) {},
      );

      await expectLater(
        runtime.start(_status(active: false), 'provider-session'),
        throwsA(isA<ProviderTrackingLocationPermissionException>()),
      );
      geolocatorPlatform.serviceEnabled = false;
      await expectLater(
        runtime.start(_status(), 'provider-session'),
        throwsA(isA<ProviderTrackingLocationPermissionException>()),
      );

      expect(foreground.startCalls, 0);
    },
  );

  test(
    'runtime makes service startup failure fail closed as a runtime error',
    () async {
      foreground.failStart = true;
      final runtime = FlutterProviderTrackingRuntime(
        baseUrl: 'https://api.example.test',
        onEvent: (_) {},
      );

      await expectLater(
        runtime.start(_status(), 'provider-session'),
        throwsA(isA<ProviderTrackingRuntimeException>()),
      );

      expect(foreground.startCalls, 1);
      expect(foreground.taskMessages, isEmpty);
    },
  );

  test(
    'runtime treats a terminal worker event as already stopped and does not issue a duplicate stop',
    () async {
      final events = <ProviderTrackingRuntimeEvent>[];
      final runtime = FlutterProviderTrackingRuntime(
        baseUrl: 'https://api.example.test',
        onEvent: events.add,
      );
      await runtime.start(_status(), 'provider-session');

      await runtime.update(
        _status(status: 'in_progress'),
        'replacement-session',
      );
      await runtime.clearQueue();
      FlutterForegroundTask.dataCallbacks.single({
        'event': 'network',
        'requestId': 'MOE-1001',
      });
      FlutterForegroundTask.dataCallbacks.single({'event': 8, 'requestId': ''});
      // The real worker sends this terminal event immediately before it stops
      // its own service. Model the completed worker teardown before the main
      // isolate's follow-up stop check, so no duplicate service is created.
      foreground.running = false;
      await runtime.stop();
      await runtime.dispose();

      expect(foreground.taskMessages, [
        isA<Map<String, Object>>(),
        {
          'command': 'configure',
          'baseUrl': 'https://api.example.test',
          'requestId': 'MOE-1001',
          'token': 'replacement-session',
          'status': 'in_progress',
          'onTheWayCadenceMs': 15000,
          'inProgressCadenceMs': 60000,
        },
        {'command': 'clearQueue'},
      ]);
      expect(events, [
        isA<ProviderTrackingRuntimeEvent>()
            .having((event) => event.type, 'type', 'network')
            .having((event) => event.requestId, 'request id', 'MOE-1001'),
      ]);
      // The worker's completed teardown leaves no platform service for the
      // main isolate to stop or replace.
      expect(foreground.stopCalls, 0);
      expect(foreground.running, isFalse);
    },
  );

  test(
    'fresh runtime stops an inherited platform foreground service when zero authority is reconciled',
    () async {
      foreground.running = true;
      final runtime = FlutterProviderTrackingRuntime(
        baseUrl: 'https://api.example.test',
        onEvent: (_) {},
        shouldProbePlatformService: () => true,
      );
      final coordinator = ProviderTrackingRecoveryCoordinator(
        api: _UnusedTrackingApi(),
        runtime: runtime,
      );

      final result = await coordinator.reconcile(
        token: 'provider-session',
        requestIds: const [],
      );

      expect(result, ProviderTrackingRecoveryResult.inactive);
      expect(foreground.stopCalls, 1);
      expect(foreground.running, isFalse);
      expect(foreground.taskMessages, isEmpty);
    },
  );

  test(
    'fresh runtime propagates a teardown failure instead of reporting inactive while an inherited service remains running',
    () async {
      foreground.running = true;
      foreground.failStop = true;
      final runtime = FlutterProviderTrackingRuntime(
        baseUrl: 'https://api.example.test',
        onEvent: (_) {},
        shouldProbePlatformService: () => true,
      );
      final coordinator = ProviderTrackingRecoveryCoordinator(
        api: _UnusedTrackingApi(),
        runtime: runtime,
      );

      await expectLater(
        coordinator.reconcile(token: 'provider-session', requestIds: const []),
        throwsA(isA<ProviderTrackingRuntimeException>()),
      );

      expect(foreground.stopCalls, 1);
      expect(foreground.running, isTrue);
      expect(foreground.taskMessages, isEmpty);
    },
  );

  test(
    'fresh runtime stops an inherited foreground service before rejecting unavailable location permission',
    () async {
      foreground.running = true;
      geolocatorPlatform.permission = geolocator.LocationPermission.denied;
      final runtime = FlutterProviderTrackingRuntime(
        baseUrl: 'https://api.example.test',
        onEvent: (_) {},
        shouldProbePlatformService: () => true,
      );

      await expectLater(
        runtime.start(_status(), 'provider-session'),
        throwsA(isA<ProviderTrackingLocationPermissionException>()),
      );

      expect(foreground.stopCalls, 1);
      expect(foreground.running, isFalse);
      expect(foreground.startCalls, 0);
      expect(foreground.taskMessages, isEmpty);
    },
  );

  test(
    'fresh runtime adopts an inherited foreground service for repeated stable trusted authority',
    () async {
      foreground.running = true;
      final authority = _status();
      final runtime = FlutterProviderTrackingRuntime(
        baseUrl: 'https://api.example.test',
        onEvent: (_) {},
        shouldProbePlatformService: () => true,
      );
      final coordinator = ProviderTrackingRecoveryCoordinator(
        api: _ActiveTrackingApi(authority),
        runtime: runtime,
      );

      final first = await coordinator.reconcile(
        token: 'provider-session',
        requestIds: const ['MOE-1001'],
      );
      final second = await coordinator.reconcile(
        token: 'provider-session',
        requestIds: const ['MOE-1001'],
      );

      expect(first, ProviderTrackingRecoveryResult.active);
      expect(second, ProviderTrackingRecoveryResult.active);
      expect(foreground.stopCalls, 0);
      expect(foreground.startCalls, 0);
      expect(foreground.updateCalls, 1);
      expect(foreground.running, isTrue);
      expect(foreground.taskMessages, [
        {
          'command': 'configure',
          'baseUrl': 'https://api.example.test',
          'requestId': 'MOE-1001',
          'token': 'provider-session',
          'status': 'on_the_way',
          'onTheWayCadenceMs': 15000,
          'inProgressCadenceMs': 60000,
        },
      ]);
    },
  );

  test(
    'fresh runtime fails closed when inherited foreground-service options cannot be refreshed',
    () async {
      foreground.running = true;
      foreground.failUpdate = true;
      final runtime = FlutterProviderTrackingRuntime(
        baseUrl: 'https://api.example.test',
        onEvent: (_) {},
        shouldProbePlatformService: () => true,
      );
      final coordinator = ProviderTrackingRecoveryCoordinator(
        api: _ActiveTrackingApi(_status()),
        runtime: runtime,
      );

      await expectLater(
        coordinator.reconcile(
          token: 'provider-session',
          requestIds: const ['MOE-1001'],
        ),
        throwsA(isA<ProviderTrackingRuntimeException>()),
      );

      expect(foreground.updateCalls, 1);
      expect(foreground.stopCalls, 1);
      expect(foreground.startCalls, 0);
      expect(foreground.running, isFalse);
      expect(foreground.taskMessages, isEmpty);
    },
  );

  test('runtime rejects updates before it owns a running service', () async {
    final runtime = FlutterProviderTrackingRuntime(
      baseUrl: 'https://api.example.test',
      onEvent: (_) {},
    );

    await expectLater(
      runtime.update(_status(), 'provider-session'),
      throwsA(isA<ProviderTrackingRuntimeException>()),
    );
    await runtime.clearQueue();
    await runtime.stop();

    expect(foreground.taskMessages, isEmpty);
    expect(foreground.stopCalls, 0);
  });
}

ProviderTrackingStatus _status({
  String requestId = 'MOE-1001',
  bool active = true,
  String status = 'on_the_way',
}) => ProviderTrackingStatus(
  requestId: requestId,
  active: active,
  status: status,
  onTheWayCadenceMs: 15000,
  inProgressCadenceMs: 60000,
);

class _UnusedTrackingApi implements ProviderTrackingApi {
  @override
  Future<ProviderTrackingStatus> getTrackingStatus(
    String token,
    String requestId,
  ) => throw UnimplementedError('zero authority must not read tracking');
}

class _ActiveTrackingApi implements ProviderTrackingApi {
  const _ActiveTrackingApi(this.status);

  final ProviderTrackingStatus status;

  @override
  Future<ProviderTrackingStatus> getTrackingStatus(
    String token,
    String requestId,
  ) async => status;
}

class _ForegroundPlatform extends FlutterForegroundTaskPlatform {
  bool running = false;
  bool failStart = false;
  bool failUpdate = false;
  bool failStop = false;
  int startCalls = 0;
  int updateCalls = 0;
  int stopCalls = 0;
  final List<Object> taskMessages = <Object>[];
  TaskHandler? handler;

  @override
  Future<bool> get isRunningService async => running;

  @override
  Future<void> startService({
    required AndroidNotificationOptions androidNotificationOptions,
    required IOSNotificationOptions iosNotificationOptions,
    required ForegroundTaskOptions foregroundTaskOptions,
    int? serviceId,
    List<ForegroundServiceTypes>? serviceTypes,
    required String notificationTitle,
    required String notificationText,
    NotificationIcon? notificationIcon,
    List<NotificationButton>? notificationButtons,
    String? notificationInitialRoute,
    Function? callback,
  }) async {
    startCalls += 1;
    if (failStart) throw StateError('start failure');
    running = true;
  }

  @override
  Future<void> updateService({
    ForegroundTaskOptions? foregroundTaskOptions,
    String? notificationTitle,
    String? notificationText,
    NotificationIcon? notificationIcon,
    List<NotificationButton>? notificationButtons,
    String? notificationInitialRoute,
    Function? callback,
  }) async {
    updateCalls += 1;
    if (failUpdate) throw StateError('update failure');
  }

  @override
  Future<void> stopService() async {
    stopCalls += 1;
    if (failStop) throw StateError('stop failure');
    running = false;
  }

  @override
  void sendDataToTask(Object data) => taskMessages.add(data);

  @override
  void setTaskHandler(TaskHandler value) => handler = value;
}

class _GeolocatorPlatform extends geolocator.GeolocatorPlatform {
  bool serviceEnabled = true;
  geolocator.LocationPermission permission =
      geolocator.LocationPermission.whileInUse;
  geolocator.LocationPermission requestedPermission =
      geolocator.LocationPermission.whileInUse;
  int checkCalls = 0;
  int requestCalls = 0;

  @override
  Future<geolocator.LocationPermission> checkPermission() async {
    checkCalls += 1;
    return permission;
  }

  @override
  Future<bool> isLocationServiceEnabled() async => serviceEnabled;

  @override
  Future<geolocator.LocationPermission> requestPermission() async {
    requestCalls += 1;
    return requestedPermission;
  }
}
