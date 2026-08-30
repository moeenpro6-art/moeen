import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:moeen_mobile/api_config.dart';
import 'package:moeen_mobile/customer_provider_tracking.dart';
import 'package:moeen_mobile/customer_session.dart';
import 'package:moeen_mobile/service_location.dart';

const _receivedAt = '2026-08-30T12:00:00.000Z';

Map<String, dynamic> _position({bool arrivalObserved = false}) => {
  'requestId': 'MOE-1042',
  'latitude': 26.359123,
  'longitude': 43.981988,
  'accuracyMeters': 12,
  'capturedAt': _receivedAt,
  'receivedAt': _receivedAt,
  'arrivalObserved': arrivalObserved,
};

http.Response _jsonResponse(Map<String, dynamic> body, int status) =>
    http.Response(
      jsonEncode(body),
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

void main() {
  test(
    'tracking display is allowed only for live customer request statuses',
    () {
      expect(customerProviderTrackingAllowedForStatus('on_the_way'), isTrue);
      expect(customerProviderTrackingAllowedForStatus('in_progress'), isTrue);
      expect(customerProviderTrackingAllowedForStatus('assigned'), isFalse);
      expect(customerProviderTrackingAllowedForStatus('completed'), isFalse);
      expect(customerProviderTrackingAllowedForStatus('cancelled'), isFalse);
    },
  );

  testWidgets('renders live provider and service markers with arrival state', (
    tester,
  ) async {
    final client = MockClient(
      (_) async => _jsonResponse(_position(arrivalObserved: true), 200),
    );

    await _pumpTracking(
      tester,
      client: client,
      now: () => DateTime.parse('2026-08-30T12:00:10.000Z'),
    );

    expect(find.text('موقع الفني محدّث الآن'), findsOneWidget);
    expect(find.text('وصل الفني إلى موقع الخدمة'), findsOneWidget);
    expect(find.byKey(const Key('tracking_test_map')), findsOneWidget);
    expect(find.text('آخر تحديث: منذ 10 ثانية'), findsOneWidget);
  });

  testWidgets(
    'preview exposes an accessible action that opens full-screen tracking',
    (tester) async {
      final client = MockClient((_) async => _jsonResponse(_position(), 200));

      await _pumpTracking(tester, client: client);

      expect(
        find.byKey(const Key('customer_provider_tracking_preview_clip')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('customer_provider_tracking_preview_map')),
        findsOneWidget,
      );
      expect(find.bySemanticsLabel('فتح الخريطة'), findsOneWidget);

      await tester.tap(find.text('فتح الخريطة'));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('customer_provider_tracking_fullscreen_page')),
        findsOneWidget,
      );
      expect(find.text('تتبع الفني'), findsOneWidget);
      expect(
        find.byKey(const Key('customer_provider_tracking_fullscreen_map_area')),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'full-screen route owns polling while the covered preview is paused',
    (tester) async {
      var calls = 0;
      final client = MockClient((_) async {
        calls += 1;
        return _jsonResponse(_position(), 200);
      });

      await _pumpTracking(
        tester,
        client: client,
        pollInterval: const Duration(seconds: 5),
      );
      expect(calls, 1);

      await tester.tap(find.text('فتح الخريطة'));
      await tester.pump();
      await tester.pump();
      expect(calls, 2);

      await tester.pump(const Duration(seconds: 5));
      await tester.pump();
      expect(calls, 3);

      Navigator.of(
        tester.element(
          find.byKey(const Key('customer_provider_tracking_fullscreen_page')),
        ),
      ).pop();
      await tester.pumpAndSettle();
      expect(calls, 4);
    },
  );

  testWidgets(
    'manual camera movement disables follow until explicit recenter',
    (tester) async {
      var calls = 0;
      bool? observedCameraFollowsProvider;
      int? observedRecenterGeneration;
      VoidCallback? triggerManualCameraMove;
      final client = MockClient((_) async {
        calls += 1;
        return _jsonResponse({
          ..._position(),
          'latitude': 26.359123 + (calls * 0.001),
        }, 200);
      });

      await _pumpTracking(
        tester,
        client: client,
        pollInterval: const Duration(seconds: 5),
        mapSurfaceBuilder:
            (
              context, {
              required providerLocation,
              required serviceLocation,
              required interactive,
              required cameraFollowsProvider,
              required recenterGeneration,
              required onManualCameraMove,
            }) {
              if (interactive) {
                observedCameraFollowsProvider = cameraFollowsProvider;
                observedRecenterGeneration = recenterGeneration;
                triggerManualCameraMove = onManualCameraMove;
              }
              return const SizedBox(key: Key('tracking_test_map'));
            },
      );

      await tester.tap(find.text('فتح الخريطة'));
      await tester.pump();
      await tester.pump();
      expect(observedCameraFollowsProvider, isTrue);
      expect(observedRecenterGeneration, 0);

      triggerManualCameraMove!();
      await tester.pump();
      expect(observedCameraFollowsProvider, isFalse);

      await tester.pump(const Duration(seconds: 5));
      await tester.pump();
      expect(calls, 3);
      expect(observedCameraFollowsProvider, isFalse);

      await tester.tap(find.text('إعادة التوسيط'));
      await tester.pump();
      expect(observedCameraFollowsProvider, isTrue);
      expect(observedRecenterGeneration, 1);
    },
  );

  testWidgets('a terminal 404 in full-screen stops the covered preview too', (
    tester,
  ) async {
    var calls = 0;
    final client = MockClient((_) async {
      calls += 1;
      return calls == 1
          ? _jsonResponse(_position(), 200)
          : http.Response('{}', 404);
    });

    await _pumpTracking(tester, client: client);
    expect(find.text('موقع الفني محدّث الآن'), findsOneWidget);
    expect(calls, 1);

    await tester.tap(find.text('فتح الخريطة'));
    await tester.pump();
    await tester.pump();
    expect(calls, 2);
    expect(find.text('تتبع موقع الفني غير متاح الآن.'), findsWidgets);

    Navigator.of(
      tester.element(
        find.byKey(const Key('customer_provider_tracking_fullscreen_page')),
      ),
    ).pop();
    await tester.pump();
    await tester.pump();

    expect(calls, 2);
    expect(find.text('تتبع موقع الفني غير متاح الآن.'), findsOneWidget);
  });

  testWidgets(
    'renders stale rather than live when receivedAt is 45-120 seconds old',
    (tester) async {
      final client = MockClient((_) async => _jsonResponse(_position(), 200));

      await _pumpTracking(
        tester,
        client: client,
        now: () => DateTime.parse('2026-08-30T12:01:00.000Z'),
      );

      expect(find.text('آخر موقع للفني قديم قليلاً'), findsOneWidget);
      expect(find.text('موقع الفني محدّث الآن'), findsNothing);
    },
  );

  testWidgets(
    'renders offline rather than live when receivedAt is older than 120 seconds',
    (tester) async {
      final client = MockClient((_) async => _jsonResponse(_position(), 200));

      await _pumpTracking(
        tester,
        client: client,
        now: () => DateTime.parse('2026-08-30T12:02:01.000Z'),
      );

      expect(find.text('موقع الفني غير متصل حالياً'), findsOneWidget);
      expect(find.text('موقع الفني محدّث الآن'), findsNothing);
    },
  );

  testWidgets(
    'a failed refresh immediately downgrades the last point to offline',
    (tester) async {
      var calls = 0;
      final client = MockClient((_) async {
        calls += 1;
        return calls == 1
            ? _jsonResponse(_position(), 200)
            : http.Response('{}', 500);
      });

      await _pumpTracking(
        tester,
        client: client,
        pollInterval: const Duration(seconds: 1),
      );
      expect(find.text('موقع الفني محدّث الآن'), findsOneWidget);

      await tester.pump(const Duration(seconds: 1));
      await tester.pump();

      expect(find.text('موقع الفني غير متصل حالياً'), findsOneWidget);
      expect(find.text('موقع الفني محدّث الآن'), findsNothing);
    },
  );

  testWidgets('a hung refresh cannot keep an old provider position live', (
    tester,
  ) async {
    var now = DateTime.parse('2026-08-30T12:00:10.000Z');
    var calls = 0;
    final hungRefresh = Completer<http.Response>();
    final client = MockClient((_) async {
      calls += 1;
      return calls == 1 ? _jsonResponse(_position(), 200) : hungRefresh.future;
    });

    await _pumpTracking(
      tester,
      client: client,
      now: () => now,
      pollInterval: const Duration(seconds: 1),
    );
    expect(find.text('موقع الفني محدّث الآن'), findsOneWidget);

    now = DateTime.parse('2026-08-30T12:02:01.000Z');
    await tester.pump(const Duration(seconds: 35));
    expect(calls, 2);
    expect(find.text('موقع الفني غير متصل حالياً'), findsOneWidget);
    expect(find.text('موقع الفني محدّث الآن'), findsNothing);
  });

  testWidgets(
    'resume immediately reclassifies an expired point while refresh hangs',
    (tester) async {
      var now = DateTime.parse('2026-08-30T12:00:10.000Z');
      var calls = 0;
      final hungRefresh = Completer<http.Response>();
      final client = MockClient((_) async {
        calls += 1;
        return calls == 1
            ? _jsonResponse(_position(), 200)
            : hungRefresh.future;
      });

      await _pumpTracking(tester, client: client, now: () => now);
      expect(find.text('موقع الفني محدّث الآن'), findsOneWidget);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump();
      now = DateTime.parse('2026-08-30T12:02:01.000Z');
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();

      expect(calls, 2);
      expect(find.text('موقع الفني غير متصل حالياً'), findsOneWidget);
      expect(find.text('موقع الفني محدّث الآن'), findsNothing);
    },
  );

  testWidgets(
    'an older pre-background response cannot overwrite a newer resumed response',
    (tester) async {
      final older = Completer<http.Response>();
      final newer = Completer<http.Response>();
      var calls = 0;
      final client = MockClient((_) {
        calls += 1;
        return calls == 1 ? older.future : newer.future;
      });

      await _pumpTracking(tester, client: client);
      expect(calls, 1);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(calls, 2);

      newer.complete(
        _jsonResponse({
          ..._position(),
          'receivedAt': '2026-08-30T12:00:09.000Z',
          'arrivalObserved': true,
        }, 200),
      );
      await tester.pump();
      await tester.pump();
      expect(find.text('وصل الفني إلى موقع الخدمة'), findsOneWidget);

      older.complete(_jsonResponse(_position(), 200));
      await tester.pump();
      await tester.pump();
      expect(find.text('وصل الفني إلى موقع الخدمة'), findsOneWidget);
    },
  );

  testWidgets(
    'polling pauses while another route covers the tracking page and resumes when uncovered',
    (tester) async {
      var calls = 0;
      final client = MockClient((_) async {
        calls += 1;
        return _jsonResponse(_position(), 200);
      });
      final sessionManager = CustomerSessionManager(_MemorySessionStore());
      await sessionManager.save(token: 'token-1', customerId: 'CUS-1');

      final navigatorKey = GlobalKey<NavigatorState>();
      await tester.pumpWidget(
        MaterialApp(
          navigatorKey: navigatorKey,
          navigatorObservers: [customerProviderTrackingRouteObserver],
          home: Builder(
            builder: (context) => Scaffold(
              body: Column(
                children: [
                  CustomerProviderTrackingPanel(
                    requestId: 'MOE-1042',
                    serviceLocation: const ServiceLocationPoint(
                      latitude: 26.360001,
                      longitude: 43.980001,
                    ),
                    sessionManager: sessionManager,
                    httpClient: client,
                    apiConfig: const MoeenApiConfig('https://api.example.test'),
                    now: () => DateTime.parse('2026-08-30T12:00:10.000Z'),
                    pollInterval: const Duration(seconds: 1),
                    mapSurfaceBuilder:
                        (
                          context, {
                          required providerLocation,
                          required serviceLocation,
                          required interactive,
                          required cameraFollowsProvider,
                          required recenterGeneration,
                          required onManualCameraMove,
                        }) => const SizedBox(key: Key('tracking_test_map')),
                  ),
                  FilledButton(
                    key: const Key('cover_tracking_route'),
                    onPressed: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => const Scaffold(body: Text('covered')),
                      ),
                    ),
                    child: const Text('cover'),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();
      expect(calls, 1);

      await tester.tap(find.byKey(const Key('cover_tracking_route')));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 1));
      expect(calls, 1);

      navigatorKey.currentState!.pop();
      await tester.pumpAndSettle();
      expect(calls, 2);
    },
  );

  testWidgets(
    'route uncover immediately reclassifies an expired point while refresh hangs',
    (tester) async {
      var now = DateTime.parse('2026-08-30T12:00:10.000Z');
      var calls = 0;
      final hungRefresh = Completer<http.Response>();
      final client = MockClient((_) async {
        calls += 1;
        return calls == 1
            ? _jsonResponse(_position(), 200)
            : hungRefresh.future;
      });
      final sessionManager = CustomerSessionManager(_MemorySessionStore());
      await sessionManager.save(token: 'token-1', customerId: 'CUS-1');

      final navigatorKey = GlobalKey<NavigatorState>();
      await tester.pumpWidget(
        MaterialApp(
          navigatorKey: navigatorKey,
          navigatorObservers: [customerProviderTrackingRouteObserver],
          home: Builder(
            builder: (context) => Scaffold(
              body: Column(
                children: [
                  CustomerProviderTrackingPanel(
                    requestId: 'MOE-1042',
                    serviceLocation: const ServiceLocationPoint(
                      latitude: 26.360001,
                      longitude: 43.980001,
                    ),
                    sessionManager: sessionManager,
                    httpClient: client,
                    apiConfig: const MoeenApiConfig('https://api.example.test'),
                    now: () => now,
                    mapSurfaceBuilder:
                        (
                          context, {
                          required providerLocation,
                          required serviceLocation,
                          required interactive,
                          required cameraFollowsProvider,
                          required recenterGeneration,
                          required onManualCameraMove,
                        }) => const SizedBox(key: Key('tracking_test_map')),
                  ),
                  FilledButton(
                    key: const Key('cover_tracking_route_for_freshness'),
                    onPressed: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => const Scaffold(body: Text('covered')),
                      ),
                    ),
                    child: const Text('cover'),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();
      expect(find.text('موقع الفني محدّث الآن'), findsOneWidget);

      await tester.tap(
        find.byKey(const Key('cover_tracking_route_for_freshness')),
      );
      await tester.pumpAndSettle();
      now = DateTime.parse('2026-08-30T12:02:01.000Z');
      navigatorKey.currentState!.pop();
      await tester.pumpAndSettle();

      expect(calls, 2);
      expect(find.text('موقع الفني غير متصل حالياً'), findsOneWidget);
      expect(find.text('موقع الفني محدّث الآن'), findsNothing);
    },
  );

  testWidgets('404 clears the tracking display and stops later polls', (
    tester,
  ) async {
    var calls = 0;
    final client = MockClient((_) async {
      calls += 1;
      return http.Response('{}', 404);
    });

    await _pumpTracking(tester, client: client);
    await tester.pump(const Duration(seconds: 30));

    expect(calls, 1);
    expect(find.text('تتبع موقع الفني غير متاح الآن.'), findsOneWidget);
  });

  testWidgets('401 clears the tracking display and stops later polls', (
    tester,
  ) async {
    var calls = 0;
    final client = MockClient((_) async {
      calls += 1;
      return http.Response('{}', 401);
    });

    await _pumpTracking(tester, client: client);
    await tester.pump(const Duration(seconds: 30));

    expect(calls, 1);
    expect(find.text('تتبع موقع الفني غير متاح الآن.'), findsOneWidget);
  });

  test('backs off failed polls while preserving the approved live cadence', () {
    expect(providerLocationRetryDelay(0), const Duration(seconds: 15));
    expect(providerLocationRetryDelay(1), const Duration(seconds: 30));
    expect(providerLocationRetryDelay(2), const Duration(seconds: 60));
    expect(providerLocationRetryDelay(8), const Duration(seconds: 60));
  });

  test('uses the approved freshness thresholds', () {
    final now = DateTime.parse('2026-08-30T12:02:00.000Z');
    expect(
      providerLocationFreshness(
        receivedAt: '2026-08-30T12:01:16.000Z',
        now: now,
      ),
      ProviderLocationFreshness.fresh,
    );
    expect(
      providerLocationFreshness(
        receivedAt: '2026-08-30T12:01:15.000Z',
        now: now,
      ),
      ProviderLocationFreshness.stale,
    );
    expect(
      providerLocationFreshness(
        receivedAt: '2026-08-30T12:00:00.000Z',
        now: now,
      ),
      ProviderLocationFreshness.offline,
    );
  });
}

Future<void> _pumpTracking(
  WidgetTester tester, {
  required MockClient client,
  DateTime Function()? now,
  Duration pollInterval = providerLocationPollInterval,
  CustomerProviderTrackingMapSurfaceBuilder? mapSurfaceBuilder,
}) async {
  final sessionManager = CustomerSessionManager(_MemorySessionStore());
  await sessionManager.save(token: 'token-1', customerId: 'CUS-1');
  await tester.pumpWidget(
    MaterialApp(
      navigatorObservers: [customerProviderTrackingRouteObserver],
      home: Directionality(
        textDirection: TextDirection.rtl,
        child: Scaffold(
          body: CustomerProviderTrackingPanel(
            requestId: 'MOE-1042',
            serviceLocation: const ServiceLocationPoint(
              latitude: 26.360001,
              longitude: 43.980001,
            ),
            sessionManager: sessionManager,
            httpClient: client,
            apiConfig: const MoeenApiConfig('https://api.example.test'),
            now: now ?? () => DateTime.parse('2026-08-30T12:00:10.000Z'),
            pollInterval: pollInterval,
            mapSurfaceBuilder:
                mapSurfaceBuilder ??
                (
                  context, {
                  required providerLocation,
                  required serviceLocation,
                  required interactive,
                  required cameraFollowsProvider,
                  required recenterGeneration,
                  required onManualCameraMove,
                }) => const SizedBox(key: Key('tracking_test_map')),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
  await tester.pump();
}

class _MemorySessionStore implements SessionKeyValueStore {
  final Map<String, String> _values = {};

  @override
  Future<void> deleteAll() async => _values.clear();

  @override
  Future<String?> read(String key) async => _values[key];

  @override
  Future<void> write(String key, String value) async => _values[key] = value;
}
