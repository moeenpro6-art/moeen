import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:moeen_provider/main.dart';
import 'package:moeen_provider/provider_tracking.dart';

void main() {
  testWidgets(
    'a restored session survives inactive and detached UI lifecycle without revoking tracking',
    (tester) async {
      final runtime = _FakeTrackingRuntime();
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: MockClient((request) async {
          switch (request.url.path) {
            case '/provider/auth/me':
              return _json(
                '{"id":"PILOT-1","name":"مقدم اختبار",'
                '"specialties":["ac-cleaning"],"serviceZone":"القصيم",'
                '"available":true}',
              );
            case '/provider/service-requests':
              return _json(
                '[{"id":"MOE-1001","serviceId":"ac-cleaning",'
                '"timing":"as-soon-as-possible","status":"on_the_way"}]',
              );
            case '/provider/opportunities':
              return _json('[]');
            case '/provider/service-requests/MOE-1001/tracking':
              return _json(
                '{"tracking":{"active":true,"requestId":"MOE-1001",'
                '"status":"on_the_way","onTheWayCadenceMs":15000,'
                '"inProgressCadenceMs":60000}}',
              );
            default:
              return _json('{}', status: 404);
          }
        }),
      );

      await tester.pumpWidget(
        MoeenProviderApp(
          api: api,
          sessionStore: _MemorySessionStore('provider-session'),
          hiddenStore: _MemoryHiddenStore(),
          trackingRuntime: runtime,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('مهامي المسندة'), findsOneWidget);
      expect(runtime.started, hasLength(1));
      expect(runtime.started.single.requestId, 'MOE-1001');
      expect(runtime.stopCalls, 0);
      expect(runtime.clearQueueCalls, 0);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pump();

      expect(runtime.stopCalls, 0);
      expect(runtime.clearQueueCalls, 0);

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();

      expect(runtime.disposeCalls, 1);
      expect(runtime.stopCalls, 0);
      expect(runtime.clearQueueCalls, 0);
    },
  );

  testWidgets(
    'a tracking authority 401 stops collection and returns to login',
    (tester) async {
      final runtime = _FakeTrackingRuntime();
      final store = _MemorySessionStore('expired-provider-session');
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: MockClient((request) async {
          switch (request.url.path) {
            case '/provider/auth/me':
              return _json(
                '{"id":"PILOT-1","name":"مقدم اختبار",'
                '"specialties":["ac-cleaning"],"serviceZone":"القصيم",'
                '"available":true}',
              );
            case '/provider/service-requests':
              return _json(
                '[{"id":"MOE-1001","serviceId":"ac-cleaning",'
                '"timing":"as-soon-as-possible","status":"on_the_way"}]',
              );
            case '/provider/service-requests/MOE-1001/tracking':
              return _json('{"message":"Unauthorized"}', status: 401);
            default:
              return _json('{}', status: 404);
          }
        }),
      );

      await tester.pumpWidget(
        MoeenProviderApp(
          api: api,
          sessionStore: store,
          hiddenStore: _MemoryHiddenStore(),
          trackingRuntime: runtime,
        ),
      );
      await tester.pumpAndSettle();

      expect(store.token, isNull);
      expect(find.text('تطبيق مقدم الخدمة'), findsOneWidget);
      expect(runtime.started, isEmpty);
      expect(runtime.stopCalls, 1);
      expect(runtime.clearQueueCalls, 1);
    },
  );

  testWidgets(
    'repeated dashboard refresh with unchanged authority does not restart tracking',
    (tester) async {
      final runtime = _FakeTrackingRuntime();
      var trackingReads = 0;
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: MockClient((request) async {
          switch (request.url.path) {
            case '/provider/auth/me':
              return _json(
                '{"id":"PILOT-1","name":"مقدم اختبار",'
                '"specialties":["ac-cleaning"],"serviceZone":"القصيم",'
                '"available":true}',
              );
            case '/provider/service-requests':
              return _json(
                '[{"id":"MOE-1001","serviceId":"ac-cleaning",'
                '"timing":"as-soon-as-possible","status":"on_the_way"}]',
              );
            case '/provider/opportunities':
              return _json('[]');
            case '/provider/service-requests/MOE-1001/tracking':
              trackingReads += 1;
              return _json(
                '{"tracking":{"active":true,"requestId":"MOE-1001",'
                '"status":"on_the_way","onTheWayCadenceMs":15000,'
                '"inProgressCadenceMs":60000}}',
              );
            default:
              return _json('{}', status: 404);
          }
        }),
      );

      await tester.pumpWidget(
        MoeenProviderApp(
          api: api,
          sessionStore: _MemorySessionStore('provider-session'),
          hiddenStore: _MemoryHiddenStore(),
          trackingRuntime: runtime,
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('تحديث'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('تحديث'));
      await tester.pumpAndSettle();

      expect(trackingReads, 3);
      expect(runtime.started, hasLength(1));
      expect(runtime.stopCalls, 0);
      expect(runtime.clearQueueCalls, 0);
    },
  );

  testWidgets(
    'a dashboard 5xx stops active tracking and cannot restart it until fresh authority succeeds',
    (tester) async {
      final runtime = _FakeTrackingRuntime();
      var dashboardReads = 0;
      var trackingReads = 0;
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: MockClient((request) async {
          switch (request.url.path) {
            case '/provider/auth/me':
              return _json(
                '{"id":"PILOT-1","name":"مقدم اختبار",'
                '"specialties":["ac-cleaning"],"serviceZone":"القصيم",'
                '"available":true}',
              );
            case '/provider/service-requests':
              dashboardReads += 1;
              if (dashboardReads == 2) {
                return _json('{"message":"Temporary failure"}', status: 503);
              }
              return _json(
                '[{"id":"MOE-1001","serviceId":"ac-cleaning",'
                '"timing":"as-soon-as-possible","status":"on_the_way"}]',
              );
            case '/provider/opportunities':
              return _json('[]');
            case '/provider/service-requests/MOE-1001/tracking':
              trackingReads += 1;
              return _json(
                '{"tracking":{"active":true,"requestId":"MOE-1001",'
                '"status":"on_the_way","onTheWayCadenceMs":15000,'
                '"inProgressCadenceMs":60000}}',
              );
            default:
              return _json('{}', status: 404);
          }
        }),
      );

      await tester.pumpWidget(
        MoeenProviderApp(
          api: api,
          sessionStore: _MemorySessionStore('provider-session'),
          hiddenStore: _MemoryHiddenStore(),
          trackingRuntime: runtime,
        ),
      );
      await tester.pumpAndSettle();
      expect(runtime.started, hasLength(1));
      expect(await runtime.isRunning(), isTrue);
      expect(trackingReads, 1);

      await tester.tap(find.byTooltip('تحديث'));
      await tester.pumpAndSettle();

      expect(dashboardReads, 2);
      expect(trackingReads, 1);
      expect(runtime.stopCalls, 1);
      expect(runtime.clearQueueCalls, 1);
      expect(await runtime.isRunning(), isFalse);
      expect(runtime.started, hasLength(1));

      await tester.tap(find.byTooltip('تحديث'));
      await tester.pumpAndSettle();

      expect(dashboardReads, 3);
      expect(trackingReads, 2);
      expect(runtime.started, hasLength(2));
      expect(await runtime.isRunning(), isTrue);
    },
  );

  testWidgets(
    'a missing tracking authority refreshes stale jobs with collection off',
    (tester) async {
      final runtime = _FakeTrackingRuntime();
      var jobReads = 0;
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: MockClient((request) async {
          switch (request.url.path) {
            case '/provider/auth/me':
              return _json(
                '{"id":"PILOT-1","name":"مقدم اختبار",'
                '"specialties":["ac-cleaning"],"serviceZone":"القصيم",'
                '"available":true}',
              );
            case '/provider/service-requests':
              jobReads += 1;
              return _json(
                jobReads == 1
                    ? '[{"id":"MOE-1001","serviceId":"ac-cleaning",'
                          '"timing":"as-soon-as-possible","status":"on_the_way"}]'
                    : '[]',
              );
            case '/provider/service-requests/MOE-1001/tracking':
              return _json('{"message":"Not found"}', status: 404);
            case '/provider/opportunities':
              return _json('[]');
            default:
              return _json('{}', status: 404);
          }
        }),
      );

      await tester.pumpWidget(
        MoeenProviderApp(
          api: api,
          sessionStore: _MemorySessionStore('provider-session'),
          hiddenStore: _MemoryHiddenStore(),
          trackingRuntime: runtime,
        ),
      );
      await tester.pumpAndSettle();

      expect(jobReads, 2);
      expect(runtime.started, isEmpty);
      expect(runtime.stopCalls, 1);
      expect(runtime.clearQueueCalls, 1);
      expect(find.text('لا توجد مهام مسندة لك الآن.'), findsOneWidget);
    },
  );

  testWidgets('a fresh login restores tracking only after current authority', (
    tester,
  ) async {
    final runtime = _FakeTrackingRuntime();
    final api = ProviderApi(
      baseUrl: 'https://api.example.test',
      client: MockClient((request) async {
        switch (request.url.path) {
          case '/provider/auth/login':
            return _json(
              '{"provider":{"id":"PILOT-1","name":"مقدم اختبار",'
              '"specialties":["ac-cleaning"],"serviceZone":"القصيم",'
              '"available":true},"token":"new-provider-session"}',
            );
          case '/provider/auth/me':
            return _json(
              '{"id":"PILOT-1","name":"مقدم اختبار",'
              '"specialties":["ac-cleaning"],"serviceZone":"القصيم",'
              '"available":true}',
            );
          case '/provider/service-requests':
            return _json(
              '[{"id":"MOE-1001","serviceId":"ac-cleaning",'
              '"timing":"as-soon-as-possible","status":"on_the_way"}]',
            );
          case '/provider/opportunities':
            return _json('[]');
          case '/provider/service-requests/MOE-1001/tracking':
            return _json(
              '{"tracking":{"active":true,"requestId":"MOE-1001",'
              '"status":"on_the_way","onTheWayCadenceMs":15000,'
              '"inProgressCadenceMs":60000}}',
            );
          default:
            return _json('{}', status: 404);
        }
      }),
    );

    await tester.pumpWidget(
      MoeenProviderApp(
        api: api,
        sessionStore: _MemorySessionStore(null),
        hiddenStore: _MemoryHiddenStore(),
        trackingRuntime: runtime,
      ),
    );
    await tester.pumpAndSettle();
    expect(runtime.started, isEmpty);

    await tester.enterText(find.byType(TextField), 'a' * 16);
    await tester.tap(find.text('دخول'));
    await tester.pumpAndSettle();

    expect(find.text('مهامي المسندة'), findsOneWidget);
    expect(runtime.started, hasLength(1));
    expect(runtime.started.single.requestId, 'MOE-1001');
    expect(runtime.stopCalls, 0);
    expect(runtime.clearQueueCalls, 0);
  });

  testWidgets(
    'refresh rechecks authority and keeps collection off when inactive',
    (tester) async {
      final runtime = _FakeTrackingRuntime();
      var trackingReads = 0;
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: MockClient((request) async {
          switch (request.url.path) {
            case '/provider/auth/me':
              return _json(
                '{"id":"PILOT-1","name":"مقدم اختبار",'
                '"specialties":["ac-cleaning"],"serviceZone":"القصيم",'
                '"available":true}',
              );
            case '/provider/service-requests':
              return _json(
                '[{"id":"MOE-1001","serviceId":"ac-cleaning",'
                '"timing":"as-soon-as-possible","status":"on_the_way"}]',
              );
            case '/provider/opportunities':
              return _json('[]');
            case '/provider/service-requests/MOE-1001/tracking':
              trackingReads += 1;
              return _json(
                trackingReads == 1
                    ? '{"tracking":{"active":true,"requestId":"MOE-1001",'
                          '"status":"on_the_way","onTheWayCadenceMs":15000,'
                          '"inProgressCadenceMs":60000}}'
                    : '{"tracking":{"active":false,"requestId":"MOE-1001",'
                          '"status":"on_the_way","onTheWayCadenceMs":15000,'
                          '"inProgressCadenceMs":60000}}',
              );
            default:
              return _json('{}', status: 404);
          }
        }),
      );

      await tester.pumpWidget(
        MoeenProviderApp(
          api: api,
          sessionStore: _MemorySessionStore('provider-session'),
          hiddenStore: _MemoryHiddenStore(),
          trackingRuntime: runtime,
        ),
      );
      await tester.pumpAndSettle();
      expect(runtime.started, hasLength(1));
      expect(runtime.stopCalls, 0);

      await tester.tap(find.byTooltip('تحديث'));
      await tester.pumpAndSettle();

      expect(trackingReads, 2);
      expect(runtime.started, hasLength(1));
      expect(runtime.stopCalls, 1);
      expect(runtime.clearQueueCalls, 1);
    },
  );

  testWidgets('a terminal status transition stops tracking and clears its queue', (
    tester,
  ) async {
    final runtime = _FakeTrackingRuntime();
    var jobsReads = 0;
    final api = ProviderApi(
      baseUrl: 'https://api.example.test',
      client: MockClient((request) async {
        switch (request.url.path) {
          case '/provider/auth/me':
            return _json(
              '{"id":"PILOT-1","name":"مقدم اختبار",'
              '"specialties":["ac-cleaning"],"serviceZone":"القصيم",'
              '"available":true}',
            );
          case '/provider/service-requests':
            jobsReads += 1;
            return _json(
              jobsReads == 1
                  ? '[{"id":"MOE-1001","serviceId":"ac-cleaning",'
                        '"timing":"as-soon-as-possible","status":"in_progress"}]'
                  : '[{"id":"MOE-1001","serviceId":"ac-cleaning",'
                        '"timing":"as-soon-as-possible","status":"completed"}]',
            );
          case '/provider/opportunities':
            return _json('[]');
          case '/provider/service-requests/MOE-1001/tracking':
            return _json(
              '{"tracking":{"active":true,"requestId":"MOE-1001",'
              '"status":"in_progress","onTheWayCadenceMs":15000,'
              '"inProgressCadenceMs":60000}}',
            );
          case '/provider/service-requests/MOE-1001/status':
            return _json(
              '{"id":"MOE-1001","serviceId":"ac-cleaning",'
              '"timing":"as-soon-as-possible","status":"completed",'
              '"tracking":{"active":false,"requestId":"MOE-1001",'
              '"status":"completed","onTheWayCadenceMs":15000,'
              '"inProgressCadenceMs":60000}}',
            );
          default:
            return _json('{}', status: 404);
        }
      }),
    );

    await tester.pumpWidget(
      MoeenProviderApp(
        api: api,
        sessionStore: _MemorySessionStore('provider-session'),
        hiddenStore: _MemoryHiddenStore(),
        trackingRuntime: runtime,
      ),
    );
    await tester.pumpAndSettle();
    expect(runtime.started, hasLength(1));
    expect(runtime.stopCalls, 0);

    await tester.tap(find.text('إنهاء الخدمة'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('تأكيد: إنهاء الخدمة'));
    await tester.pumpAndSettle();

    expect(jobsReads, 2);
    expect(runtime.started, hasLength(1));
    expect(runtime.stopCalls, 1);
    expect(runtime.clearQueueCalls, 1);
  });

  testWidgets('logout stops tracking and clears its in-memory queue', (
    tester,
  ) async {
    final runtime = _FakeTrackingRuntime();
    final store = _MemorySessionStore('provider-session');
    final api = ProviderApi(
      baseUrl: 'https://api.example.test',
      client: MockClient((request) async {
        switch (request.url.path) {
          case '/provider/auth/me':
            return _json(
              '{"id":"PILOT-1","name":"مقدم اختبار",'
              '"specialties":["ac-cleaning"],"serviceZone":"القصيم",'
              '"available":true}',
            );
          case '/provider/service-requests':
          case '/provider/opportunities':
            return _json('[]');
          case '/provider/auth/logout':
            return _json('{}');
          default:
            return _json('{}', status: 404);
        }
      }),
    );

    await tester.pumpWidget(
      MoeenProviderApp(
        api: api,
        sessionStore: store,
        hiddenStore: _MemoryHiddenStore(),
        trackingRuntime: runtime,
      ),
    );
    await tester.pumpAndSettle();
    expect(runtime.stopCalls, 1);
    expect(runtime.clearQueueCalls, 1);

    await tester.tap(find.byTooltip('تسجيل الخروج'));
    await tester.pumpAndSettle();

    expect(store.token, isNull);
    expect(find.text('تطبيق مقدم الخدمة'), findsOneWidget);
    expect(runtime.stopCalls, 2);
    expect(runtime.clearQueueCalls, 2);
  });
}

http.Response _json(String body, {int status = 200}) => http.Response(
  body,
  status,
  headers: const {'content-type': 'application/json; charset=utf-8'},
);

class _MemorySessionStore implements ProviderSessionStore {
  _MemorySessionStore(this.token);

  String? token;

  @override
  Future<void> clearToken() async => token = null;

  @override
  Future<String?> readToken() async => token;

  @override
  Future<void> writeToken(String value) async => token = value;
}

class _MemoryHiddenStore implements HiddenOpportunitiesStore {
  @override
  Future<void> hideRequest(String providerId, String requestId) async {}

  @override
  Future<Set<String>> readHidden(String providerId) async => <String>{};
}

class _FakeTrackingRuntime implements ProviderTrackingRuntime {
  final List<ProviderTrackingStatus> started = [];
  int disposeCalls = 0;
  int stopCalls = 0;
  int clearQueueCalls = 0;
  bool _running = false;
  ProviderTrackingStatus? _status;

  @override
  Future<void> clearQueue() async => clearQueueCalls += 1;

  @override
  Future<void> dispose() async => disposeCalls += 1;

  @override
  Future<bool> isRunning() async => _running;

  @override
  bool matches(ProviderTrackingStatus status) =>
      _running &&
      _status?.requestId == status.requestId &&
      _status?.status == status.status &&
      _status?.onTheWayCadenceMs == status.onTheWayCadenceMs &&
      _status?.inProgressCadenceMs == status.inProgressCadenceMs;

  @override
  Future<void> start(ProviderTrackingStatus status, String token) async {
    _running = true;
    _status = status;
    started.add(status);
  }

  @override
  Future<void> update(ProviderTrackingStatus status, String token) async {
    _status = status;
  }

  @override
  Future<void> stop() async {
    _running = false;
    _status = null;
    stopCalls += 1;
  }
}
