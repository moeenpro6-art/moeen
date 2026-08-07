import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:moeen_provider/main.dart';

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

  test('provider api keeps reporting server errors as generic failures', () async {
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
  });

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

      await tester.pumpWidget(MoeenProviderApp(api: api, sessionStore: store));
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

      await tester.pumpWidget(MoeenProviderApp(api: api, sessionStore: store));
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

    await tester.pumpWidget(MoeenProviderApp(api: api, sessionStore: store));
    await tester.pumpAndSettle();

    expect(find.text('فرص العمل المتاحة'), findsOneWidget);
    expect(find.text('تنظيف المكيفات'), findsOneWidget);
    expect(find.text('في أقرب وقت · مدعو'), findsOneWidget);
    expect(find.text('تقديم عرض'), findsOneWidget);
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

    await tester.pumpWidget(MoeenProviderApp(api: api, sessionStore: store));
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

      await tester.pumpWidget(MoeenProviderApp(api: api, sessionStore: store));
      await tester.pumpAndSettle();

      await tester.tap(find.text('تقديم عرض'));
      await tester.pumpAndSettle();
      expect(find.text('تقديم عرض — تنظيف المكيفات'), findsOneWidget);

      await tester.enterText(
        find.byType(TextField).at(0),
        '150',
      );
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

      await tester.pumpWidget(MoeenProviderApp(api: api, sessionStore: store));
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

      await tester.pumpWidget(MoeenProviderApp(api: api, sessionStore: store));
      await tester.pumpAndSettle();

      expect(
        find.text('تعذر تحميل الفرص. حاول مرة أخرى.'),
        findsOneWidget,
      );

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

      await tester.pumpWidget(MoeenProviderApp(api: api, sessionStore: store));
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

      await tester.pumpWidget(MoeenProviderApp(api: api, sessionStore: store));
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

const _providerJson =
    '{"id":"provider-1","name":"مقدم اختبار","specialties":["ac-cleaning"],'
    '"serviceZone":"بريدة","available":true}';

const _jsonUtf8 = {'content-type': 'application/json; charset=utf-8'};

const _opportunitiesInvitedJson =
    '[{"requestId":"MOE-1","serviceId":"ac-cleaning",'
    '"timing":"as-soon-as-possible","opportunityStatus":"invited"}]';

const _opportunitiesQuotedJson =
    '[{"requestId":"MOE-1","serviceId":"ac-cleaning",'
    '"timing":"as-soon-as-possible","opportunityStatus":"quoted",'
    '"myQuote":{"id":"QTE-1","providerId":"provider-1",'
    '"amountHalalas":15000,"scope":"full clean","status":"proposed",'
    '"proposedAt":"2026-08-07T00:00:00.000Z"}}]';

const _quoteCreatedJson =
    '{"id":"QTE-1","providerId":"provider-1","amountHalalas":15000,'
    '"scope":"full clean","status":"proposed",'
    '"proposedAt":"2026-08-07T00:00:00.000Z"}';

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
