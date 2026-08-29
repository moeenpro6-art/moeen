import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:moeen_mobile/api_config.dart';
import 'package:moeen_mobile/customer_session.dart';
import 'package:moeen_mobile/main.dart';
import 'package:moeen_mobile/service_location.dart';
import 'package:moeen_mobile/service_location_picker_page.dart';

void main() {
  testWidgets('booking renders an Arabic picker action without an inline map', (
    tester,
  ) async {
    await _pumpBooking(
      tester,
      mode: ServiceLocationMode.required,
      client: MockClient((request) async => http.Response('{}', 500)),
    );

    expect(find.text('تحديد موقع الخدمة على الخريطة'), findsOneWidget);
    expect(
      find.byKey(const Key('customer_service_location_fullscreen_map')),
      findsNothing,
    );
    expect(
      find.byKey(const Key('booking_location_status_card')),
      findsOneWidget,
    );
  });

  testWidgets('picker confirmation updates the form without submitting', (
    tester,
  ) async {
    final requests = <http.Request>[];
    await _pumpBooking(
      tester,
      mode: ServiceLocationMode.required,
      client: MockClient((request) async {
        requests.add(request);
        return http.Response('{}', 500);
      }),
      mapSurfaceBuilder: _testMapSurfaceBuilder,
    );

    await _confirmDraftPoint(tester);

    expect(requests, isEmpty);
    expect(find.text('تم تأكيد موقع الخدمة'), findsOneWidget);
    expect(find.text('تعديل موقع الخدمة على الخريطة'), findsOneWidget);
  });

  testWidgets('editing address preserves the confirmed point in JSON payload', (
    tester,
  ) async {
    http.Request? captured;
    await _pumpBooking(
      tester,
      mode: ServiceLocationMode.required,
      client: MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({'id': 'MOE-902'}),
          201,
          headers: const {'content-type': 'application/json; charset=utf-8'},
        );
      }),
      mapSurfaceBuilder: _testMapSurfaceBuilder,
    );
    await _confirmDraftPoint(tester);

    const editedAddress = 'حي الصفراء، بريدة، شارع الملك عبدالعزيز';
    await tester.enterText(find.byType(TextFormField).first, editedAddress);
    await tester.tap(find.text('متابعة الطلب'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(captured, isNotNull);
    final payload = jsonDecode(captured!.body) as Map<String, dynamic>;
    final location = payload['location'] as Map<String, dynamic>;
    expect(payload['address'], editedAddress);
    expect(location['displayAddress'], editedAddress);
    expect(location['confirmed'], isTrue);
    expect(location['source'], 'map_pin');
  });

  testWidgets(
    'blank address blocks booking without discarding confirmed point',
    (tester) async {
      final requests = <http.Request>[];
      await _pumpBooking(
        tester,
        mode: ServiceLocationMode.required,
        client: MockClient((request) async {
          requests.add(request);
          return http.Response('{}', 500);
        }),
        mapSurfaceBuilder: _testMapSurfaceBuilder,
      );
      await _confirmDraftPoint(tester);

      await tester.enterText(find.byType(TextFormField).first, '');
      await tester.tap(find.text('متابعة الطلب'));
      await tester.pump();

      expect(requests, isEmpty);
      expect(find.text('أدخل عنوان الخدمة'), findsOneWidget);
      expect(find.text('تم تأكيد موقع الخدمة'), findsOneWidget);
    },
  );

  testWidgets(
    'too-short address blocks booking without discarding confirmed point',
    (tester) async {
      final requests = <http.Request>[];
      await _pumpBooking(
        tester,
        mode: ServiceLocationMode.required,
        client: MockClient((request) async {
          requests.add(request);
          return http.Response('{}', 500);
        }),
        mapSurfaceBuilder: _testMapSurfaceBuilder,
      );
      await _confirmDraftPoint(tester);

      await tester.enterText(find.byType(TextFormField).first, 'حي');
      await tester.tap(find.text('متابعة الطلب'));
      await tester.pump();

      expect(requests, isEmpty);
      expect(find.text('أدخل 3 أحرف على الأقل لعنوان الخدمة'), findsOneWidget);
      expect(find.text('تم تأكيد موقع الخدمة'), findsOneWidget);
    },
  );

  testWidgets(
    'required mode blocks a legacy booking without confirmed location',
    (tester) async {
      final requests = <http.Request>[];
      await _pumpBooking(
        tester,
        mode: ServiceLocationMode.required,
        client: MockClient((request) async {
          requests.add(request);
          return http.Response(jsonEncode({'id': 'MOE-900'}), 201);
        }),
      );

      await tester.enterText(
        find.byType(TextFormField).first,
        'حي الصفراء، بريدة',
      );
      await tester.tap(find.text('متابعة الطلب'));
      await tester.pump();

      expect(requests, isEmpty);
      expect(
        find.text('حدد موقع الخدمة ثم أكد اختياره قبل إرسال الطلب.'),
        findsOneWidget,
      );
    },
  );

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

    await tester.enterText(
      find.byType(TextFormField).first,
      'حي الصفراء، بريدة',
    );
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
  ServiceLocationMapSurfaceBuilder? mapSurfaceBuilder,
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
        serviceLocationMapSurfaceBuilder: mapSurfaceBuilder,
      ),
    ),
  );
}

Future<void> _confirmDraftPoint(WidgetTester tester) async {
  await tester.tap(find.text('تحديد موقع الخدمة على الخريطة'));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const Key('simulate_camera_move')));
  await tester.tap(find.text('تأكيد موقع الخدمة'));
  await tester.pumpAndSettle();
}

Widget _testMapSurfaceBuilder(
  BuildContext context, {
  required ServiceLocationPoint initialPoint,
  required ServiceLocationCameraChanged onCameraChanged,
  required ServiceLocationManualCameraIntent onManualCameraMove,
  required ValueChanged<ServiceLocationMapCamera> onCameraReady,
}) {
  onCameraReady(_FakeMapCamera());
  return ColoredBox(
    key: const Key('test_map_surface'),
    color: Colors.tealAccent,
    child: Center(
      child: FilledButton(
        key: const Key('simulate_camera_move'),
        onPressed: () {
          final intentGeneration = onManualCameraMove();
          if (intentGeneration == null) return;
          onCameraChanged(
            const ServiceLocationPoint(
              latitude: 26.360001,
              longitude: 43.980001,
            ),
            intentGeneration,
          );
        },
        child: const Text('تحريك تجريبي'),
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

class _FakeMapCamera implements ServiceLocationMapCamera {
  @override
  Future<void> moveTo(ServiceLocationPoint point) async {}

  @override
  Future<ServiceLocationPoint> snapshotCurrentCenter() async =>
      const ServiceLocationPoint(latitude: 26.360001, longitude: 43.980001);
}
