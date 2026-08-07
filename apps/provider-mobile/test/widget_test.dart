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
