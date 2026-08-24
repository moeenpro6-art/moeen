import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:moeen_provider/main.dart';
import 'package:moeen_provider/provider_tracking.dart';

void main() {
  test(
    'reads current provider tracking authority with the provider session',
    () async {
      late http.Request request;
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: MockClient((value) async {
          request = value;
          return http.Response(
            '{"tracking":{"active":true,"requestId":"MOE-1001",'
            '"status":"on_the_way","onTheWayCadenceMs":15000,'
            '"inProgressCadenceMs":60000}}',
            200,
            headers: const {'content-type': 'application/json; charset=utf-8'},
          );
        }),
      );

      final tracking = await api.getTrackingStatus(
        'provider-session',
        'MOE-1001',
      );

      expect(request.method, 'GET');
      expect(request.url.path, '/provider/service-requests/MOE-1001/tracking');
      expect(request.headers['authorization'], 'Bearer provider-session');
      expect(tracking.active, isTrue);
      expect(tracking.cadenceMs, 15000);
    },
  );

  test(
    'maps a missing tracking authority to a fail-closed not-found result',
    () async {
      final api = ProviderApi(
        baseUrl: 'https://api.example.test',
        client: MockClient(
          (_) async => http.Response(
            '{"message":"Provider tracking request not found"}',
            404,
            headers: const {'content-type': 'application/json; charset=utf-8'},
          ),
        ),
      );

      await expectLater(
        api.getTrackingStatus('provider-session', 'MOE-1001'),
        throwsA(isA<ProviderTrackingNotFoundException>()),
      );
    },
  );

  test('maps an expired provider session while recovering tracking', () async {
    final api = ProviderApi(
      baseUrl: 'https://api.example.test',
      client: MockClient(
        (_) async => http.Response(
          '{"message":"Unauthorized"}',
          401,
          headers: const {'content-type': 'application/json; charset=utf-8'},
        ),
      ),
    );

    await expectLater(
      api.getTrackingStatus('expired-session', 'MOE-1001'),
      throwsA(isA<ProviderUnauthorizedException>()),
    );
  });
}
