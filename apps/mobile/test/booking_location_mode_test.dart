import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:moeen_mobile/api_config.dart';
import 'package:moeen_mobile/customer_session.dart';
import 'package:moeen_mobile/main.dart';
import 'package:moeen_mobile/service_location.dart';

void main() {
  testWidgets('required mode blocks a legacy booking without confirmed location', (
    tester,
  ) async {
    final requests = <http.Request>[];
    await _pumpBooking(
      tester,
      mode: ServiceLocationMode.required,
      client: MockClient((request) async {
        requests.add(request);
        return http.Response(jsonEncode({'id': 'MOE-900'}), 201);
      }),
    );

    await tester.enterText(find.byType(TextFormField).first, 'حي الصفراء، بريدة');
    await tester.tap(find.text('متابعة الطلب'));
    await tester.pump();

    expect(requests, isEmpty);
    expect(find.text('حدد موقع الخدمة ثم أكد اختياره قبل إرسال الطلب.'), findsOneWidget);
  });

  testWidgets('optional mode preserves the address-only JSON booking path', (
    tester,
  ) async {
    http.Request? captured;
    await _pumpBooking(
      tester,
      mode: ServiceLocationMode.optional,
      client: MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({'id': 'MOE-901'}),
          201,
          headers: const {'content-type': 'application/json; charset=utf-8'},
        );
      }),
    );

    await tester.enterText(find.byType(TextFormField).first, 'حي الصفراء، بريدة');
    await tester.tap(find.text('متابعة الطلب'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(captured, isNotNull);
    final payload = jsonDecode(captured!.body) as Map<String, dynamic>;
    expect(payload, isNot(contains('location')));
    expect(_idempotencyKey(captured!), isNull);
  });
}

Future<void> _pumpBooking(
  WidgetTester tester, {
  required ServiceLocationMode mode,
  required http.Client client,
}) async {
  tester.view.physicalSize = const Size(800, 2200);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  final store = _MemorySessionStore();
  final sessionManager = CustomerSessionManager(store);
  await sessionManager.save(token: 'token-1', customerId: 'cus-1');
  await tester.pumpWidget(
    MaterialApp(
      home: BookingPage(
        service: MoeenApp.launchServices.first,
        sessionManager: sessionManager,
        httpClient: client,
        apiConfig: const MoeenApiConfig('https://api.example.test'),
        serviceLocationMode: mode,
        locationPlatform: _NoopLocationPlatform(),
      ),
    ),
  );
}

String? _idempotencyKey(http.Request request) => request.headers.entries
    .where((entry) => entry.key.toLowerCase() == 'idempotency-key')
    .map((entry) => entry.value)
    .cast<String?>()
    .firstOrNull;

class _MemorySessionStore implements SessionKeyValueStore {
  final Map<String, String> _values = {};

  @override
  Future<void> deleteAll() async => _values.clear();

  @override
  Future<String?> read(String key) async => _values[key];

  @override
  Future<void> write(String key, String value) async => _values[key] = value;
}

class _NoopLocationPlatform implements CustomerLocationPlatform {
  @override
  Future<ServiceLocationPoint> getCurrentPosition() =>
      Future<ServiceLocationPoint>.error(StateError('not called'));

  @override
  Future<bool> openAppSettings() async => false;

  @override
  Future<CustomerLocationPermission> requestForegroundPermission() async =>
      CustomerLocationPermission.denied;
}
