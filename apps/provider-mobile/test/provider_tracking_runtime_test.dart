import 'dart:async';

import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:flutter_foreground_task/flutter_foreground_task_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart' as geolocator;
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

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

  tearDown(() async {
    await geolocatorPlatform.close();
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
      expect(_withoutGeneration(foreground.taskMessages.single), {
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
        'generation': _generationOf(foreground.taskMessages.last),
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
      expect(_withoutGeneration(foreground.taskMessages.last), {
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
    'fresh authority reconfigures a generation-less surviving service instead of no-op',
    () async {
      initializeProviderTrackingForegroundTask();
      final serviceAuthority = _ImmediateServiceAuthority();
      final authority = _status();
      foreground
        ..handler = ProviderTrackingTaskHandler(
          serviceAuthority: serviceAuthority,
        )
        ..deliverTaskMessages = true;
      final runtime = FlutterProviderTrackingRuntime(
        baseUrl: 'https://api.example.test',
        onEvent: (_) {},
        shouldProbePlatformService: () => true,
        serviceAuthority: serviceAuthority,
      );
      final coordinator = ProviderTrackingRecoveryCoordinator(
        api: _ActiveTrackingApi(authority),
        runtime: runtime,
      );

      await runtime.start(authority, 'provider-session');
      final firstGeneration = _generationOf(foreground.taskMessages.single);
      await serviceAuthority.releaseGeneration(firstGeneration);

      expect(foreground.running, isTrue);
      expect(await runtime.isRunning(), isFalse);
      expect(
        await coordinator.reconcile(
          token: 'provider-session',
          requestIds: const ['MOE-1001'],
        ),
        ProviderTrackingRecoveryResult.active,
      );

      expect(foreground.startCalls, 1);
      expect(foreground.stopCalls, 0);
      expect(foreground.taskMessages, hasLength(2));
      expect(
        _generationOf(foreground.taskMessages.last),
        isNot(firstGeneration),
      );
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
        'generation': _generationOf(foreground.taskMessages.last),
        'requestId': 'MOE-1001',
        'capturedAt': collectedAt.toIso8601String(),
      });
      await runtime.stop();
      await runtime.start(_status(), 'provider-session');

      expect(foreground.startCalls, 2);
      expect(_withoutGeneration(foreground.taskMessages.last), {
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
    'fresh authority reconfigures a paused collector that still owns its generation',
    () async {
      initializeProviderTrackingForegroundTask();
      final serviceAuthority = _ImmediateServiceAuthority();
      final authority = _status();
      final pausedWorker = ProviderTrackingTaskHandler(
        client: MockClient(
          (_) async => throw StateError('network unavailable'),
        ),
        authorityRetryDelays: const [Duration(days: 1)],
        wait: (_) => Completer<void>().future,
        serviceAuthority: serviceAuthority,
      );
      foreground
        ..handler = pausedWorker
        ..deliverTaskMessages = true;
      final runtime = FlutterProviderTrackingRuntime(
        baseUrl: 'https://api.example.test',
        onEvent: (_) {},
        shouldProbePlatformService: () => true,
        serviceAuthority: serviceAuthority,
      );
      final coordinator = ProviderTrackingRecoveryCoordinator(
        api: _ActiveTrackingApi(authority),
        runtime: runtime,
      );

      await runtime.start(authority, 'provider-session');
      final firstConfiguration = Map<String, Object>.from(
        foreground.taskMessages.single as Map,
      );
      await _settle();
      geolocatorPlatform.emitPosition();
      await _settle();

      expect(geolocatorPlatform.positionStreamCancelCalls, 1);
      expect(foreground.running, isTrue);
      expect(await runtime.isRunning(), isFalse);
      expect(
        await coordinator.reconcile(
          token: 'provider-session',
          requestIds: const ['MOE-1001'],
        ),
        ProviderTrackingRecoveryResult.active,
      );

      expect(foreground.taskMessages, hasLength(2));
      expect(
        _generationOf(foreground.taskMessages.last),
        isNot(_generationOf(firstConfiguration)),
      );
    },
  );

  for (final terminalCase
      in <({String label, http.Response response, String event})>[
        (
          label: '401',
          response: http.Response('{}', 401),
          event: 'unauthorized',
        ),
        (label: '404', response: http.Response('{}', 404), event: 'not_found'),
        (
          label: 'inactive authority',
          response: http.Response(
            '{"tracking":{"active":false,"requestId":"MOE-1001",'
            '"status":"completed","onTheWayCadenceMs":15000,'
            '"inProgressCadenceMs":60000}}',
            200,
            headers: const {'content-type': 'application/json; charset=utf-8'},
          ),
          event: 'inactive',
        ),
      ]) {
    test(
      'a delayed old authority ${terminalCase.label} cannot tear down a fresh generation',
      () async {
        initializeProviderTrackingForegroundTask();
        final serviceAuthority = _ImmediateServiceAuthority();
        final authority = _status();
        final events = <ProviderTrackingRuntimeEvent>[];
        final getStarted = Completer<void>();
        final releaseGet = Completer<http.Response>();
        var postAttempts = 0;
        final worker = ProviderTrackingTaskHandler(
          client: MockClient((request) async {
            if (request.method == 'POST') {
              postAttempts += 1;
              throw StateError('network unavailable');
            }
            if (!getStarted.isCompleted) getStarted.complete();
            return releaseGet.future;
          }),
          authorityRetryDelays: const [Duration.zero],
          wait: (_) async {},
          serviceAuthority: serviceAuthority,
        );
        foreground
          ..handler = worker
          ..deliverTaskMessages = true;
        final runtime = FlutterProviderTrackingRuntime(
          baseUrl: 'https://api.example.test',
          onEvent: events.add,
          shouldProbePlatformService: () => true,
          serviceAuthority: serviceAuthority,
        );
        final coordinator = ProviderTrackingRecoveryCoordinator(
          api: _ActiveTrackingApi(authority),
          runtime: runtime,
        );

        expect(
          await coordinator.reconcile(
            token: 'provider-session',
            requestIds: const ['MOE-1001'],
          ),
          ProviderTrackingRecoveryResult.active,
        );
        final firstGeneration = _generationOf(foreground.taskMessages.single);
        await _settle();
        geolocatorPlatform.emitPosition();
        await getStarted.future;
        await _settle();

        expect(postAttempts, 1);
        expect(await runtime.isRunning(), isFalse);
        expect(geolocatorPlatform.activePositionStreams, 0);

        expect(
          await coordinator.reconcile(
            token: 'provider-session',
            requestIds: const ['MOE-1001'],
          ),
          ProviderTrackingRecoveryResult.active,
        );
        await _settle();
        final replacementGeneration = _generationOf(
          foreground.taskMessages.last,
        );

        expect(replacementGeneration, isNot(firstGeneration));
        expect(foreground.taskMessages, hasLength(2));
        expect(geolocatorPlatform.positionStreamCalls, 2);
        expect(geolocatorPlatform.activePositionStreams, 1);
        expect(foreground.running, isTrue);
        expect(await runtime.isRunning(), isTrue);

        releaseGet.complete(terminalCase.response);
        await _settle(12);

        expect(
          events.where(
            (event) =>
                event.generation == replacementGeneration &&
                const {
                  'unauthorized',
                  'not_found',
                  'inactive',
                  'location_unavailable',
                  'network',
                  'stopped',
                }.contains(event.type),
          ),
          isEmpty,
        );
        expect(
          serviceAuthority.stoppedGenerations,
          isNot(contains(replacementGeneration)),
        );
        expect(foreground.stopCalls, 0);
        expect(foreground.running, isTrue);
        expect(geolocatorPlatform.positionStreamCalls, 2);
        expect(geolocatorPlatform.activePositionStreams, 1);
        expect(await runtime.isRunning(), isTrue);

        // The generation-2 stream remains live, but its immediate coordinate is
        // still inside the generation-1 cadence window and must not POST.
        geolocatorPlatform.emitPosition();
        await _settle();
        expect(postAttempts, 1);
      },
    );

    test(
      'a current authority ${terminalCase.label} still tears down its generation',
      () async {
        initializeProviderTrackingForegroundTask();
        final serviceAuthority = _ImmediateServiceAuthority();
        final events = <ProviderTrackingRuntimeEvent>[];
        final worker = ProviderTrackingTaskHandler(
          client: MockClient((request) async {
            if (request.method == 'POST') {
              throw StateError('network unavailable');
            }
            return terminalCase.response;
          }),
          authorityRetryDelays: const [Duration.zero],
          wait: (_) async {},
          serviceAuthority: serviceAuthority,
        );
        foreground
          ..handler = worker
          ..deliverTaskMessages = true;
        final runtime = FlutterProviderTrackingRuntime(
          baseUrl: 'https://api.example.test',
          onEvent: events.add,
          shouldProbePlatformService: () => true,
          serviceAuthority: serviceAuthority,
        );

        await runtime.start(_status(), 'provider-session');
        final generation = _generationOf(foreground.taskMessages.single);
        await _settle();
        geolocatorPlatform.emitPosition();
        await _settle(12);

        expect(serviceAuthority.stoppedGenerations, [generation]);
        expect(foreground.stopCalls, 1);
        expect(foreground.running, isFalse);
        expect(geolocatorPlatform.activePositionStreams, 0);
        expect(await runtime.isRunning(), isFalse);
        expect(
          events,
          contains(
            isA<ProviderTrackingRuntimeEvent>()
                .having((event) => event.type, 'type', terminalCase.event)
                .having((event) => event.generation, 'generation', generation),
          ),
        );
      },
    );
  }

  test(
    'a fresh generation collects while the previous generation POST remains pending',
    () async {
      initializeProviderTrackingForegroundTask();
      final serviceAuthority = _ImmediateServiceAuthority();
      final firstPostStarted = Completer<void>();
      final releaseFirstPost = Completer<http.Response>();
      final requests = <http.Request>[];
      final worker = ProviderTrackingTaskHandler(
        client: MockClient((request) async {
          if (request.method != 'POST') return http.Response('{}', 200);
          requests.add(request);
          if (requests.length == 1) {
            firstPostStarted.complete();
            return releaseFirstPost.future;
          }
          return http.Response('{}', 201);
        }),
        serviceAuthority: serviceAuthority,
      );
      foreground
        ..handler = worker
        ..deliverTaskMessages = true;
      final firstRuntime = FlutterProviderTrackingRuntime(
        baseUrl: 'https://api.example.test',
        onEvent: (_) {},
        shouldProbePlatformService: () => true,
        serviceAuthority: serviceAuthority,
      );
      final replacementRuntime = FlutterProviderTrackingRuntime(
        baseUrl: 'https://api.example.test',
        onEvent: (_) {},
        shouldProbePlatformService: () => true,
        serviceAuthority: serviceAuthority,
      );

      await firstRuntime.start(_status(), 'provider-session');
      await _settle();
      geolocatorPlatform.emitPosition();
      await firstPostStarted.future;

      await replacementRuntime.start(
        _status(requestId: 'MOE-2002'),
        'provider-session',
      );
      expect(await replacementRuntime.isRunning(), isTrue);
      geolocatorPlatform.emitPosition();
      await _settle();

      expect(requests, hasLength(2));
      expect(
        requests.last.url.path,
        '/provider/service-requests/MOE-2002/location',
      );

      releaseFirstPost.complete(http.Response('{}', 201));
      await _settle();
      await firstRuntime.dispose();
      await replacementRuntime.dispose();
    },
  );

  for (final postFailure in <({String label, int? statusCode})>[
    (label: 'transport failure', statusCode: null),
    (label: '5xx response', statusCode: 500),
    (label: 'rejected response', statusCode: 409),
  ]) {
    test(
      'a stale delayed POST ${postFailure.label} cannot pause a replacement generation',
      () async {
        initializeProviderTrackingForegroundTask();
        final serviceAuthority = _DelayedServiceAuthority();
        final authority = _status();
        final events = <ProviderTrackingRuntimeEvent>[];
        final postStarted = Completer<void>();
        final releasePost = Completer<http.Response>();
        var postAttempts = 0;
        final worker = ProviderTrackingTaskHandler(
          client: MockClient((request) async {
            if (request.method == 'POST') {
              postAttempts += 1;
              if (!postStarted.isCompleted) postStarted.complete();
              return releasePost.future;
            }
            return http.Response(
              '{"tracking":{"active":true,"requestId":"MOE-1001",'
              '"status":"on_the_way","onTheWayCadenceMs":15000,'
              '"inProgressCadenceMs":60000}}',
              200,
              headers: const {
                'content-type': 'application/json; charset=utf-8',
              },
            );
          }),
          authorityRetryDelays: const [Duration.zero],
          wait: (_) async {},
          serviceAuthority: serviceAuthority,
        );
        foreground
          ..handler = worker
          ..deliverTaskMessages = true;
        final runtime = FlutterProviderTrackingRuntime(
          baseUrl: 'https://api.example.test',
          onEvent: events.add,
          shouldProbePlatformService: () => true,
          serviceAuthority: serviceAuthority,
        );
        final coordinator = ProviderTrackingRecoveryCoordinator(
          api: _ActiveTrackingApi(authority),
          runtime: runtime,
        );

        expect(
          await coordinator.reconcile(
            token: 'provider-session',
            requestIds: const ['MOE-1001'],
          ),
          ProviderTrackingRecoveryResult.active,
        );
        final firstGeneration = _generationOf(foreground.taskMessages.single);
        await _settle();
        geolocatorPlatform.emitPosition();
        await postStarted.future;

        // A concurrent generation-1 stream failure starts terminal teardown,
        // but its native ownership decision remains delayed while the POST is
        // still in flight.
        geolocatorPlatform.failLatestStream();
        await serviceAuthority.firstStopStarted.future;
        await _settle();
        expect(geolocatorPlatform.activePositionStreams, 0);
        expect(await runtime.isRunning(), isFalse);

        // Fresh authenticated authority adopts the surviving FGS on the actual
        // handler and acknowledges exactly one generation-2 collector.
        expect(
          await coordinator.reconcile(
            token: 'provider-session',
            requestIds: const ['MOE-1001'],
          ),
          ProviderTrackingRecoveryResult.active,
        );
        await _settle();
        final replacementGeneration = _generationOf(
          foreground.taskMessages.last,
        );
        expect(replacementGeneration, isNot(firstGeneration));
        expect(foreground.taskMessages, hasLength(2));
        expect(geolocatorPlatform.positionStreamCalls, 2);
        expect(geolocatorPlatform.activePositionStreams, 1);
        expect(foreground.running, isTrue);
        expect(await runtime.isRunning(), isTrue);

        // Generation 1 loses the final native check. Only then does its old
        // delayed POST return a representative failure.
        serviceAuthority.releaseFirstStop();
        await _settle();
        expect(serviceAuthority.staleStops, 1);
        final statusCode = postFailure.statusCode;
        if (statusCode == null) {
          releasePost.completeError(StateError('network unavailable'));
        } else {
          releasePost.complete(http.Response('{}', statusCode));
        }
        await _settle(12);

        expect(
          events.where(
            (event) =>
                event.generation == replacementGeneration &&
                const {
                  'collector_paused',
                  'unauthorized',
                  'not_found',
                  'inactive',
                  'location_unavailable',
                  'network',
                  'stopped',
                }.contains(event.type),
          ),
          isEmpty,
        );
        expect(
          serviceAuthority.stoppedGenerations,
          isNot(contains(replacementGeneration)),
        );
        expect(foreground.stopCalls, 0);
        expect(foreground.startCalls, 1);
        expect(foreground.running, isTrue);
        expect(geolocatorPlatform.positionStreamCalls, 2);
        expect(geolocatorPlatform.activePositionStreams, 1);
        expect(await runtime.isRunning(), isTrue);

        // The old request has completed, so this emission reaches generation 2.
        // Its inherited cadence marker must still prevent an immediate catch-up
        // coordinate after replacement.
        geolocatorPlatform.emitPosition();
        await _settle();
        expect(postAttempts, 1);
      },
    );
  }

  test(
    'a current-generation delayed 5xx pauses immediately and tears down after bounded recovery',
    () async {
      initializeProviderTrackingForegroundTask();
      final serviceAuthority = _ImmediateServiceAuthority();
      final events = <ProviderTrackingRuntimeEvent>[];
      final postStarted = Completer<void>();
      final releasePost = Completer<http.Response>();
      final getStarted = Completer<void>();
      final releaseGet = Completer<http.Response>();
      final worker = ProviderTrackingTaskHandler(
        client: MockClient((request) async {
          if (request.method == 'POST') {
            postStarted.complete();
            return releasePost.future;
          }
          if (!getStarted.isCompleted) getStarted.complete();
          return releaseGet.future;
        }),
        authorityRetryDelays: const [Duration.zero],
        wait: (_) async {},
        serviceAuthority: serviceAuthority,
      );
      foreground
        ..handler = worker
        ..deliverTaskMessages = true;
      final runtime = FlutterProviderTrackingRuntime(
        baseUrl: 'https://api.example.test',
        onEvent: events.add,
        shouldProbePlatformService: () => true,
        serviceAuthority: serviceAuthority,
      );

      await runtime.start(_status(), 'provider-session');
      final generation = _generationOf(foreground.taskMessages.single);
      await _settle();
      geolocatorPlatform.emitPosition();
      await postStarted.future;
      releasePost.complete(http.Response('{}', 500));
      await getStarted.future;
      await _settle();

      expect(geolocatorPlatform.positionStreamCancelCalls, 1);
      expect(geolocatorPlatform.activePositionStreams, 0);
      expect(await runtime.isRunning(), isFalse);
      expect(
        events,
        contains(
          isA<ProviderTrackingRuntimeEvent>()
              .having((event) => event.type, 'type', 'collector_paused')
              .having((event) => event.generation, 'generation', generation),
        ),
      );

      releaseGet.complete(http.Response('{}', 500));
      await _settle(12);

      expect(serviceAuthority.stoppedGenerations, [generation]);
      expect(foreground.stopCalls, 1);
      expect(foreground.running, isFalse);
      expect(await runtime.isRunning(), isFalse);
      expect(
        events,
        contains(
          isA<ProviderTrackingRuntimeEvent>()
              .having((event) => event.type, 'type', 'network')
              .having((event) => event.generation, 'generation', generation),
        ),
      );
    },
  );

  test(
    'network retry exhaustion stops its preserved generation before fresh active recovery starts one collector',
    () async {
      initializeProviderTrackingForegroundTask();
      final serviceAuthority = _ImmediateServiceAuthority();
      final authority = _status();
      final runtime = FlutterProviderTrackingRuntime(
        baseUrl: 'https://api.example.test',
        onEvent: (_) {},
        serviceAuthority: serviceAuthority,
      );
      final coordinator = ProviderTrackingRecoveryCoordinator(
        api: _ActiveTrackingApi(authority),
        runtime: runtime,
      );

      expect(
        await coordinator.reconcile(
          token: 'provider-session',
          requestIds: const ['MOE-1001'],
        ),
        ProviderTrackingRecoveryResult.active,
      );
      final firstConfiguration = Map<String, Object>.from(
        foreground.taskMessages.single as Map,
      );
      final firstGeneration = _generationOf(firstConfiguration);
      final failedWorker = ProviderTrackingTaskHandler(
        client: MockClient(
          (_) async => throw StateError('network unavailable'),
        ),
        authorityRetryDelays: const [Duration.zero],
        wait: (_) async {},
        serviceAuthority: serviceAuthority,
      );
      failedWorker.onReceiveData(firstConfiguration);
      await _settle();

      geolocatorPlatform.emitPosition();
      await _settle(12);

      expect(serviceAuthority.stoppedGenerations, [firstGeneration]);
      expect(foreground.stopCalls, 1);
      expect(foreground.running, isFalse);
      expect(geolocatorPlatform.positionStreamCancelCalls, 1);

      expect(
        await coordinator.reconcile(
          token: 'provider-session',
          requestIds: const ['MOE-1001'],
        ),
        ProviderTrackingRecoveryResult.active,
      );

      expect(foreground.startCalls, 2);
      expect(foreground.running, isTrue);
      expect(foreground.taskMessages, hasLength(2));
      final replacementConfiguration = Map<String, Object>.from(
        foreground.taskMessages.last as Map,
      );
      expect(_generationOf(replacementConfiguration), isNot(firstGeneration));

      var replacementPosts = 0;
      final replacementWorker = ProviderTrackingTaskHandler(
        client: MockClient((request) async {
          if (request.method == 'POST') replacementPosts += 1;
          return http.Response('{}', 201);
        }),
        serviceAuthority: serviceAuthority,
      );
      replacementWorker.onReceiveData(replacementConfiguration);
      await _settle();
      geolocatorPlatform.emitPosition();
      await _settle();

      expect(geolocatorPlatform.positionStreamCalls, 2);
      expect(replacementPosts, 0);
    },
  );

  test(
    'a delayed old worker stop cannot tear down a freshly configured replacement',
    () async {
      foreground
        ..invokeCallbackOnStart = true
        ..deliverTaskMessages = true
        ..invokeDestroyOnStop = true;
      geolocatorPlatform.delayFirstCancellation();
      final runtime = FlutterProviderTrackingRuntime(
        baseUrl: 'https://api.example.test',
        onEvent: (_) {},
      );

      await runtime.start(_status(), 'provider-session');
      await _settle();
      expect(geolocatorPlatform.positionStreamCalls, 1);

      await runtime.stop();
      await runtime.start(_status(), 'provider-session');
      await _settle();

      expect(foreground.startCalls, 2);
      expect(foreground.stopCalls, 1);
      expect(foreground.running, isTrue);
      expect(geolocatorPlatform.positionStreamCalls, 2);

      geolocatorPlatform.releaseFirstCancellation();
      await _settle();

      expect(foreground.stopCalls, 1);
      expect(foreground.running, isTrue);
      expect(geolocatorPlatform.positionStreamCancelCalls, 1);
    },
  );

  test(
    'a delayed terminal teardown cannot stop a replacement recovered from fresh authority',
    () async {
      initializeProviderTrackingForegroundTask();
      final serviceAuthority = _DelayedServiceAuthority();
      final authority = _status();
      final events = <ProviderTrackingRuntimeEvent>[];
      var originalPosts = 0;
      var replacementPosts = 0;
      var replacementConfigured = false;
      final oldWorker = ProviderTrackingTaskHandler(
        client: MockClient((request) async {
          if (request.method == 'POST') {
            if (replacementConfigured) {
              replacementPosts += 1;
            } else {
              originalPosts += 1;
            }
          }
          return http.Response('{}', 201);
        }),
        serviceAuthority: serviceAuthority,
      );
      foreground
        ..handler = oldWorker
        ..deliverTaskMessages = true;
      final runtime = FlutterProviderTrackingRuntime(
        baseUrl: 'https://api.example.test',
        onEvent: events.add,
        shouldProbePlatformService: () => true,
        serviceAuthority: serviceAuthority,
      );
      final coordinator = ProviderTrackingRecoveryCoordinator(
        api: _ActiveTrackingApi(authority),
        runtime: runtime,
      );

      expect(
        await coordinator.reconcile(
          token: 'provider-session',
          requestIds: const ['MOE-1001'],
        ),
        ProviderTrackingRecoveryResult.active,
      );
      final oldConfiguration = Map<String, Object>.from(
        foreground.taskMessages.single as Map,
      );
      await _settle();
      expect(geolocatorPlatform.positionStreamCalls, 1);
      expect(geolocatorPlatform.activePositionStreams, 1);

      // Seed the runtime and surviving worker with an accepted cadence marker.
      // The recovered generation must not turn its immediate stream emission
      // into a speculative or catch-up coordinate.
      geolocatorPlatform.emitPosition();
      await _settle();
      expect(originalPosts, 1);

      // Generation 1 stops collecting and notifies the main isolate, but its
      // final native generation-owned stop decision is delayed.
      geolocatorPlatform.failLatestStream();
      await serviceAuthority.firstStopStarted.future;
      await _settle();
      expect(foreground.stopCalls, 0);
      expect(events, hasLength(1));
      expect(events.single.type, 'location_unavailable');
      expect(geolocatorPlatform.activePositionStreams, 0);

      // Fresh trusted authority sends generation 2 to the actual surviving old
      // handler. That handler must acknowledge one real replacement collector,
      // not merely leave the main runtime believing its configure send worked.
      replacementConfigured = true;
      expect(
        await coordinator.reconcile(
          token: 'provider-session',
          requestIds: const ['MOE-1001'],
        ),
        ProviderTrackingRecoveryResult.active,
      );
      await _settle();
      expect(foreground.startCalls, 1);
      expect(foreground.running, isTrue);
      expect(foreground.taskMessages, hasLength(2));
      expect(
        _generationOf(foreground.taskMessages.last),
        isNot(_generationOf(oldConfiguration)),
      );
      expect(geolocatorPlatform.positionStreamCalls, 2);
      expect(geolocatorPlatform.activePositionStreams, 1);
      expect(await runtime.isRunning(), isTrue);

      geolocatorPlatform.emitPosition();
      await _settle();
      expect(replacementPosts, 0);

      // Generation 1 now loses the native ownership comparison and cannot
      // invoke the process-global stop against generation 2.
      serviceAuthority.releaseFirstStop();
      await _settle();

      expect(foreground.stopCalls, 0);
      expect(foreground.startCalls, 1);
      expect(foreground.running, isTrue);
      expect(geolocatorPlatform.activePositionStreams, 1);
      expect(await runtime.isRunning(), isTrue);
      expect(serviceAuthority.staleStops, 1);
    },
  );

  test(
    'current generation stop waits for native teardown completion',
    () async {
      initializeProviderTrackingForegroundTask();
      final serviceAuthority = _QueuedStopServiceAuthority();
      foreground
        ..handler = ProviderTrackingTaskHandler(
          serviceAuthority: serviceAuthority,
        )
        ..deliverTaskMessages = true;
      final runtime = FlutterProviderTrackingRuntime(
        baseUrl: 'https://api.example.test',
        onEvent: (_) {},
        shouldProbePlatformService: () => true,
        serviceAuthority: serviceAuthority,
      );

      await runtime.start(_status(), 'provider-session');
      final stop = runtime.stop();
      await serviceAuthority.stopStarted.future;
      serviceAuthority.releaseStopResponse();
      Timer(const Duration(milliseconds: 20), () => foreground.running = false);

      await stop;
      expect(foreground.running, isFalse);
    },
  );

  test('same generation stop is idempotent and stops only once', () async {
    final serviceAuthority = _ImmediateServiceAuthority();
    final runtime = FlutterProviderTrackingRuntime(
      baseUrl: 'https://api.example.test',
      onEvent: (_) {},
      serviceAuthority: serviceAuthority,
    );

    await runtime.start(_status(), 'provider-session');
    await runtime.stop();
    await runtime.stop();

    expect(foreground.stopCalls, 1);
    expect(foreground.running, isFalse);
    expect(serviceAuthority.zeroAuthorityStops, 0);
  });

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
        'generation': _generationOf(foreground.taskMessages.last),
        'requestId': 'MOE-1001',
        'capturedAt': collectedAt.toIso8601String(),
      });
      FlutterForegroundTask.dataCallbacks.single({
        'event': 'network',
        'generation': _generationOf(foreground.taskMessages.last),
        'requestId': 'MOE-1001',
      });
      await runtime.start(_status(), 'provider-session');

      expect(foreground.startCalls, 2);
      expect(_withoutGeneration(foreground.taskMessages.last), {
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
        'generation': _generationOf(foreground.taskMessages.last),
        'requestId': 'MOE-1001',
        'capturedAt': collectedAt.toIso8601String(),
      });
      await runtime.stop();
      await runtime.start(_status(requestId: 'MOE-1002'), 'provider-session');

      expect(_withoutGeneration(foreground.taskMessages.last), {
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
      final oldGeneration = _generationOf(foreground.taskMessages.last);
      await runtime.stop();
      await runtime.start(_status(requestId: 'MOE-1002'), 'provider-session');
      FlutterForegroundTask.dataCallbacks.single({
        'event': 'sample_collected',
        'generation': oldGeneration,
        'requestId': 'MOE-1001',
        'capturedAt': collectedAt.toIso8601String(),
      });
      await runtime.update(
        _status(requestId: 'MOE-1002', status: 'in_progress'),
        'provider-session',
      );

      expect(_withoutGeneration(foreground.taskMessages.last), {
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
      final generation = _generationOf(foreground.taskMessages.last);

      await runtime.update(
        _status(status: 'in_progress'),
        'replacement-session',
      );
      await runtime.clearQueue();
      FlutterForegroundTask.dataCallbacks.single({
        'event': 'network',
        'generation': generation,
        'requestId': 'MOE-1001',
      });
      FlutterForegroundTask.dataCallbacks.single({'event': 8, 'requestId': ''});
      // The real worker sends this terminal event immediately before it stops
      // its own service. Model the completed worker teardown before the main
      // isolate's follow-up stop check, so no duplicate service is created.
      foreground.running = false;
      await runtime.stop();
      await runtime.dispose();

      expect(foreground.taskMessages.map(_withoutGeneration).toList(), [
        isA<Map<String, Object?>>(),
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
    'fresh runtime adopts an inherited foreground service without another Android service start',
    () async {
      initializeProviderTrackingForegroundTask();
      foreground
        ..running = true
        ..handler = ProviderTrackingTaskHandler()
        ..deliverTaskMessages = true;
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
      expect(foreground.updateCalls, 0);
      expect(foreground.running, isTrue);
      expect(foreground.taskMessages.map(_withoutGeneration).toList(), [
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

Map<String, Object?> _withoutGeneration(Object message) {
  final normalized = Map<String, Object?>.from(message as Map);
  normalized.remove('generation');
  return normalized;
}

String _generationOf(Object message) =>
    (message as Map<Object?, Object?>)['generation']! as String;

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

class _QueuedStopServiceAuthority extends _ImmediateServiceAuthority {
  final Completer<void> stopStarted = Completer<void>();
  final Completer<void> _releaseStopResponse = Completer<void>();

  @override
  Future<ProviderTrackingServiceStopResult> stopGeneration(
    String generation,
  ) async {
    stopStarted.complete();
    await _releaseStopResponse.future;
    return ProviderTrackingServiceStopResult.requested;
  }

  void releaseStopResponse() => _releaseStopResponse.complete();
}

class _ImmediateServiceAuthority implements ProviderTrackingServiceAuthority {
  String? _runtimeId;
  int _runtimeEpoch = 0;
  String? _generation;
  String? _stoppedGeneration;
  int zeroAuthorityStops = 0;
  final List<String> stoppedGenerations = <String>[];

  @override
  Future<int> beginRuntime(
    String runtimeId, {
    required int runtimeSequence,
  }) async {
    _runtimeId = runtimeId;
    _runtimeEpoch += 1;
    return _runtimeEpoch;
  }

  @override
  Future<bool> claimGeneration({
    required String runtimeId,
    required int runtimeEpoch,
    required String generation,
  }) async {
    if (runtimeId != _runtimeId || runtimeEpoch != _runtimeEpoch) return false;
    _generation = generation;
    return true;
  }

  @override
  Future<bool> ownsGeneration(String generation) async =>
      _generation == generation;

  @override
  Future<void> releaseGeneration(String generation) async {
    if (_generation == generation) _generation = null;
  }

  @override
  Future<ProviderTrackingServiceStopResult> stopGeneration(
    String generation,
  ) async {
    if (_stoppedGeneration == generation) {
      return ProviderTrackingServiceStopResult.alreadyStopped;
    }
    if (_generation != generation) {
      return ProviderTrackingServiceStopResult.stale;
    }
    _generation = null;
    _stoppedGeneration = generation;
    stoppedGenerations.add(generation);
    await FlutterForegroundTask.stopService();
    return ProviderTrackingServiceStopResult.requested;
  }

  @override
  Future<ProviderTrackingServiceStopResult> stopForZeroAuthority({
    required String runtimeId,
    required int runtimeEpoch,
    required String stopRequestId,
  }) async {
    if (runtimeId != _runtimeId || runtimeEpoch != _runtimeEpoch) {
      return ProviderTrackingServiceStopResult.stale;
    }
    zeroAuthorityStops += 1;
    return ProviderTrackingServiceStopResult.alreadyStopped;
  }
}

class _DelayedServiceAuthority implements ProviderTrackingServiceAuthority {
  final Completer<void> firstStopStarted = Completer<void>();
  final Completer<void> _releaseFirstStop = Completer<void>();
  String? _runtimeId;
  int _runtimeEpoch = 0;
  String? _generation;
  bool _delayedFirstStop = false;
  int staleStops = 0;
  final List<String> stoppedGenerations = <String>[];

  @override
  Future<int> beginRuntime(
    String runtimeId, {
    required int runtimeSequence,
  }) async {
    _runtimeId = runtimeId;
    _runtimeEpoch += 1;
    return _runtimeEpoch;
  }

  @override
  Future<bool> claimGeneration({
    required String runtimeId,
    required int runtimeEpoch,
    required String generation,
  }) async {
    if (runtimeId != _runtimeId || runtimeEpoch != _runtimeEpoch) return false;
    _generation = generation;
    return true;
  }

  @override
  Future<bool> ownsGeneration(String generation) async =>
      _generation == generation;

  @override
  Future<void> releaseGeneration(String generation) async {
    if (_generation == generation) _generation = null;
  }

  @override
  Future<ProviderTrackingServiceStopResult> stopGeneration(
    String generation,
  ) async {
    if (!_delayedFirstStop) {
      _delayedFirstStop = true;
      firstStopStarted.complete();
      await _releaseFirstStop.future;
    }
    if (_generation != generation) {
      staleStops += 1;
      return ProviderTrackingServiceStopResult.stale;
    }
    _generation = null;
    stoppedGenerations.add(generation);
    await FlutterForegroundTask.stopService();
    return ProviderTrackingServiceStopResult.requested;
  }

  @override
  Future<ProviderTrackingServiceStopResult> stopForZeroAuthority({
    required String runtimeId,
    required int runtimeEpoch,
    required String stopRequestId,
  }) async {
    if (runtimeId != _runtimeId || runtimeEpoch != _runtimeEpoch) {
      return ProviderTrackingServiceStopResult.stale;
    }
    _generation = null;
    if (!await FlutterForegroundTask.isRunningService) {
      return ProviderTrackingServiceStopResult.alreadyStopped;
    }
    await FlutterForegroundTask.stopService();
    return ProviderTrackingServiceStopResult.requested;
  }

  void releaseFirstStop() {
    if (!_releaseFirstStop.isCompleted) _releaseFirstStop.complete();
  }
}

class _ForegroundPlatform extends FlutterForegroundTaskPlatform {
  bool running = false;
  bool failStart = false;
  bool failUpdate = false;
  bool failStop = false;
  int startCalls = 0;
  int updateCalls = 0;
  int stopCalls = 0;
  bool invokeCallbackOnStart = false;
  bool deliverTaskMessages = false;
  bool invokeDestroyOnStop = false;
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
    if (invokeCallbackOnStart) callback?.call();
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
    if (invokeDestroyOnStop) {
      final stoppedHandler = handler;
      handler = null;
      if (stoppedHandler != null) {
        unawaited(stoppedHandler.onDestroy(DateTime.utc(2026), false));
      }
    }
  }

  @override
  void sendDataToTask(Object data) {
    taskMessages.add(data);
    if (deliverTaskMessages) handler?.onReceiveData(data);
  }

  @override
  void setTaskHandler(TaskHandler value) => handler = value;
}

class _GeolocatorPlatform extends geolocator.GeolocatorPlatform {
  final List<StreamController<geolocator.Position>> _positionControllers = [];
  Completer<void>? _firstCancellation;
  bool serviceEnabled = true;
  geolocator.LocationPermission permission =
      geolocator.LocationPermission.whileInUse;
  geolocator.LocationPermission requestedPermission =
      geolocator.LocationPermission.whileInUse;
  int checkCalls = 0;
  int requestCalls = 0;
  int positionStreamCalls = 0;
  int positionStreamCancelCalls = 0;
  int activePositionStreams = 0;

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

  void delayFirstCancellation() {
    _firstCancellation = Completer<void>();
  }

  void releaseFirstCancellation() {
    final cancellation = _firstCancellation;
    if (cancellation != null && !cancellation.isCompleted) {
      cancellation.complete();
    }
  }

  void failLatestStream() {
    _positionControllers.last.addError(StateError('location stream failed'));
  }

  void emitPosition() {
    _positionControllers.last.add(
      geolocator.Position(
        latitude: 26.31,
        longitude: 43.98,
        timestamp: DateTime.now().toUtc(),
        accuracy: 9.5,
        altitude: 0,
        altitudeAccuracy: 0,
        heading: 0,
        headingAccuracy: 0,
        speed: 0,
        speedAccuracy: 0,
      ),
    );
  }

  @override
  Stream<geolocator.Position> getPositionStream({
    geolocator.LocationSettings? locationSettings,
  }) {
    positionStreamCalls += 1;
    activePositionStreams += 1;
    final streamIndex = _positionControllers.length;
    final controller = StreamController<geolocator.Position>.broadcast(
      onCancel: () async {
        positionStreamCancelCalls += 1;
        activePositionStreams -= 1;
        if (streamIndex == 0) await _firstCancellation?.future;
      },
    );
    _positionControllers.add(controller);
    return controller.stream;
  }

  Future<void> close() async {
    releaseFirstCancellation();
    for (final controller in _positionControllers) {
      await controller.close();
    }
  }
}

Future<void> _settle([int turns = 4]) async {
  for (var index = 0; index < turns; index += 1) {
    await Future<void>.delayed(Duration.zero);
  }
}
