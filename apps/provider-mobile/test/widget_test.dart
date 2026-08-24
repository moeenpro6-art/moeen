import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:moeen_provider/main.dart';
import 'package:moeen_provider/provider_tracking.dart' as provider_tracking;

void main() {
  test('provider job parsing preserves a customer-approved quote', () {
    final job = ProviderJob.fromJson({
      'id': 'MOE-1001',
      'serviceId': 'ac-cleaning',
      'address': 'حي الصفراء، بريدة',
      'timing': 'as-soon-as-possible',
      'status': 'on_the_way',
      'quote': {
        'id': 'QTE-1',
        'amountHalalas': 15000,
        'scope': 'تنظيف كامل للمكيف',
        'status': 'approved',
      },
    });

    expect(job.quote?.amountHalalas, 15000);
    expect(job.quote?.status, 'approved');
    expect(nextProviderStatus(job), 'in_progress');
  });

  test(
    'provider cannot start a job while the customer quote is unresolved',
    () {
      final job = ProviderJob.fromJson({
        'id': 'MOE-1002',
        'serviceId': 'plumbing',
        'address': 'حي النهضة، بريدة',
        'timing': 'as-soon-as-possible',
        'status': 'on_the_way',
        'quote': {
          'id': 'QTE-2',
          'amountHalalas': 12000,
          'scope': 'إصلاح تسرب',
          'status': 'proposed',
        },
      });

      expect(nextProviderStatus(job), isNull);
      expect(providerActionLabel(job), 'بانتظار قرار العميل على عرض السعر');
    },
  );

  test('provider job parsing keeps the assigned-provider customer phone', () {
    final job = ProviderJob.fromJson({
      'id': 'MOE-1003',
      'serviceId': 'ac-cleaning',
      'address': 'حي الصفراء، بريدة',
      'timing': 'as-soon-as-possible',
      'status': 'assigned',
      'customerPhone': '+966****0012',
    });

    expect(job.customerPhone, '+966****0012');
  });

  test(
    'provider job parsing accepts terminal history without private fields',
    () {
      final job = ProviderJob.fromJson({
        'id': 'MOE-1004',
        'serviceId': 'ac-cleaning',
        'timing': 'as-soon-as-possible',
        'status': 'completed',
      });

      expect(job.address, isNull);
      expect(job.customerPhone, isNull);
    },
  );

  test('provider api parses a terminal job in the assigned-job list', () async {
    final api = ProviderApi(
      baseUrl: 'https://api.example.test',
      client: MockClient(
        (_) async => http.Response(
          '[{"id":"MOE-1005","serviceId":"ac-cleaning",'
          '"timing":"as-soon-as-possible","status":"completed"}]',
          200,
          headers: _jsonUtf8,
        ),
      ),
    );

    final jobs = await api.jobs('provider-token');

    expect(jobs, hasLength(1));
    expect(jobs.single.status, 'completed');
    expect(jobs.single.address, isNull);
  });

  test(
    'provider api parses an address-redacted completed PATCH response',
    () async {
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: MockClient(
          (_) async =>
              http.Response(_completedTransitionJson, 200, headers: _jsonUtf8),
        ),
      );

      final transition = await api.updateJobStatus(
        'provider-token',
        'MOE-2003',
        'completed',
      );

      expect(transition.job.status, 'completed');
      expect(transition.job.address, isNull);
      expect(transition.tracking.active, isFalse);
    },
  );

  test('provider api reports a 401 as an unauthorized exception', () async {
    final api = ProviderApi(
      baseUrl: 'https://api.example.test',
      client: MockClient(
        (_) async => http.Response('{"message":"Unauthorized"}', 401),
      ),
    );

    await expectLater(
      api.jobs('stale-token'),
      throwsA(isA<ProviderUnauthorizedException>()),
    );
    await expectLater(
      api.currentProvider('stale-token'),
      throwsA(isA<ProviderUnauthorizedException>()),
    );
  });

  test(
    'provider api keeps reporting server errors as generic failures',
    () async {
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: MockClient(
          (_) async => http.Response('{"message":"boom"}', 500),
        ),
      );

      await expectLater(
        api.jobs('any-token'),
        throwsA(isA<ProviderApiException>()),
      );
    },
  );

  testWidgets(
    'a 401 while refreshing jobs clears the stored session and returns to '
    'the login screen',
    (tester) async {
      var jobsCalls = 0;
      final store = _MemorySessionStore()..token = 'stale-token';
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: MockClient((request) async {
          final path = request.url.path;
          if (path == '/provider/auth/me') {
            return http.Response(
              _providerJson,
              200,
              headers: {'content-type': 'application/json; charset=utf-8'},
            );
          }
          if (path == '/provider/service-requests') {
            jobsCalls += 1;
            return jobsCalls == 1
                ? http.Response('[]', 200)
                : http.Response('{"message":"Unauthorized"}', 401);
          }
          return http.Response('{}', 404);
        }),
      );

      await tester.pumpWidget(
        MoeenProviderApp(
          api: api,
          sessionStore: store,
          hiddenStore: _MemoryHiddenStore(),
        ),
      );
      await tester.pumpAndSettle();

      // Restored session shows the authenticated dashboard.
      expect(find.text('مهامي المسندة'), findsOneWidget);
      expect(find.text('مقدم اختبار'), findsOneWidget);
      expect(store.token, 'stale-token');

      // Refresh triggers jobs() which now answers 401.
      await tester.tap(find.byTooltip('تحديث'));
      await tester.pumpAndSettle();

      // The stale session is cleared and the app is back at login.
      expect(store.token, isNull);
      expect(find.text('تطبيق مقدم الخدمة'), findsOneWidget);
      expect(find.text('مهامي المسندة'), findsNothing);
      expect(find.text('مقدم اختبار'), findsNothing);
    },
  );

  testWidgets(
    'a 401 while updating availability clears the stored session and returns '
    'to the login screen',
    (tester) async {
      final store = _MemorySessionStore()..token = 'stale-token';
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: MockClient((request) async {
          final path = request.url.path;
          if (path == '/provider/auth/me') {
            return http.Response(
              _providerJson,
              200,
              headers: {'content-type': 'application/json; charset=utf-8'},
            );
          }
          if (path == '/provider/service-requests') {
            return http.Response('[]', 200);
          }
          if (path == '/provider/availability') {
            return http.Response('{"message":"Unauthorized"}', 401);
          }
          return http.Response('{}', 404);
        }),
      );

      await tester.pumpWidget(
        MoeenProviderApp(
          api: api,
          sessionStore: store,
          hiddenStore: _MemoryHiddenStore(),
        ),
      );
      await tester.pumpAndSettle();

      // Authenticated dashboard with the availability switch.
      expect(find.text('متاح لاستقبال التعيينات'), findsOneWidget);
      expect(store.token, 'stale-token');

      // Toggling availability hits the API which answers 401.
      await tester.tap(find.byType(SwitchListTile));
      await tester.pumpAndSettle();

      // Session cleared and the provider is no longer shown as authenticated.
      expect(store.token, isNull);
      expect(find.text('تطبيق مقدم الخدمة'), findsOneWidget);
      expect(find.text('متاح لاستقبال التعيينات'), findsNothing);
    },
  );

  testWidgets('renders an invited opportunity with a submit action', (
    tester,
  ) async {
    final store = _MemorySessionStore()..token = 'stale-token';
    final api = ProviderApi(
      baseUrl: 'https://api.example.test',
      client: _dashboardMockClient(
        opportunitiesHandler: (_) async =>
            http.Response(_opportunitiesInvitedJson, 200),
      ),
    );

    await tester.pumpWidget(
      MoeenProviderApp(
        api: api,
        sessionStore: store,
        hiddenStore: _MemoryHiddenStore(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('فرص العمل المتاحة'), findsOneWidget);
    expect(find.text('تنظيف المكيفات'), findsOneWidget);
    expect(find.text('في أقرب وقت · مدعو'), findsOneWidget);
    expect(find.text('تقديم عرض'), findsOneWidget);
  });

  testWidgets(
    'shows the customer phone on an assigned job when the API returns it',
    (tester) async {
      final store = _MemorySessionStore()..token = 'stale-token';
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: MockClient((request) async {
          final path = request.url.path;
          if (path == '/provider/auth/me') {
            return http.Response(_providerJson, 200, headers: _jsonUtf8);
          }
          if (path == '/provider/service-requests') {
            return http.Response(
              '[{"id":"MOE-1001","serviceId":"ac-cleaning",'
              '"address":"حي الصفراء، بريدة","timing":"as-soon-as-possible",'
              '"status":"assigned","customerPhone":"+966****0012"}]',
              200,
              headers: _jsonUtf8,
            );
          }
          if (path == '/provider/opportunities') {
            return http.Response('[]', 200);
          }
          return http.Response('{}', 404);
        }),
      );

      await tester.pumpWidget(
        MoeenProviderApp(
          api: api,
          sessionStore: store,
          hiddenStore: _MemoryHiddenStore(),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('رقم العميل: +966****0012'), findsOneWidget);
    },
  );

  testWidgets(
    'does not show a customer phone label when the API omits the field',
    (tester) async {
      final store = _MemorySessionStore()..token = 'stale-token';
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: MockClient((request) async {
          final path = request.url.path;
          if (path == '/provider/auth/me') {
            return http.Response(_providerJson, 200, headers: _jsonUtf8);
          }
          if (path == '/provider/service-requests') {
            return http.Response(
              '[{"id":"MOE-1001","serviceId":"ac-cleaning",'
              '"timing":"as-soon-as-possible","status":"completed"}]',
              200,
              headers: _jsonUtf8,
            );
          }
          if (path == '/provider/opportunities') {
            return http.Response('[]', 200);
          }
          return http.Response('{}', 404);
        }),
      );

      await tester.pumpWidget(
        MoeenProviderApp(
          api: api,
          sessionStore: store,
          hiddenStore: _MemoryHiddenStore(),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('رقم العميل'), findsNothing);
    },
  );

  testWidgets('tapping بدء التوجه opens the confirmation sheet and confirming '
      'advances an assigned job to on_the_way', (tester) async {
    final store = _MemorySessionStore()..token = 'stale-token';
    final runtime = _FakeTrackingRuntime();
    var patchedStatus = '';
    var jobStatus = 'assigned';
    final api = ProviderApi(
      baseUrl: 'https://api.example.test',
      client: MockClient((request) async {
        final method = request.method;
        final path = request.url.path;
        if (method == 'GET' && path == '/provider/auth/me') {
          return http.Response(_providerJson, 200, headers: _jsonUtf8);
        }
        if (method == 'GET' && path == '/provider/service-requests') {
          final body = jobStatus == 'on_the_way'
              ? '[$_jobOnTheWayJson]'
              : '[$_jobAssignedJson]';
          return http.Response(body, 200, headers: _jsonUtf8);
        }
        if (method == 'GET' && path == '/provider/opportunities') {
          return http.Response('[]', 200, headers: _jsonUtf8);
        }
        if (method == 'PATCH' &&
            path == '/provider/service-requests/MOE-2001/status') {
          patchedStatus =
              (jsonDecode(request.body) as Map<String, dynamic>)['status']
                  as String;
          jobStatus = 'on_the_way';
          return http.Response(
            _onTheWayTransitionJson,
            200,
            headers: _jsonUtf8,
          );
        }
        return http.Response('{}', 404);
      }),
    );

    await tester.pumpWidget(
      MoeenProviderApp(
        api: api,
        sessionStore: store,
        hiddenStore: _MemoryHiddenStore(),
        trackingRuntime: runtime,
        trackingPermissionGate: const _GrantedTrackingPermissionGate(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('بدء التوجه'), findsOneWidget);

    // Opening the sheet from a pre-MaterialApp context throws
    // "debugCheckHasMaterialLocalizations"; this tap must not crash.
    await tester.ensureVisible(find.text('بدء التوجه'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('بدء التوجه'));
    await tester.pumpAndSettle();

    expect(find.text('تأكيد: بدء التوجه'), findsOneWidget);
    expect(
      find.text('سيتم إبلاغ العميل بأنك في الطريق. تأكد من استعدادك للمغادرة.'),
      findsOneWidget,
    );

    await tester.tap(find.text('تأكيد: بدء التوجه'));
    await tester.pumpAndSettle();

    expect(patchedStatus, 'on_the_way');
    expect(find.text('بدء التوجه'), findsNothing);
    expect(find.text('بدء الخدمة'), findsOneWidget);
    expect(runtime.started, hasLength(1));
    expect(runtime.started.single.requestId, 'MOE-2001');
    expect(runtime.started.single.cadenceMs, 15000);
  });

  testWidgets(
    'an inactive transition snapshot updates the job without requesting location permission',
    (tester) async {
      final runtime = _FakeTrackingRuntime();
      final permissionGate = _CountingTrackingPermissionGate();
      var patchCalls = 0;
      var jobStatus = 'assigned';
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: MockClient((request) async {
          final path = request.url.path;
          if (request.method == 'GET' && path == '/provider/auth/me') {
            return http.Response(_providerJson, 200, headers: _jsonUtf8);
          }
          if (request.method == 'GET' && path == '/provider/service-requests') {
            return http.Response(
              jobStatus == 'assigned'
                  ? '[$_jobAssignedJson]'
                  : '[$_jobOnTheWayJson]',
              200,
              headers: _jsonUtf8,
            );
          }
          if (request.method == 'GET' && path == '/provider/opportunities') {
            return http.Response('[]', 200, headers: _jsonUtf8);
          }
          if (request.method == 'GET' &&
              path == '/provider/service-requests/MOE-2001/tracking') {
            return http.Response(
              _assignedInactiveTrackingJson,
              200,
              headers: _jsonUtf8,
            );
          }
          if (request.method == 'PATCH' &&
              path == '/provider/service-requests/MOE-2001/status') {
            patchCalls += 1;
            jobStatus = 'on_the_way';
            return http.Response(
              _onTheWayInactiveTransitionJson,
              200,
              headers: _jsonUtf8,
            );
          }
          return http.Response('{}', 404);
        }),
      );

      await tester.pumpWidget(
        MoeenProviderApp(
          api: api,
          sessionStore: _MemorySessionStore()..token = 'provider-session',
          hiddenStore: _MemoryHiddenStore(),
          trackingRuntime: runtime,
          trackingPermissionGate: permissionGate,
        ),
      );
      await tester.pumpAndSettle();

      final startAction = find.text('بدء التوجه');
      await tester.ensureVisible(startAction);
      await tester.pump();
      await tester.tap(startAction);
      await tester.pumpAndSettle();
      await tester.tap(find.text('تأكيد: بدء التوجه'));
      await tester.pumpAndSettle();

      expect(patchCalls, 1);
      expect(permissionGate.calls, 0);
      expect(runtime.started, isEmpty);
      expect(runtime.stopCalls, 2);
      expect(runtime.clearQueueCalls, 2);
      expect(find.text('بدء الخدمة'), findsOneWidget);
    },
  );

  testWidgets(
    'an active transition requests permission but never starts tracking when denied',
    (tester) async {
      final runtime = _FakeTrackingRuntime();
      final permissionGate = _DeniedTrackingPermissionGate();
      var patchCalls = 0;
      var jobStatus = 'assigned';
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: MockClient((request) async {
          final path = request.url.path;
          if (request.method == 'GET' && path == '/provider/auth/me') {
            return http.Response(_providerJson, 200, headers: _jsonUtf8);
          }
          if (request.method == 'GET' && path == '/provider/service-requests') {
            return http.Response(
              jobStatus == 'assigned'
                  ? '[$_jobAssignedJson]'
                  : '[$_jobOnTheWayJson]',
              200,
              headers: _jsonUtf8,
            );
          }
          if (request.method == 'GET' && path == '/provider/opportunities') {
            return http.Response('[]', 200, headers: _jsonUtf8);
          }
          if (request.method == 'GET' &&
              path == '/provider/service-requests/MOE-2001/tracking') {
            return http.Response(
              _assignedInactiveTrackingJson,
              200,
              headers: _jsonUtf8,
            );
          }
          if (request.method == 'PATCH' &&
              path == '/provider/service-requests/MOE-2001/status') {
            patchCalls += 1;
            jobStatus = 'on_the_way';
            return http.Response(
              _onTheWayTransitionJson,
              200,
              headers: _jsonUtf8,
            );
          }
          return http.Response('{}', 404);
        }),
      );

      await tester.pumpWidget(
        MoeenProviderApp(
          api: api,
          sessionStore: _MemorySessionStore()..token = 'provider-session',
          hiddenStore: _MemoryHiddenStore(),
          trackingRuntime: runtime,
          trackingPermissionGate: permissionGate,
        ),
      );
      await tester.pumpAndSettle();

      final startAction = find.text('بدء التوجه');
      await tester.ensureVisible(startAction);
      await tester.pump();
      await tester.tap(startAction);
      await tester.pumpAndSettle();
      await tester.tap(find.text('تأكيد: بدء التوجه'));
      await tester.pumpAndSettle();

      expect(patchCalls, 1);
      expect(permissionGate.calls, 1);
      expect(runtime.started, isEmpty);
      expect(
        find.text(
          'تم تحديث حالة المهمة، لكن لا يمكن تشغيل تتبع الموقع دون الإذن.',
        ),
        findsOneWidget,
      );
      expect(find.text('بدء الخدمة'), findsOneWidget);
    },
  );

  testWidgets(
    'an active in-progress transition updates cadence without stopping the tracking runtime',
    (tester) async {
      final store = _MemorySessionStore()..token = 'provider-session';
      final runtime = _FakeTrackingRuntime();
      var patchedStatus = '';
      var jobStatus = 'on_the_way';
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: MockClient((request) async {
          final path = request.url.path;
          if (request.method == 'GET' && path == '/provider/auth/me') {
            return http.Response(_providerJson, 200, headers: _jsonUtf8);
          }
          if (request.method == 'GET' && path == '/provider/service-requests') {
            return http.Response(
              jobStatus == 'on_the_way'
                  ? '[$_jobOnTheWayJson]'
                  : '[$_jobInProgressJson]',
              200,
              headers: _jsonUtf8,
            );
          }
          if (request.method == 'GET' && path == '/provider/opportunities') {
            return http.Response('[]', 200, headers: _jsonUtf8);
          }
          if (request.method == 'GET' &&
              path == '/provider/service-requests/MOE-2002/tracking') {
            return http.Response(
              _onTheWayTrackingJson,
              200,
              headers: _jsonUtf8,
            );
          }
          if (request.method == 'PATCH' &&
              path == '/provider/service-requests/MOE-2002/status') {
            patchedStatus =
                (jsonDecode(request.body) as Map<String, dynamic>)['status']
                    as String;
            jobStatus = 'in_progress';
            return http.Response(
              _inProgressTransitionJson,
              200,
              headers: _jsonUtf8,
            );
          }
          return http.Response('{}', 404);
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
      expect(runtime.started, hasLength(1));
      expect(runtime.stopCalls, 0);

      final startServiceAction = find.text('بدء الخدمة');
      await tester.ensureVisible(startServiceAction);
      await tester.pump();
      await tester.tap(startServiceAction);
      await tester.pumpAndSettle();
      await tester.tap(find.text('تأكيد: بدء الخدمة'));
      await tester.pumpAndSettle();

      expect(patchedStatus, 'in_progress');
      expect(runtime.updated, hasLength(1));
      expect(runtime.updated.single.requestId, 'MOE-2002');
      expect(runtime.updated.single.cadenceMs, 60000);
      // Recovery and the authorized cadence transition preserve one runtime.
      expect(runtime.stopCalls, 0);
      expect(runtime.clearQueueCalls, 0);
    },
  );

  testWidgets(
    'tapping بدء الخدمة opens the confirmation sheet and رجوع closes it '
    'without sending a status update',
    (tester) async {
      final store = _MemorySessionStore()..token = 'stale-token';
      var patchedStatus = '';
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: MockClient((request) async {
          final method = request.method;
          final path = request.url.path;
          if (method == 'GET' && path == '/provider/auth/me') {
            return http.Response(_providerJson, 200, headers: _jsonUtf8);
          }
          if (method == 'GET' && path == '/provider/service-requests') {
            return http.Response(
              '[$_jobOnTheWayJson]',
              200,
              headers: _jsonUtf8,
            );
          }
          if (method == 'GET' && path == '/provider/opportunities') {
            return http.Response('[]', 200, headers: _jsonUtf8);
          }
          if (method == 'PATCH' &&
              path == '/provider/service-requests/MOE-2002/status') {
            patchedStatus = 'sent';
            return http.Response(_jobInProgressJson, 200, headers: _jsonUtf8);
          }
          return http.Response('{}', 404);
        }),
      );

      await tester.pumpWidget(
        MoeenProviderApp(
          api: api,
          sessionStore: store,
          hiddenStore: _MemoryHiddenStore(),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('بدء الخدمة'), findsOneWidget);

      await tester.ensureVisible(find.text('بدء الخدمة'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('بدء الخدمة'));
      await tester.pumpAndSettle();

      expect(find.text('تأكيد: بدء الخدمة'), findsOneWidget);
      expect(
        find.text(
          'سيتم تحديث حالة الطلب إلى قيد التنفيذ. ابدأ الخدمة بعد وصولك للموقع.',
        ),
        findsOneWidget,
      );

      await tester.tap(find.text('رجوع'));
      await tester.pumpAndSettle();

      expect(patchedStatus, isEmpty);
      expect(find.text('تأكيد: بدء الخدمة'), findsNothing);
      expect(find.text('بدء الخدمة'), findsOneWidget);
    },
  );

  testWidgets('tapping إنهاء الخدمة opens the confirmation sheet and confirming '
      'advances an in-progress job to completed', (tester) async {
    final store = _MemorySessionStore()..token = 'stale-token';
    var patchedStatus = '';
    var jobStatus = 'in_progress';
    final api = ProviderApi(
      baseUrl: 'https://api.example.test',
      client: MockClient((request) async {
        final method = request.method;
        final path = request.url.path;
        if (method == 'GET' && path == '/provider/auth/me') {
          return http.Response(_providerJson, 200, headers: _jsonUtf8);
        }
        if (method == 'GET' && path == '/provider/service-requests') {
          final body = jobStatus == 'completed'
              ? '[$_jobCompletedJson]'
              : '[$_jobInProgressJson]';
          return http.Response(body, 200, headers: _jsonUtf8);
        }
        if (method == 'GET' && path == '/provider/opportunities') {
          return http.Response('[]', 200, headers: _jsonUtf8);
        }
        if (method == 'PATCH' &&
            path == '/provider/service-requests/MOE-2003/status') {
          patchedStatus =
              (jsonDecode(request.body) as Map<String, dynamic>)['status']
                  as String;
          jobStatus = 'completed';
          return http.Response(
            _completedTransitionJson,
            200,
            headers: _jsonUtf8,
          );
        }
        return http.Response('{}', 404);
      }),
    );

    await tester.pumpWidget(
      MoeenProviderApp(
        api: api,
        sessionStore: store,
        hiddenStore: _MemoryHiddenStore(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('إنهاء الخدمة'), findsOneWidget);

    await tester.ensureVisible(find.text('إنهاء الخدمة'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('إنهاء الخدمة'));
    await tester.pumpAndSettle();

    expect(find.text('تأكيد: إنهاء الخدمة'), findsOneWidget);
    expect(
      find.text(
        'سيتم إبلاغ العميل باكتمال الخدمة. تأكد من إنهاء العمل المتفق عليه قبل المتابعة.',
      ),
      findsOneWidget,
    );

    await tester.tap(find.text('تأكيد: إنهاء الخدمة'));
    await tester.pumpAndSettle();

    expect(patchedStatus, 'completed');
    expect(find.text('إنهاء الخدمة'), findsNothing);
    expect(find.text('لا يوجد إجراء متاح'), findsOneWidget);
  });

  testWidgets('shows the empty state when there are no opportunities', (
    tester,
  ) async {
    final store = _MemorySessionStore()..token = 'stale-token';
    final api = ProviderApi(
      baseUrl: 'https://api.example.test',
      client: _dashboardMockClient(
        opportunitiesHandler: (_) async => http.Response('[]', 200),
      ),
    );

    await tester.pumpWidget(
      MoeenProviderApp(
        api: api,
        sessionStore: store,
        hiddenStore: _MemoryHiddenStore(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('لا توجد فرص متاحة حاليًا.'), findsOneWidget);
    expect(find.text('تقديم عرض'), findsNothing);
  });

  testWidgets(
    'submits a quote and refreshes the opportunity into the quoted state',
    (tester) async {
      var opportunitiesCalls = 0;
      var quoteBody = '';
      final store = _MemorySessionStore()..token = 'stale-token';
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: _dashboardMockClient(
          opportunitiesHandler: (_) async {
            opportunitiesCalls += 1;
            return http.Response(
              opportunitiesCalls == 1
                  ? _opportunitiesInvitedJson
                  : _opportunitiesQuotedJson,
              200,
            );
          },
          quotesHandler: (request) async {
            quoteBody = request.body;
            return http.Response(_quoteCreatedJson, 201);
          },
        ),
      );

      await tester.pumpWidget(
        MoeenProviderApp(
          api: api,
          sessionStore: store,
          hiddenStore: _MemoryHiddenStore(),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('تقديم عرض'));
      await tester.pumpAndSettle();
      expect(find.text('تقديم عرض — تنظيف المكيفات'), findsOneWidget);

      await tester.enterText(find.byType(TextField).at(0), '150');
      await tester.enterText(find.byType(TextField).at(1), 'full clean');
      await tester.tap(find.text('إرسال العرض'));
      await tester.pumpAndSettle();

      expect(quoteBody, contains('"amountHalalas":15000'));
      expect(find.text('تقديم عرض — تنظيف المكيفات'), findsNothing);
      expect(find.textContaining('عرضك: 150.00 ر.س'), findsOneWidget);
      expect(find.text('تقديم عرض'), findsNothing);
    },
  );

  testWidgets(
    'rejects invalid amount and scope locally without posting a quote',
    (tester) async {
      var quotePosts = 0;
      final store = _MemorySessionStore()..token = 'stale-token';
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: _dashboardMockClient(
          opportunitiesHandler: (_) async =>
              http.Response(_opportunitiesInvitedJson, 200),
          quotesHandler: (request) async {
            quotePosts += 1;
            return http.Response(_quoteCreatedJson, 201);
          },
        ),
      );

      await tester.pumpWidget(
        MoeenProviderApp(
          api: api,
          sessionStore: store,
          hiddenStore: _MemoryHiddenStore(),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('تقديم عرض'));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField).at(0), '0');
      await tester.enterText(find.byType(TextField).at(1), 'ab');
      await tester.tap(find.text('إرسال العرض'));
      await tester.pumpAndSettle();
      expect(find.text('أدخل مبلغًا صحيحًا أكبر من صفر.'), findsOneWidget);
      expect(quotePosts, 0);

      await tester.enterText(find.byType(TextField).at(0), '150');
      await tester.tap(find.text('إرسال العرض'));
      await tester.pumpAndSettle();
      expect(
        find.text('أدخل وصفًا للنطاق (3 أحرف على الأقل).'),
        findsOneWidget,
      );
      expect(quotePosts, 0);
    },
  );

  testWidgets(
    'shows a retryable error when opportunities fail and recovers on retry',
    (tester) async {
      var calls = 0;
      final store = _MemorySessionStore()..token = 'stale-token';
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: _dashboardMockClient(
          opportunitiesHandler: (_) async {
            calls += 1;
            return calls == 1
                ? http.Response('{"message":"boom"}', 500)
                : http.Response(_opportunitiesInvitedJson, 200);
          },
        ),
      );

      await tester.pumpWidget(
        MoeenProviderApp(
          api: api,
          sessionStore: store,
          hiddenStore: _MemoryHiddenStore(),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('تعذر تحميل الفرص. حاول مرة أخرى.'), findsOneWidget);

      await tester.tap(find.text('إعادة المحاولة'));
      await tester.pumpAndSettle();

      expect(find.text('تقديم عرض'), findsOneWidget);
    },
  );

  testWidgets(
    'a 401 while loading opportunities clears the session and returns to '
    'the login screen',
    (tester) async {
      final store = _MemorySessionStore()..token = 'stale-token';
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: _dashboardMockClient(
          opportunitiesHandler: (_) async =>
              http.Response('{"message":"Unauthorized"}', 401),
        ),
      );

      await tester.pumpWidget(
        MoeenProviderApp(
          api: api,
          sessionStore: store,
          hiddenStore: _MemoryHiddenStore(),
        ),
      );
      await tester.pumpAndSettle();

      expect(store.token, isNull);
      expect(find.text('تطبيق مقدم الخدمة'), findsOneWidget);
      expect(find.text('فرص العمل المتاحة'), findsNothing);
    },
  );

  testWidgets(
    'a 401 while submitting a quote clears the session and returns to the '
    'login screen',
    (tester) async {
      final store = _MemorySessionStore()..token = 'stale-token';
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: _dashboardMockClient(
          opportunitiesHandler: (_) async =>
              http.Response(_opportunitiesInvitedJson, 200),
          quotesHandler: (_) async =>
              http.Response('{"message":"Unauthorized"}', 401),
        ),
      );

      await tester.pumpWidget(
        MoeenProviderApp(
          api: api,
          sessionStore: store,
          hiddenStore: _MemoryHiddenStore(),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('تقديم عرض'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).at(0), '150');
      await tester.enterText(find.byType(TextField).at(1), 'full clean');
      await tester.tap(find.text('إرسال العرض'));
      await tester.pumpAndSettle();

      expect(store.token, isNull);
      expect(find.text('تطبيق مقدم الخدمة'), findsOneWidget);
    },
  );

  test('ProviderOpportunity parses rejected status and quote', () {
    final opp = ProviderOpportunity.fromJson({
      'requestId': 'MOE-1001',
      'serviceId': 'ac-cleaning',
      'timing': 'as-soon-as-possible',
      'opportunityStatus': 'rejected',
      'myQuote': {
        'id': 'QTE-1',
        'amountHalalas': 15000,
        'scope': 'تنظيف كامل',
        'status': 'rejected',
      },
    });

    expect(opp.opportunityStatus, 'rejected');
    expect(opp.myQuote?.status, 'rejected');
  });

  test('opportunityMessage returns direct-rejection text', () {
    final opp = ProviderOpportunity.fromJson(
      {
            'requestId': 'MOE-1002',
            'serviceId': 'ac-cleaning',
            'timing': 'as-soon-as-possible',
            'opportunityStatus': 'rejected',
            'myQuote': {
              'id': 'QTE-2',
              'amountHalalas': 10000,
              'scope': 'test',
              'status': 'rejected',
            },
          }
          as Map<String, dynamic>,
    );

    expect(opportunityMessage(opp), 'تم رفض عرضك');
  });

  test('opportunityMessage returns closed-after-other text for non-approved'
      ' closed opportunity', () {
    final opp = ProviderOpportunity.fromJson(
      {
            'requestId': 'MOE-1003',
            'serviceId': 'ac-cleaning',
            'timing': 'as-soon-as-possible',
            'opportunityStatus': 'closed',
            'myQuote': {
              'id': 'QTE-3',
              'amountHalalas': 12000,
              'scope': 'test',
              'status': 'rejected',
            },
          }
          as Map<String, dynamic>,
    );

    expect(opportunityMessage(opp), 'تم إغلاق الفرصة بعد اختيار عرض آخر');
  });

  test(
    'opportunityMessage returns base label for approved closed opportunity',
    () {
      final opp = ProviderOpportunity.fromJson(
        {
              'requestId': 'MOE-1004',
              'serviceId': 'ac-cleaning',
              'timing': 'as-soon-as-possible',
              'opportunityStatus': 'closed',
              'myQuote': {
                'id': 'QTE-4',
                'amountHalalas': 14000,
                'scope': 'test',
                'status': 'approved',
              },
            }
            as Map<String, dynamic>,
      );

      expect(opportunityMessage(opp), 'مغلقة');
    },
  );

  testWidgets(
    'hide action appears only for final rejected, withdrawn, and losing-closed opportunities',
    (tester) async {
      final cases = <String, String>{
        'rejected': 'تم رفض عرضك',
        'withdrawn': 'عرضك مسحوب',
        'closed-losing': 'تم إغلاق الفرصة بعد اختيار عرض آخر',
      };
      for (final entry in cases.entries) {
        final json = switch (entry.key) {
          'rejected' => _opportunitiesRejectedJson,
          'withdrawn' => _opportunitiesWithdrawnJson,
          _ => _opportunitiesClosedLosingJson,
        };
        final store = _MemorySessionStore()..token = 'stale-token';
        final api = ProviderApi(
          baseUrl: 'https://api.example.test',
          client: _dashboardMockClient(
            opportunitiesHandler: (_) async =>
                http.Response(json, 200, headers: _jsonUtf8),
          ),
        );
        // Tear down the previous app state so each iteration boots fresh.
        await tester.pumpWidget(const SizedBox());
        await tester.pumpWidget(
          MoeenProviderApp(
            api: api,
            sessionStore: store,
            hiddenStore: _MemoryHiddenStore(),
          ),
        );
        await tester.pumpAndSettle();
        expect(
          find.textContaining(entry.value),
          findsOneWidget,
          reason: 'outcome message for ${entry.key}',
        );
        expect(
          find.text('إخفاء من قائمتي'),
          findsOneWidget,
          reason: 'hide button for ${entry.key}',
        );
      }
    },
  );

  testWidgets(
    'hide action never appears for invited, quoted, or winning-closed opportunities',
    (tester) async {
      final cases = <String, String>{
        'invited': _opportunitiesInvitedJson,
        'quoted': _opportunitiesQuotedJson,
        'winning-closed': _opportunitiesClosedWinnerJson,
      };
      for (final entry in cases.entries) {
        final store = _MemorySessionStore()..token = 'stale-token';
        final api = ProviderApi(
          baseUrl: 'https://api.example.test',
          client: _dashboardMockClient(
            opportunitiesHandler: (_) async =>
                http.Response(entry.value, 200, headers: _jsonUtf8),
          ),
        );
        // Tear down the previous app state so each iteration boots fresh.
        await tester.pumpWidget(const SizedBox());
        await tester.pumpWidget(
          MoeenProviderApp(
            api: api,
            sessionStore: store,
            hiddenStore: _MemoryHiddenStore(),
          ),
        );
        await tester.pumpAndSettle();
        expect(
          find.text('إخفاء من قائمتي'),
          findsNothing,
          reason: 'no hide button for ${entry.key}',
        );
      }
    },
  );

  testWidgets(
    'tapping hide removes the card immediately with zero HTTP requests',
    (tester) async {
      var totalRequests = 0;
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: MockClient((request) async {
          totalRequests += 1;
          final path = request.url.path;
          if (path == '/provider/auth/me') {
            return http.Response(_providerJson, 200, headers: _jsonUtf8);
          }
          if (path == '/provider/service-requests') {
            return http.Response('[]', 200);
          }
          if (path == '/provider/opportunities') {
            return http.Response(
              _opportunitiesRejectedJson,
              200,
              headers: _jsonUtf8,
            );
          }
          return http.Response('{}', 404);
        }),
      );
      final store = _MemorySessionStore()..token = 'stale-token';

      await tester.pumpWidget(
        MoeenProviderApp(
          api: api,
          sessionStore: store,
          hiddenStore: _MemoryHiddenStore(),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('إخفاء من قائمتي'), findsOneWidget);

      final requestsBefore = totalRequests;
      await tester.tap(find.text('إخفاء من قائمتي'));
      await tester.pumpAndSettle();

      expect(totalRequests, requestsBefore);
      expect(find.text('إخفاء من قائمتي'), findsNothing);
      expect(find.text('لا توجد فرص متاحة حاليًا.'), findsOneWidget);
    },
  );

  testWidgets(
    'hidden requestId stays hidden after a rebuild for the same provider',
    (tester) async {
      final hiddenStore = _MemoryHiddenStore();
      final store = _MemorySessionStore()..token = 'stale-token';
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: _dashboardMockClient(
          opportunitiesHandler: (_) async => http.Response(
            _opportunitiesRejectedJson,
            200,
            headers: _jsonUtf8,
          ),
        ),
      );
      Widget app() => MoeenProviderApp(
        api: api,
        sessionStore: store,
        hiddenStore: hiddenStore,
      );

      await tester.pumpWidget(app());
      await tester.pumpAndSettle();
      await tester.tap(find.text('إخفاء من قائمتي'));
      await tester.pumpAndSettle();
      expect(find.text('إخفاء من قائمتي'), findsNothing);

      // Rebuild the whole widget tree with the same stores.
      await tester.pumpWidget(Container());
      await tester.pumpWidget(app());
      await tester.pumpAndSettle();
      expect(find.text('إخفاء من قائمتي'), findsNothing);
      expect(find.text('لا توجد فرص متاحة حاليًا.'), findsOneWidget);
    },
  );

  testWidgets('a different provider account does not inherit the hidden list', (
    tester,
  ) async {
    final hiddenStore = _MemoryHiddenStore();
    await hiddenStore.hideRequest('provider-1', 'MOE-9');
    final store = _MemorySessionStore()..token = 'stale-token';
    final api = ProviderApi(
      baseUrl: 'https://api.example.test',
      client: MockClient((request) async {
        final path = request.url.path;
        if (path == '/provider/auth/me') {
          return http.Response(_providerJsonOther, 200, headers: _jsonUtf8);
        }
        if (path == '/provider/service-requests') {
          return http.Response('[]', 200);
        }
        if (path == '/provider/opportunities') {
          return http.Response(
            _opportunitiesRejectedJson,
            200,
            headers: _jsonUtf8,
          );
        }
        return http.Response('{}', 404);
      }),
    );

    await tester.pumpWidget(
      MoeenProviderApp(api: api, sessionStore: store, hiddenStore: hiddenStore),
    );
    await tester.pumpAndSettle();

    expect(find.text('إخفاء من قائمتي'), findsOneWidget);
  });

  test('ProviderOpportunity parses pre-quote details and images', () {
    final opp = ProviderOpportunity.fromJson(
      {
            'requestId': 'MOE-30',
            'serviceId': 'ac-cleaning',
            'timing': 'scheduled',
            'opportunityStatus': 'invited',
            'details': 'مكيف سبليت لا يبرد',
            'images': [
              {
                'id': 'img-2',
                'mimeType': 'image/jpeg',
                'byteSize': 1024,
                'sortOrder': 1,
                'url': 'https://signed.example.test/img-2?sig=z',
                'urlExpiresAt': '2026-08-17T12:00:00.000Z',
              },
              {
                'id': 'img-1',
                'mimeType': 'image/jpeg',
                'byteSize': 2048,
                'sortOrder': 0,
                'url': 'https://signed.example.test/img-1?sig=y',
              },
            ],
          }
          as Map<String, dynamic>,
    );

    expect(opp.address, isNull);
    expect(opp.details, 'مكيف سبليت لا يبرد');
    expect(opp.images, hasLength(2));
    // Server sort order is preserved exactly as returned.
    expect(opp.images.map((image) => image.id), ['img-2', 'img-1']);
    expect(opp.images.first.url, 'https://signed.example.test/img-2?sig=z');
  });

  test('ProviderOpportunity ignores malformed image entries', () {
    final opp = ProviderOpportunity.fromJson(
      {
            'requestId': 'MOE-31',
            'serviceId': 'plumbing',
            'timing': 'as-soon-as-possible',
            'opportunityStatus': 'invited',
            'address': 'حي النهضة، بريدة',
            'images': [
              {
                'id': 'img-1',
                'mimeType': 'image/jpeg',
                'byteSize': 10,
                'sortOrder': 0,
                'url': 'https://signed.example.test/img-1',
              },
              'not-an-object',
              null,
            ],
          }
          as Map<String, dynamic>,
    );

    expect(opp.images, hasLength(1));
    expect(opp.images.single.id, 'img-1');
  });

  test('ProviderOpportunity without pre-quote fields stays safe and empty', () {
    final opp = ProviderOpportunity.fromJson(
      {
            'requestId': 'MOE-32',
            'serviceId': 'ac-cleaning',
            'timing': 'as-soon-as-possible',
            'opportunityStatus': 'closed',
            'myQuote': {
              'id': 'QTE-30',
              'amountHalalas': 10000,
              'scope': 'test',
              'status': 'rejected',
            },
          }
          as Map<String, dynamic>,
    );

    expect(opp.address, isNull);
    expect(opp.details, isNull);
    expect(opp.images, isEmpty);
  });

  testWidgets(
    'an invited opportunity renders service, timing, details and image '
    'thumbnails without an exact address before quoting',
    (tester) async {
      final store = _MemorySessionStore()..token = 'stale-token';
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: _dashboardMockClient(
          opportunitiesHandler: (_) async => http.Response(
            _opportunitiesInvitedWithImagesJson,
            200,
            headers: _jsonUtf8,
          ),
        ),
      );

      await tester.pumpWidget(
        MoeenProviderApp(
          api: api,
          sessionStore: store,
          hiddenStore: _MemoryHiddenStore(),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('تنظيف المكيفات'), findsOneWidget);
      expect(find.text('موعد محدد · مدعو'), findsOneWidget);
      expect(find.text('حي الصفراء، بريدة'), findsNothing);
      expect(find.text('مكيف سبليت لا يبرد'), findsOneWidget);
      // Network images fail in the test environment; the failure state tile
      // proves the thumbnail gallery rendered with a safe fallback.
      expect(find.text('تعذر تحميل الصورة'), findsNWidgets(2));
      expect(find.text('تقديم عرض'), findsOneWidget);
    },
  );

  testWidgets(
    'a terminal opportunity never renders address, details or images',
    (tester) async {
      final store = _MemorySessionStore()..token = 'stale-token';
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: _dashboardMockClient(
          opportunitiesHandler: (_) async => http.Response(
            _opportunitiesRejectedJson,
            200,
            headers: _jsonUtf8,
          ),
        ),
      );

      await tester.pumpWidget(
        MoeenProviderApp(
          api: api,
          sessionStore: store,
          hiddenStore: _MemoryHiddenStore(),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('تم رفض عرضك'), findsOneWidget);
      expect(find.text('حي الصفراء، بريدة'), findsNothing);
      expect(find.text('تعذر تحميل الصورة'), findsNothing);
    },
  );
}

class _MemorySessionStore implements ProviderSessionStore {
  String? token;

  @override
  Future<String?> readToken() async => token;

  @override
  Future<void> writeToken(String value) async => token = value;

  @override
  Future<void> clearToken() async => token = null;
}

class _MemoryHiddenStore implements HiddenOpportunitiesStore {
  final Map<String, Set<String>> _hidden = {};

  @override
  Future<Set<String>> readHidden(String providerId) async =>
      _hidden[providerId] ?? {};

  @override
  Future<void> hideRequest(String providerId, String requestId) async {
    _hidden.putIfAbsent(providerId, () => <String>{}).add(requestId);
  }
}

const _providerJson =
    '{"id":"provider-1","name":"مقدم اختبار","specialties":["ac-cleaning"],'
    '"serviceZone":"بريدة","available":true}';

const _providerJsonOther =
    '{"id":"provider-2","name":"مقدم آخر","specialties":["ac-cleaning"],'
    '"serviceZone":"بريدة","available":true}';

const _jsonUtf8 = {'content-type': 'application/json; charset=utf-8'};

const _opportunitiesInvitedJson =
    '[{"requestId":"MOE-1","serviceId":"ac-cleaning",'
    '"timing":"as-soon-as-possible","opportunityStatus":"invited"}]';

const _opportunitiesInvitedWithImagesJson =
    '[{"requestId":"MOE-30","serviceId":"ac-cleaning",'
    '"timing":"scheduled","opportunityStatus":"invited",'
    '"details":"مكيف سبليت لا يبرد",'
    '"images":['
    '{"id":"img-1","mimeType":"image/jpeg","byteSize":1024,"sortOrder":0,'
    '"url":"https://signed.example.test/img-1?sig=a",'
    '"urlExpiresAt":"2026-08-17T12:00:00.000Z"},'
    '{"id":"img-2","mimeType":"image/jpeg","byteSize":2048,"sortOrder":1,'
    '"url":"https://signed.example.test/img-2?sig=b"}'
    ']}]';

const _opportunitiesQuotedJson =
    '[{"requestId":"MOE-1","serviceId":"ac-cleaning",'
    '"timing":"as-soon-as-possible","opportunityStatus":"quoted",'
    '"myQuote":{"id":"QTE-1","providerId":"provider-1",'
    '"amountHalalas":15000,"scope":"full clean","status":"proposed",'
    '"proposedAt":"2026-08-07T00:00:00.000Z"}}]';

const _opportunitiesRejectedJson =
    '[{"requestId":"MOE-9","serviceId":"ac-cleaning",'
    '"timing":"as-soon-as-possible","opportunityStatus":"rejected",'
    '"myQuote":{"id":"QTE-9","providerId":"provider-1",'
    '"amountHalalas":15000,"scope":"عرض مرفوض","status":"rejected",'
    '"proposedAt":"2026-08-07T00:00:00.000Z","decidedAt":"2026-08-07T01:00:00.000Z"}}]';

const _opportunitiesWithdrawnJson =
    '[{"requestId":"MOE-10","serviceId":"ac-cleaning",'
    '"timing":"as-soon-as-possible","opportunityStatus":"withdrawn",'
    '"myQuote":{"id":"QTE-10","providerId":"provider-1",'
    '"amountHalalas":15000,"scope":"عرض مسحوب","status":"withdrawn",'
    '"proposedAt":"2026-08-07T00:00:00.000Z","decidedAt":"2026-08-07T01:00:00.000Z"}}]';

const _opportunitiesClosedLosingJson =
    '[{"requestId":"MOE-11","serviceId":"ac-cleaning",'
    '"timing":"as-soon-as-possible","opportunityStatus":"closed",'
    '"myQuote":{"id":"QTE-11","providerId":"provider-1",'
    '"amountHalalas":12000,"scope":"عرض خاسر","status":"rejected",'
    '"proposedAt":"2026-08-07T00:00:00.000Z","decidedAt":"2026-08-07T01:00:00.000Z"}}]';

const _opportunitiesClosedWinnerJson =
    '[{"requestId":"MOE-12","serviceId":"ac-cleaning",'
    '"timing":"as-soon-as-possible","opportunityStatus":"closed",'
    '"myQuote":{"id":"QTE-12","providerId":"provider-1",'
    '"amountHalalas":14000,"scope":"عرض فائز","status":"approved",'
    '"proposedAt":"2026-08-07T00:00:00.000Z","decidedAt":"2026-08-07T01:00:00.000Z"}}]';

const _quoteCreatedJson =
    '{"id":"QTE-1","providerId":"provider-1","amountHalalas":15000,'
    '"scope":"full clean","status":"proposed",'
    '"proposedAt":"2026-08-07T00:00:00.000Z"}';

const _jobAssignedJson =
    '{"id":"MOE-2001","serviceId":"ac-cleaning",'
    '"address":"حي الصفراء، بريدة","timing":"as-soon-as-possible",'
    '"status":"assigned"}';

const _jobOnTheWayJson =
    '{"id":"MOE-2002","serviceId":"ac-cleaning",'
    '"address":"حي الصفراء، بريدة","timing":"as-soon-as-possible",'
    '"status":"on_the_way"}';

const _jobInProgressJson =
    '{"id":"MOE-2003","serviceId":"ac-cleaning",'
    '"address":"حي الصفراء، بريدة","timing":"as-soon-as-possible",'
    '"status":"in_progress"}';

const _jobCompletedJson =
    '{"id":"MOE-2003","serviceId":"ac-cleaning",'
    '"timing":"as-soon-as-possible","status":"completed"}';

const _onTheWayTransitionJson =
    '{"id":"MOE-2001","serviceId":"ac-cleaning",'
    '"address":"حي الصفراء، بريدة","timing":"as-soon-as-possible",'
    '"status":"on_the_way","tracking":{"active":true,'
    '"requestId":"MOE-2001","status":"on_the_way",'
    '"onTheWayCadenceMs":15000,"inProgressCadenceMs":60000}}';

const _onTheWayTrackingJson =
    '{"tracking":{"active":true,"requestId":"MOE-2002",'
    '"status":"on_the_way","onTheWayCadenceMs":15000,'
    '"inProgressCadenceMs":60000}}';

const _onTheWayInactiveTransitionJson =
    '{"id":"MOE-2001","serviceId":"ac-cleaning",'
    '"address":"حي الصفراء، بريدة","timing":"as-soon-as-possible",'
    '"status":"on_the_way","tracking":{"active":false,'
    '"requestId":"MOE-2001","status":"on_the_way",'
    '"onTheWayCadenceMs":15000,"inProgressCadenceMs":60000}}';

const _assignedInactiveTrackingJson =
    '{"tracking":{"active":false,"requestId":"MOE-2001",'
    '"status":"assigned","onTheWayCadenceMs":15000,'
    '"inProgressCadenceMs":60000}}';

const _inProgressTransitionJson =
    '{"id":"MOE-2002","serviceId":"ac-cleaning",'
    '"address":"حي الصفراء، بريدة","timing":"as-soon-as-possible",'
    '"status":"in_progress","tracking":{"active":true,'
    '"requestId":"MOE-2002","status":"in_progress",'
    '"onTheWayCadenceMs":15000,"inProgressCadenceMs":60000}}';

const _completedTransitionJson =
    '{"id":"MOE-2003","serviceId":"ac-cleaning",'
    '"timing":"as-soon-as-possible","status":"completed",'
    '"tracking":{"active":false,"requestId":"MOE-2003",'
    '"status":"completed","onTheWayCadenceMs":15000,'
    '"inProgressCadenceMs":60000}}';

MockClient _dashboardMockClient({
  required Future<http.Response> Function(http.Request) opportunitiesHandler,
  Future<http.Response> Function(http.Request)? quotesHandler,
}) {
  return MockClient((request) async {
    final method = request.method;
    final path = request.url.path;
    if (method == 'GET' && path == '/provider/auth/me') {
      return http.Response(_providerJson, 200, headers: _jsonUtf8);
    }
    if (method == 'GET' && path == '/provider/service-requests') {
      return http.Response('[]', 200);
    }
    if (method == 'GET' && path == '/provider/opportunities') {
      return opportunitiesHandler(request);
    }
    if (method == 'POST' && path == '/provider/opportunities/MOE-1/quotes') {
      if (quotesHandler != null) {
        return quotesHandler(request);
      }
      return http.Response('{}', 404);
    }
    return http.Response('{}', 404);
  });
}

class _GrantedTrackingPermissionGate
    implements provider_tracking.ProviderTrackingPermissionGate {
  const _GrantedTrackingPermissionGate();

  @override
  Future<bool> ensurePermission() async => true;
}

class _CountingTrackingPermissionGate
    implements provider_tracking.ProviderTrackingPermissionGate {
  int calls = 0;

  @override
  Future<bool> ensurePermission() async {
    calls += 1;
    return true;
  }
}

class _DeniedTrackingPermissionGate
    implements provider_tracking.ProviderTrackingPermissionGate {
  int calls = 0;

  @override
  Future<bool> ensurePermission() async {
    calls += 1;
    return false;
  }
}

class _FakeTrackingRuntime
    implements provider_tracking.ProviderTrackingRuntime {
  final List<provider_tracking.ProviderTrackingStatus> started = [];
  final List<provider_tracking.ProviderTrackingStatus> updated = [];
  int stopCalls = 0;
  int clearQueueCalls = 0;
  bool _running = false;
  provider_tracking.ProviderTrackingStatus? _status;

  @override
  Future<void> clearQueue() async => clearQueueCalls += 1;

  @override
  Future<void> dispose() async {}

  @override
  Future<bool> isRunning() async => _running;

  @override
  bool matches(provider_tracking.ProviderTrackingStatus status) =>
      _running &&
      _status?.requestId == status.requestId &&
      _status?.status == status.status &&
      _status?.onTheWayCadenceMs == status.onTheWayCadenceMs &&
      _status?.inProgressCadenceMs == status.inProgressCadenceMs;

  @override
  Future<void> start(
    provider_tracking.ProviderTrackingStatus status,
    String token,
  ) async {
    _running = true;
    _status = status;
    started.add(status);
  }

  @override
  Future<void> stop() async {
    _running = false;
    _status = null;
    stopCalls += 1;
  }

  @override
  Future<void> update(
    provider_tracking.ProviderTrackingStatus status,
    String token,
  ) async {
    _status = status;
    updated.add(status);
  }
}
