import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:moeen_mobile/provider_location.dart';

const _positionJson = {
  'requestId': 'MOE-1042',
  'latitude': 26.359123,
  'longitude': 43.981988,
  'accuracyMeters': 12,
  'capturedAt': '2026-08-30T12:00:00.000Z',
  'receivedAt': '2026-08-30T12:00:01.000Z',
  'arrivalObserved': false,
};

http.Response _ok([Map<String, dynamic>? body]) => http.Response(
  jsonEncode(body ?? _positionJson),
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

void main() {
  test(
    'fetchProviderLocation accepts fractional device accuracy on 200',
    () async {
      final client = MockClient((request) async {
        expect(
          request.url.path,
          '/my/service-requests/MOE-1042/provider-location',
        );
        expect(request.headers['Authorization'], 'Bearer token-1');
        return _ok({..._positionJson, 'accuracyMeters': 9.5});
      });

      final poll = await fetchProviderLocation(
        requestId: 'MOE-1042',
        token: 'token-1',
        client: client,
        endpoint: Uri.parse(
          'https://api.example.test/my/service-requests/MOE-1042/provider-location',
        ),
      );

      expect(poll.result, ProviderLocationPollResult.position);
      final position = poll.position!;
      expect(position.latitude, 26.359123);
      expect(position.longitude, 43.981988);
      expect(position.accuracyMeters, 9.5);
      expect(position.arrivalObserved, isFalse);
      expect(position.receivedAt, '2026-08-30T12:00:01.000Z');
    },
  );

  test('fetchProviderLocation rejects invalid device accuracy', () async {
    for (final accuracy in [-1, double.infinity]) {
      final client = MockClient(
        (_) async => _ok({..._positionJson, 'accuracyMeters': accuracy}),
      );

      final poll = await fetchProviderLocation(
        requestId: 'MOE-1042',
        token: 'token-1',
        client: client,
        endpoint: Uri.parse(
          'https://api.example.test/my/service-requests/MOE-1042/provider-location',
        ),
      );

      expect(poll.result, ProviderLocationPollResult.error);
    }
  });

  test('fetchProviderLocation maps 404 to unavailable', () async {
    final client = MockClient((_) async => http.Response('{}', 404));

    final poll = await fetchProviderLocation(
      requestId: 'MOE-1042',
      token: 'token-1',
      client: client,
      endpoint: Uri.parse(
        'https://api.example.test/my/service-requests/MOE-1042/provider-location',
      ),
    );

    expect(poll.result, ProviderLocationPollResult.unavailable);
    expect(poll.position, isNull);
  });

  test('fetchProviderLocation maps 401 to unauthorized', () async {
    final client = MockClient((_) async => http.Response('{}', 401));

    final poll = await fetchProviderLocation(
      requestId: 'MOE-1042',
      token: 'token-1',
      client: client,
      endpoint: Uri.parse(
        'https://api.example.test/my/service-requests/MOE-1042/provider-location',
      ),
    );

    expect(poll.result, ProviderLocationPollResult.unauthorized);
  });

  test('fetchProviderLocation maps transport failure to error', () async {
    final client = MockClient(
      (_) async => throw http.ClientException('offline'),
    );

    final poll = await fetchProviderLocation(
      requestId: 'MOE-1042',
      token: 'token-1',
      client: client,
      endpoint: Uri.parse(
        'https://api.example.test/my/service-requests/MOE-1042/provider-location',
      ),
    );

    expect(poll.result, ProviderLocationPollResult.error);
  });

  test('fetchProviderLocation maps 500 and malformed bodies to error', () async {
    final serverError = MockClient((_) async => http.Response('{}', 500));
    final malformed = MockClient(
      (_) async => http.Response('{"latitude": "nope"}', 200),
    );

    final first = await fetchProviderLocation(
      requestId: 'MOE-1042',
      token: 'token-1',
      client: serverError,
      endpoint: Uri.parse(
        'https://api.example.test/my/service-requests/MOE-1042/provider-location',
      ),
    );
    final second = await fetchProviderLocation(
      requestId: 'MOE-1042',
      token: 'token-1',
      client: malformed,
      endpoint: Uri.parse(
        'https://api.example.test/my/service-requests/MOE-1042/provider-location',
      ),
    );

    expect(first.result, ProviderLocationPollResult.error);
    expect(second.result, ProviderLocationPollResult.error);
  });

  test(
    'fetchProviderLocation rejects an out-of-range position as error',
    () async {
      final client = MockClient(
        (_) async => _ok({..._positionJson, 'latitude': 91.0}),
      );

      final poll = await fetchProviderLocation(
        requestId: 'MOE-1042',
        token: 'token-1',
        client: client,
        endpoint: Uri.parse(
          'https://api.example.test/my/service-requests/MOE-1042/provider-location',
        ),
      );

      expect(poll.result, ProviderLocationPollResult.error);
    },
  );
}
