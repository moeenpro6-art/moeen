import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:moeen_provider/provider_tracking.dart';

void main() {
  test(
    'cadence gate does not permit catch-up samples when server status changes',
    () {
      final gate = ProviderTrackingCadenceGate();
      final onTheWay = ProviderTrackingStatus(
        requestId: 'MOE-1001',
        active: true,
        status: 'on_the_way',
        onTheWayCadenceMs: 15000,
        inProgressCadenceMs: 60000,
      );
      final inProgress = ProviderTrackingStatus(
        requestId: 'MOE-1001',
        active: true,
        status: 'in_progress',
        onTheWayCadenceMs: 15000,
        inProgressCadenceMs: 60000,
      );
      final startedAt = DateTime.utc(2026, 8, 22, 10);

      expect(gate.shouldCollect(onTheWay, startedAt), isTrue);
      expect(
        gate.shouldCollect(
          onTheWay,
          startedAt.add(const Duration(seconds: 13)),
        ),
        isFalse,
      );
      expect(
        gate.shouldCollect(
          onTheWay,
          startedAt.add(const Duration(seconds: 15)),
        ),
        isTrue,
      );
      expect(
        gate.shouldCollect(
          inProgress,
          startedAt.add(const Duration(seconds: 74)),
        ),
        isFalse,
      );
      expect(
        gate.shouldCollect(
          inProgress,
          startedAt.add(const Duration(seconds: 75)),
        ),
        isTrue,
      );
    },
  );

  test(
    'cadence gate accepts bounded scheduler jitter instead of skipping a 15-second source event',
    () {
      final gate = ProviderTrackingCadenceGate();
      final onTheWay = ProviderTrackingStatus(
        requestId: 'MOE-1001',
        active: true,
        status: 'on_the_way',
        onTheWayCadenceMs: 15000,
        inProgressCadenceMs: 60000,
      );
      final startedAt = DateTime.utc(2026, 8, 22, 10);

      // Android may deliver the requested 15-second update slightly early. The
      // former exact threshold rejected 14,950 ms and waited for the 30,000 ms
      // event; the bounded allowance keeps samples near the server cadence.
      expect(gate.shouldCollect(onTheWay, startedAt), isTrue);
      expect(
        gate.shouldCollect(
          onTheWay,
          startedAt.add(const Duration(milliseconds: 14950)),
        ),
        isTrue,
      );
      // Once that near-boundary sample is accepted, another immediate event is
      // still rejected rather than becoming an outbound burst.
      expect(
        gate.shouldCollect(
          onTheWay,
          startedAt.add(const Duration(milliseconds: 15000)),
        ),
        isFalse,
      );
      expect(
        gate.shouldCollect(
          onTheWay,
          startedAt.add(const Duration(milliseconds: 30000)),
        ),
        isTrue,
      );
    },
  );

  test(
    'cadence gate still rejects events earlier than its bounded jitter allowance',
    () {
      final gate = ProviderTrackingCadenceGate();
      final onTheWay = ProviderTrackingStatus(
        requestId: 'MOE-1001',
        active: true,
        status: 'on_the_way',
        onTheWayCadenceMs: 15000,
        inProgressCadenceMs: 60000,
      );
      final startedAt = DateTime.utc(2026, 8, 22, 10);

      expect(gate.shouldCollect(onTheWay, startedAt), isTrue);
      expect(
        gate.shouldCollect(
          onTheWay,
          startedAt.add(const Duration(milliseconds: 13999)),
        ),
        isFalse,
      );
    },
  );

  test(
    'rejects active authority for a non-trackable server status before any runtime can start',
    () {
      expect(
        () => ProviderTrackingStatus.fromJson(const {
          'requestId': 'MOE-1001',
          'active': true,
          'status': 'assigned',
          'onTheWayCadenceMs': 15000,
          'inProgressCadenceMs': 60000,
        }),
        throwsA(isA<ProviderTrackingProtocolException>()),
      );
    },
  );

  test(
    'recovery stops the collector and never starts location collection when every server status is inactive',
    () async {
      final api = _FakeTrackingApi({
        'MOE-1001': ProviderTrackingStatus(
          requestId: 'MOE-1001',
          active: false,
          status: 'assigned',
          onTheWayCadenceMs: 15000,
          inProgressCadenceMs: 60000,
        ),
      });
      final runtime = _FakeTrackingRuntime();
      final coordinator = ProviderTrackingRecoveryCoordinator(
        api: api,
        runtime: runtime,
      );

      final result = await coordinator.reconcile(
        token: 'provider-session',
        requestIds: const ['MOE-1001'],
      );

      expect(result, ProviderTrackingRecoveryResult.inactive);
      expect(runtime.stopCalls, 1);
      expect(runtime.started, isEmpty);
    },
  );

  test(
    'recovery fails closed during a transport failure and starts only after a bounded authority retry succeeds',
    () async {
      var authorityReads = 0;
      final runtime = _FakeTrackingRuntime();
      final coordinator = ProviderTrackingRecoveryCoordinator(
        api: _FakeTrackingApiLoader((_) async {
          authorityReads += 1;
          if (authorityReads == 1) {
            throw const ProviderTrackingTransportException();
          }
          return ProviderTrackingStatus(
            requestId: 'MOE-1001',
            active: true,
            status: 'on_the_way',
            onTheWayCadenceMs: 15000,
            inProgressCadenceMs: 60000,
          );
        }),
        runtime: runtime,
        retryDelays: const [Duration.zero],
        wait: (_) async {},
      );

      final result = await coordinator.reconcile(
        token: 'provider-session',
        requestIds: const ['MOE-1001'],
      );

      expect(result, ProviderTrackingRecoveryResult.active);
      expect(authorityReads, 2);
      expect(runtime.stopCalls, 1);
      expect(runtime.clearQueueCalls, 1);
      expect(runtime.started, hasLength(1));
      expect(runtime.started.single.requestId, 'MOE-1001');
    },
  );

  test(
    'exhausted authority retries report network failure with collection off',
    () async {
      final runtime = _FakeTrackingRuntime();
      final coordinator = ProviderTrackingRecoveryCoordinator(
        api: _FakeTrackingApiLoader(
          (_) async => throw const ProviderTrackingTransportException(),
        ),
        runtime: runtime,
        retryDelays: const [Duration.zero, Duration.zero],
        wait: (_) async {},
      );

      final result = await coordinator.reconcile(
        token: 'provider-session',
        requestIds: const ['MOE-1001'],
      );

      expect(result, ProviderTrackingRecoveryResult.networkFailure);
      expect(runtime.started, isEmpty);
      expect(runtime.stopCalls, 1);
      expect(runtime.clearQueueCalls, 1);
    },
  );

  test(
    'a missing authority stops and clears before request state refresh',
    () async {
      final runtime = _FakeTrackingRuntime();
      final coordinator = ProviderTrackingRecoveryCoordinator(
        api: _FakeTrackingApiLoader(
          (_) async => throw const ProviderTrackingNotFoundException(),
        ),
        runtime: runtime,
      );

      final result = await coordinator.reconcile(
        token: 'provider-session',
        requestIds: const ['MOE-1001'],
      );

      expect(result, ProviderTrackingRecoveryResult.notFound);
      expect(runtime.started, isEmpty);
      expect(runtime.stopCalls, 1);
      expect(runtime.clearQueueCalls, 1);
    },
  );

  test(
    'multiple active server authorities report conflict with collection off',
    () async {
      final runtime = _FakeTrackingRuntime();
      final coordinator = ProviderTrackingRecoveryCoordinator(
        api: _FakeTrackingApi({
          'MOE-1001': ProviderTrackingStatus(
            requestId: 'MOE-1001',
            active: true,
            status: 'on_the_way',
            onTheWayCadenceMs: 15000,
            inProgressCadenceMs: 60000,
          ),
          'MOE-1002': ProviderTrackingStatus(
            requestId: 'MOE-1002',
            active: true,
            status: 'in_progress',
            onTheWayCadenceMs: 15000,
            inProgressCadenceMs: 60000,
          ),
        }),
        runtime: runtime,
      );

      final result = await coordinator.reconcile(
        token: 'provider-session',
        requestIds: const ['MOE-1001', 'MOE-1002'],
      );

      expect(result, ProviderTrackingRecoveryResult.conflict);
      expect(runtime.started, isEmpty);
      expect(runtime.stopCalls, 1);
      expect(runtime.clearQueueCalls, 1);
    },
  );

  test(
    'repeated unchanged reconciliation leaves one live collector untouched',
    () async {
      final authority = _activeStatus();
      final runtime = _FakeTrackingRuntime();
      final coordinator = ProviderTrackingRecoveryCoordinator(
        api: _FakeTrackingApi({'MOE-1001': authority}),
        runtime: runtime,
      );

      await coordinator.reconcile(
        token: 'provider-session',
        requestIds: const ['MOE-1001'],
      );
      await coordinator.reconcile(
        token: 'provider-session',
        requestIds: const ['MOE-1001'],
      );

      expect(runtime.started, [authority]);
      expect(runtime.updated, isEmpty);
      expect(runtime.stopCalls, 0);
      expect(runtime.clearQueueCalls, 0);
    },
  );

  test(
    'an authorized cadence transition updates one existing collector in place',
    () async {
      final onTheWay = _activeStatus();
      final inProgress = ProviderTrackingStatus(
        requestId: 'MOE-1001',
        active: true,
        status: 'in_progress',
        onTheWayCadenceMs: 15000,
        inProgressCadenceMs: 60000,
      );
      var reads = 0;
      final runtime = _FakeTrackingRuntime();
      final coordinator = ProviderTrackingRecoveryCoordinator(
        api: _FakeTrackingApiLoader(
          (_) async => ++reads == 1 ? onTheWay : inProgress,
        ),
        runtime: runtime,
      );

      await coordinator.reconcile(
        token: 'provider-session',
        requestIds: const ['MOE-1001'],
      );
      await coordinator.reconcile(
        token: 'provider-session',
        requestIds: const ['MOE-1001'],
      );

      expect(runtime.started, [onTheWay]);
      expect(runtime.updated, [inProgress]);
      expect(runtime.stopCalls, 0);
      expect(runtime.clearQueueCalls, 0);
    },
  );

  test(
    'overlapping refresh reconciliation serializes authority reads and starts one collector',
    () async {
      final authority = _activeStatus();
      final firstAuthorityRead = Completer<ProviderTrackingStatus>();
      var reads = 0;
      final runtime = _FakeTrackingRuntime();
      final coordinator = ProviderTrackingRecoveryCoordinator(
        api: _FakeTrackingApiLoader((_) {
          reads += 1;
          return firstAuthorityRead.future;
        }),
        runtime: runtime,
      );

      final first = coordinator.reconcile(
        token: 'provider-session',
        requestIds: const ['MOE-1001'],
      );
      final second = coordinator.reconcile(
        token: 'provider-session',
        requestIds: const ['MOE-1001'],
      );
      await Future<void>.delayed(Duration.zero);

      expect(reads, 1);
      firstAuthorityRead.complete(authority);
      await Future.wait([first, second]);

      expect(reads, 2);
      expect(runtime.started, [authority]);
      expect(runtime.updated, isEmpty);
      expect(runtime.stopCalls, 0);
    },
  );

  test(
    'a transport ambiguity stops a live collector before retrying authority',
    () async {
      final retryGate = Completer<void>();
      final runtime = _FakeTrackingRuntime()..running = true;
      final coordinator = ProviderTrackingRecoveryCoordinator(
        api: _FakeTrackingApiLoader(
          (_) async => throw const ProviderTrackingTransportException(),
        ),
        runtime: runtime,
        retryDelays: const [Duration.zero],
        wait: (_) => retryGate.future,
      );

      final reconciliation = coordinator.reconcile(
        token: 'provider-session',
        requestIds: const ['MOE-1001'],
      );
      await Future<void>.delayed(Duration.zero);

      expect(runtime.stopCalls, 1);
      expect(runtime.clearQueueCalls, 1);
      retryGate.complete();
      expect(
        await reconciliation,
        ProviderTrackingRecoveryResult.networkFailure,
      );
    },
  );

  test(
    'a cold runtime starts only after the authenticated authority read returns',
    () async {
      final events = <String>[];
      final authorityRead = Completer<ProviderTrackingStatus>();
      final runtime = _FakeTrackingRuntime(onStart: () => events.add('start'));
      final coordinator = ProviderTrackingRecoveryCoordinator(
        api: _FakeTrackingApiLoader((_) {
          events.add('get');
          return authorityRead.future;
        }),
        runtime: runtime,
      );

      final reconciliation = coordinator.reconcile(
        token: 'provider-session',
        requestIds: const ['MOE-1001'],
      );
      await Future<void>.delayed(Duration.zero);
      expect(events, ['get']);

      authorityRead.complete(_activeStatus());
      await reconciliation;
      expect(events, ['get', 'start']);
    },
  );
}

ProviderTrackingStatus _activeStatus() => ProviderTrackingStatus(
  requestId: 'MOE-1001',
  active: true,
  status: 'on_the_way',
  onTheWayCadenceMs: 15000,
  inProgressCadenceMs: 60000,
);

class _FakeTrackingApi implements ProviderTrackingApi {
  _FakeTrackingApi(this.statuses);

  final Map<String, ProviderTrackingStatus> statuses;

  @override
  Future<ProviderTrackingStatus> getTrackingStatus(
    String token,
    String requestId,
  ) async => statuses[requestId]!;
}

class _FakeTrackingApiLoader implements ProviderTrackingApi {
  _FakeTrackingApiLoader(this._loader);

  final Future<ProviderTrackingStatus> Function(String requestId) _loader;

  @override
  Future<ProviderTrackingStatus> getTrackingStatus(
    String token,
    String requestId,
  ) => _loader(requestId);
}

class _FakeTrackingRuntime implements ProviderTrackingRuntime {
  _FakeTrackingRuntime({this.onStart});

  final void Function()? onStart;
  int stopCalls = 0;
  int clearQueueCalls = 0;
  int disposeCalls = 0;
  bool running = false;
  ProviderTrackingStatus? _status;
  final List<ProviderTrackingStatus> started = [];
  final List<ProviderTrackingStatus> updated = [];

  @override
  Future<void> clearQueue() async {
    clearQueueCalls += 1;
  }

  @override
  Future<void> dispose() async {
    disposeCalls += 1;
  }

  @override
  Future<bool> isRunning() async => running;

  @override
  bool matches(ProviderTrackingStatus status) =>
      running && _sameAuthority(_status, status);

  @override
  Future<void> start(ProviderTrackingStatus status, String token) async {
    running = true;
    _status = status;
    started.add(status);
    onStart?.call();
  }

  @override
  Future<void> update(ProviderTrackingStatus status, String token) async {
    _status = status;
    updated.add(status);
  }

  @override
  Future<void> stop() async {
    running = false;
    _status = null;
    stopCalls += 1;
  }
}

bool _sameAuthority(
  ProviderTrackingStatus? left,
  ProviderTrackingStatus right,
) =>
    left != null &&
    left.requestId == right.requestId &&
    left.status == right.status &&
    left.cadenceMs == right.cadenceMs;
