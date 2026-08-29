import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:moeen_mobile/service_location.dart';
import 'package:moeen_mobile/service_location_picker_page.dart';

const _previousPoint = ServiceLocationPoint(
  latitude: 26.359123,
  longitude: 43.981988,
);
const _draftPoint = ServiceLocationPoint(
  latitude: 26.360001,
  longitude: 43.980001,
);
const _gpsPoint = ServiceLocationPoint(
  latitude: 26.361111,
  longitude: 43.982222,
);

void main() {
  testWidgets('full-screen picker renders the Arabic controls and center pin', (
    tester,
  ) async {
    await _pumpPicker(
      tester,
      platform: _FakeLocationPlatform(
        permission: CustomerLocationPermission.denied,
      ),
    );

    expect(find.text('تحديد موقع الخدمة'), findsOneWidget);
    expect(find.text('إلغاء'), findsOneWidget);
    expect(find.text('موقعي الحالي'), findsOneWidget);
    expect(find.text('تأكيد موقع الخدمة'), findsOneWidget);
    expect(
      find.byKey(const Key('service_location_center_pin')),
      findsOneWidget,
    );
    expect(
      find.byKey(const Key('service_location_confirm_bar')),
      findsOneWidget,
    );
    expect(find.byKey(const Key('test_map_surface')), findsOneWidget);
  });

  testWidgets('camera draft does not mutate the parent before confirmation', (
    tester,
  ) async {
    final harnessKey = GlobalKey<_PickerRouteHarnessState>();
    await _pumpHarness(tester, harnessKey);

    await tester.tap(find.text('فتح محدد الموقع'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('simulate_camera_move')));
    await tester.pump();

    expect(harnessKey.currentState!.applyCount, 0);
    expect(harnessKey.currentState!.address, 'حي الصفراء، بريدة');
    expect(harnessKey.currentState!.controller.selection?.toJson(), {
      'point': {'latitude': 26.359123, 'longitude': 43.981988},
      'displayAddress': 'حي الصفراء، بريدة',
      'source': 'map_pin',
      'confirmed': true,
    });
  });

  testWidgets(
    'camera draft rebuild keeps the map surface initial point stable',
    (tester) async {
      final initialPoints = <ServiceLocationPoint>[];
      await _pumpPicker(
        tester,
        platform: _FakeLocationPlatform(
          permission: CustomerLocationPermission.denied,
        ),
        mapSurfaceBuilder: _recordingMapSurfaceBuilder(initialPoints),
      );

      await tester.tap(find.byKey(const Key('simulate_camera_move')));
      await tester.pump();

      expect(initialPoints.length, greaterThan(1));
      expect(initialPoints.first.latitude, _previousPoint.latitude);
      expect(initialPoints.last.latitude, _previousPoint.latitude);
      expect(initialPoints.last.longitude, _previousPoint.longitude);
    },
  );

  testWidgets(
    'Mapbox surface reuses its initial viewport object across rebuilds',
    (tester) async {
      final viewports = <Object>[];

      Widget surface(ServiceLocationPoint point) => Directionality(
        textDirection: TextDirection.rtl,
        child: buildMapboxServiceLocationSurfaceForTesting(
          initialPoint: point,
          onCameraChanged: (_, _) {},
          onManualCameraMove: () => 0,
          onCameraReady: (_) {},
          mapWidgetBuilder: (viewport) {
            viewports.add(viewport);
            return const ColoredBox(color: Colors.tealAccent);
          },
        ),
      );

      await tester.pumpWidget(surface(_previousPoint));
      await tester.pumpWidget(surface(_draftPoint));

      expect(viewports, hasLength(2));
      expect(identical(viewports.first, viewports.last), isTrue);
    },
  );

  testWidgets('toolbar back preserves the prior confirmed point and address', (
    tester,
  ) async {
    final harnessKey = GlobalKey<_PickerRouteHarnessState>();
    await _openAndMoveDraft(tester, harnessKey);

    await tester.tap(find.byTooltip('رجوع'));
    await tester.pumpAndSettle();

    _expectPriorSelectionPreserved(harnessKey);
  });

  testWidgets(
    'explicit cancel preserves the prior confirmed point and address',
    (tester) async {
      final harnessKey = GlobalKey<_PickerRouteHarnessState>();
      await _openAndMoveDraft(tester, harnessKey);

      await tester.tap(find.text('إلغاء'));
      await tester.pumpAndSettle();

      _expectPriorSelectionPreserved(harnessKey);
    },
  );

  testWidgets(
    'Android system back preserves prior confirmed point and address',
    (tester) async {
      final harnessKey = GlobalKey<_PickerRouteHarnessState>();
      await _openAndMoveDraft(tester, harnessKey);

      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();

      _expectPriorSelectionPreserved(harnessKey);
    },
  );

  testWidgets('confirm returns the draft point and source exactly once', (
    tester,
  ) async {
    final harnessKey = GlobalKey<_PickerRouteHarnessState>();
    await _openAndMoveDraft(tester, harnessKey);

    await tester.tap(find.text('تأكيد موقع الخدمة'));
    await tester.pumpAndSettle();

    expect(harnessKey.currentState!.applyCount, 1);
    expect(
      harnessKey.currentState!.controller.selection?.point.latitude,
      26.360001,
    );
    expect(
      harnessKey.currentState!.controller.selection?.point.longitude,
      43.980001,
    );
    expect(
      harnessKey.currentState!.controller.selection?.source,
      ServiceLocationSource.mapPin,
    );
    expect(harnessKey.currentState!.controller.selection?.confirmed, isTrue);
    expect(harnessKey.currentState!.address, 'حي الصفراء، بريدة');
  });

  testWidgets(
    'confirm awaits the latest visible camera center and returns it once',
    (tester) async {
      final camera = _DelayedSnapshotMapCamera();
      final results = <ServiceLocationPickerResult>[];
      await _pumpPicker(
        tester,
        platform: _FakeLocationPlatform(
          permission: CustomerLocationPermission.denied,
        ),
        mapSurfaceBuilder: _mapSurfaceBuilderWithCamera(camera),
        onResult: results.add,
      );

      await tester.tap(find.text('تأكيد موقع الخدمة'));
      await tester.tap(find.text('تأكيد موقع الخدمة'));
      await tester.pump();

      expect(camera.snapshotCount, 1);
      expect(results, isEmpty);

      camera.completeSnapshot(_draftPoint);
      await tester.pumpAndSettle();

      expect(camera.snapshotCount, 1);
      expect(results, hasLength(1));
      expect(results.single.point.latitude, _draftPoint.latitude);
      expect(results.single.point.longitude, _draftPoint.longitude);
      expect(results.single.source, ServiceLocationSource.mapPin);
    },
  );

  testWidgets('confirm falls back safely when camera snapshot fails', (
    tester,
  ) async {
    ServiceLocationPickerResult? result;
    await _pumpPicker(
      tester,
      platform: _FakeLocationPlatform(
        permission: CustomerLocationPermission.denied,
      ),
      mapSurfaceBuilder: _mapSurfaceBuilderWithCamera(
        _FailingSnapshotMapCamera(),
      ),
      onResult: (value) => result = value,
    );

    await tester.tap(find.text('تأكيد موقع الخدمة'));
    await tester.pumpAndSettle();

    expect(result?.point.latitude, _previousPoint.latitude);
    expect(result?.point.longitude, _previousPoint.longitude);
    expect(result?.source, ServiceLocationSource.mapPin);
  });

  testWidgets('cancel wins safely while camera confirmation is pending', (
    tester,
  ) async {
    final camera = _DelayedSnapshotMapCamera();
    final results = <ServiceLocationPickerResult>[];
    await _pumpPicker(
      tester,
      platform: _FakeLocationPlatform(
        permission: CustomerLocationPermission.denied,
      ),
      mapSurfaceBuilder: _mapSurfaceBuilderWithCamera(camera),
      onResult: results.add,
    );

    await tester.tap(find.text('تأكيد موقع الخدمة'));
    await tester.pump();
    await tester.tap(find.text('إلغاء'));
    await tester.pumpAndSettle();

    expect(results, isEmpty);
    expect(find.text('فتح'), findsOneWidget);

    camera.completeSnapshot(_draftPoint);
    await tester.pumpAndSettle();

    expect(results, isEmpty);
    expect(find.text('فتح'), findsOneWidget);
  });

  testWidgets(
    'delayed GPS permission keeps interaction and confirmation serialized',
    (tester) async {
      final platform = _DelayedPermissionPlatform();
      final camera = _TrackingMapCamera(_previousPoint);
      final results = <ServiceLocationPickerResult>[];
      await _pumpPicker(
        tester,
        platform: platform,
        mapSurfaceBuilder: _manualCameraMapSurfaceBuilder(camera),
        onResult: results.add,
      );

      final queuedConfirmAction = tester
          .widget<FilledButton>(
            find.widgetWithText(FilledButton, 'تأكيد موقع الخدمة'),
          )
          .onPressed!;
      await tester.tap(find.text('موقعي الحالي'));
      await tester.pump();

      expect(platform.permissionRequested, isTrue);
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'تأكيد موقع الخدمة'),
            )
            .onPressed,
        isNull,
      );

      await tester.tap(
        find.byKey(const Key('simulate_camera_move')),
        warnIfMissed: false,
      );
      queuedConfirmAction();
      await tester.pump();

      expect(camera.visiblePoint, _previousPoint);
      expect(results, isEmpty);

      platform.completePermission(CustomerLocationPermission.denied);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('simulate_camera_move')));
      await tester.pump();
      await tester.tap(find.text('تأكيد موقع الخدمة'));
      await tester.pumpAndSettle();

      expect(results, hasLength(1));
      expect(results.single.point, _draftPoint);
      expect(results.single.source, ServiceLocationSource.mapPin);
    },
  );

  testWidgets(
    'delayed GPS lookup serializes manual movement and confirmation',
    (tester) async {
      final platform = _DelayedLocationPlatform();
      final camera = _DelayedSnapshotMapCamera();
      final results = <ServiceLocationPickerResult>[];
      await _pumpPicker(
        tester,
        platform: platform,
        mapSurfaceBuilder: _manualIntentMapSurfaceBuilder(camera),
        onResult: results.add,
      );

      await tester.tap(find.text('موقعي الحالي'));
      await tester.pump();
      expect(platform.positionRequested, isTrue);

      await tester.tap(
        find.byKey(const Key('simulate_camera_move')),
        warnIfMissed: false,
      );
      await tester.tap(find.text('تأكيد موقع الخدمة'), warnIfMissed: false);
      await tester.pump();

      expect(camera.moveCount, 0);
      expect(camera.snapshotCount, 0);
      expect(results, isEmpty);

      platform.completePosition(_gpsPoint);
      await tester.pump();
      await tester.pump();

      expect(camera.moveCount, 1);
      expect(camera.snapshotCount, 1);
      camera.completeSnapshot(_gpsPoint);
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('simulate_camera_move')));
      await tester.pump();
      await tester.tap(find.text('تأكيد موقع الخدمة'));
      await tester.pumpAndSettle();

      expect(results, hasLength(1));
      expect(results.single.point, _gpsPoint);
      expect(results.single.source, ServiceLocationSource.mapPin);
    },
  );

  testWidgets(
    'delayed GPS snapshot keeps interaction and confirmation serialized',
    (tester) async {
      final camera = _DelayedSnapshotMapCamera();
      final results = <ServiceLocationPickerResult>[];
      await _pumpPicker(
        tester,
        platform: _FakeLocationPlatform(
          permission: CustomerLocationPermission.granted,
          point: _gpsPoint,
        ),
        mapSurfaceBuilder: _manualIntentMapSurfaceBuilder(camera),
        onResult: results.add,
      );

      final queuedConfirmAction = tester
          .widget<FilledButton>(
            find.widgetWithText(FilledButton, 'تأكيد موقع الخدمة'),
          )
          .onPressed!;
      await tester.tap(find.text('موقعي الحالي'));
      await tester.pump();

      expect(camera.moveCount, 1);
      expect(camera.snapshotCount, 1);
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'تأكيد موقع الخدمة'),
            )
            .onPressed,
        isNull,
      );

      await tester.tap(
        find.byKey(const Key('simulate_camera_move')),
        warnIfMissed: false,
      );
      queuedConfirmAction();
      await tester.pump();

      expect(camera.snapshotCount, 1);
      expect(results, isEmpty);

      camera.completeSnapshot(_gpsPoint);
      await tester.pumpAndSettle();
      await tester.tap(find.text('تأكيد موقع الخدمة'));
      await tester.pumpAndSettle();

      expect(camera.snapshotCount, 2);
      expect(results, hasLength(1));
      expect(results.single.point, _gpsPoint);
      expect(results.single.source, ServiceLocationSource.currentLocation);
    },
  );

  testWidgets(
    'delayed GPS camera move serializes manual movement and confirmation',
    (tester) async {
      final camera = _DelayedMoveMapCamera(_previousPoint);
      final results = <ServiceLocationPickerResult>[];
      await _pumpPicker(
        tester,
        platform: _FakeLocationPlatform(
          permission: CustomerLocationPermission.granted,
          point: _gpsPoint,
        ),
        mapSurfaceBuilder: _manualCameraMapSurfaceBuilder(camera),
        onResult: results.add,
      );

      final queuedConfirmAction = tester
          .widget<FilledButton>(
            find.widgetWithText(FilledButton, 'تأكيد موقع الخدمة'),
          )
          .onPressed!;
      await tester.tap(find.text('موقعي الحالي'));
      await tester.pump();

      expect(camera.moveCount, 1);
      expect(camera.visiblePoint, _previousPoint);
      final mapInteractionGuard = tester.widget<IgnorePointer>(
        find
            .ancestor(
              of: find.byKey(const Key('simulate_camera_move')),
              matching: find.byType(IgnorePointer),
            )
            .first,
      );
      expect(mapInteractionGuard.ignoring, isTrue);
      final confirmButton = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'تأكيد موقع الخدمة'),
      );
      expect(confirmButton.onPressed, isNull);

      await tester.tap(
        find.byKey(const Key('simulate_camera_move')),
        warnIfMissed: false,
      );
      await tester.tap(find.text('تأكيد موقع الخدمة'), warnIfMissed: false);
      queuedConfirmAction();
      await tester.pump();

      expect(camera.visiblePoint, _previousPoint);
      expect(camera.snapshotCount, 0);
      expect(results, isEmpty);

      camera.completeMove();
      await tester.pumpAndSettle();

      expect(camera.visiblePoint, _gpsPoint);
      expect(camera.snapshotCount, 1);
      expect(results, isEmpty);
      expect(
        tester
            .widget<IgnorePointer>(
              find
                  .ancestor(
                    of: find.byKey(const Key('simulate_camera_move')),
                    matching: find.byType(IgnorePointer),
                  )
                  .first,
            )
            .ignoring,
        isFalse,
      );

      await tester.tap(find.byKey(const Key('simulate_camera_move')));
      await tester.pump();
      await tester.tap(find.text('تأكيد موقع الخدمة'));
      await tester.pumpAndSettle();

      expect(camera.visiblePoint, _draftPoint);
      expect(camera.snapshotCount, 2);
      expect(results, hasLength(1));
      expect(results.single.point, _draftPoint);
      expect(results.single.source, ServiceLocationSource.mapPin);
    },
  );

  testWidgets('toolbar back wins while a GPS camera move is pending', (
    tester,
  ) async {
    final camera = _DelayedMoveMapCamera(_previousPoint);
    final results = <ServiceLocationPickerResult>[];
    await _pumpPicker(
      tester,
      platform: _FakeLocationPlatform(
        permission: CustomerLocationPermission.granted,
        point: _gpsPoint,
      ),
      mapSurfaceBuilder: _mapSurfaceBuilderWithCamera(camera),
      onResult: results.add,
    );

    await tester.tap(find.text('موقعي الحالي'));
    await tester.pump();
    expect(camera.moveCount, 1);

    await tester.tap(find.byTooltip('رجوع'));
    await tester.pumpAndSettle();

    expect(results, isEmpty);
    expect(find.text('فتح'), findsOneWidget);

    camera.completeMove();
    await tester.pumpAndSettle();

    expect(results, isEmpty);
    expect(find.text('فتح'), findsOneWidget);
  });

  testWidgets('toolbar cancel wins while a GPS camera move is pending', (
    tester,
  ) async {
    final camera = _DelayedMoveMapCamera(_previousPoint);
    final results = <ServiceLocationPickerResult>[];
    await _pumpPicker(
      tester,
      platform: _FakeLocationPlatform(
        permission: CustomerLocationPermission.granted,
        point: _gpsPoint,
      ),
      mapSurfaceBuilder: _mapSurfaceBuilderWithCamera(camera),
      onResult: results.add,
    );

    await tester.tap(find.text('موقعي الحالي'));
    await tester.pump();
    expect(camera.moveCount, 1);

    await tester.tap(find.text('إلغاء'));
    await tester.pumpAndSettle();

    expect(results, isEmpty);
    expect(find.text('فتح'), findsOneWidget);

    camera.completeMove();
    await tester.pumpAndSettle();

    expect(results, isEmpty);
    expect(find.text('فتح'), findsOneWidget);
  });

  testWidgets('system back invalidates GPS work during route exit', (
    tester,
  ) async {
    final camera = _DelayedMoveMapCamera(_previousPoint);
    final results = <ServiceLocationPickerResult>[];
    await _pumpPicker(
      tester,
      platform: _FakeLocationPlatform(
        permission: CustomerLocationPermission.granted,
        point: _gpsPoint,
      ),
      mapSurfaceBuilder: _mapSurfaceBuilderWithCamera(camera),
      onResult: results.add,
    );

    final queuedConfirmAction = tester
        .widget<FilledButton>(
          find.widgetWithText(FilledButton, 'تأكيد موقع الخدمة'),
        )
        .onPressed!;
    await tester.tap(find.text('موقعي الحالي'));
    await tester.pump();
    expect(camera.moveCount, 1);

    await tester.binding.handlePopRoute();
    await tester.pump();

    camera.completeMove();
    await tester.pump();
    queuedConfirmAction();
    await tester.pumpAndSettle();

    expect(camera.snapshotCount, 0);
    expect(results, isEmpty);
    expect(find.text('فتح'), findsOneWidget);
  });

  testWidgets(
    'failed GPS camera move keeps confirmation on the visible center pin',
    (tester) async {
      final camera = _FailingMoveMapCamera(_previousPoint);
      ServiceLocationPickerResult? result;
      await _pumpPicker(
        tester,
        platform: _FakeLocationPlatform(
          permission: CustomerLocationPermission.granted,
          point: _gpsPoint,
        ),
        mapSurfaceBuilder: _mapSurfaceBuilderWithCamera(camera),
        onResult: (value) => result = value,
      );

      await tester.tap(find.text('موقعي الحالي'));
      await tester.pumpAndSettle();

      expect(camera.moveCount, 1);
      expect(
        find.text(
          'تعذر الحصول على موقعك الحالي. حرّك الخريطة وحدد الدبوس يدوياً.',
        ),
        findsOneWidget,
      );

      await tester.tap(find.text('تأكيد موقع الخدمة'));
      await tester.pumpAndSettle();

      expect(result?.point.latitude, _previousPoint.latitude);
      expect(result?.point.longitude, _previousPoint.longitude);
      expect(result?.source, ServiceLocationSource.mapPin);
    },
  );

  testWidgets(
    'GPS is not claimed when the camera stays on the previous center',
    (tester) async {
      final camera = _NoopMoveMapCamera(_previousPoint);
      ServiceLocationPickerResult? result;
      await _pumpPicker(
        tester,
        platform: _FakeLocationPlatform(
          permission: CustomerLocationPermission.granted,
          point: _gpsPoint,
        ),
        mapSurfaceBuilder: _mapSurfaceBuilderWithCamera(camera),
        onResult: (value) => result = value,
      );

      await tester.tap(find.text('موقعي الحالي'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('تأكيد موقع الخدمة'));
      await tester.pumpAndSettle();

      expect(result?.point.latitude, _previousPoint.latitude);
      expect(result?.point.longitude, _previousPoint.longitude);
      expect(result?.source, ServiceLocationSource.mapPin);
    },
  );

  testWidgets(
    'manual gesture after GPS selection returns the visible point as map pin',
    (tester) async {
      final camera = _TrackingMapCamera(_previousPoint);
      ServiceLocationPickerResult? result;
      await _pumpPicker(
        tester,
        platform: _FakeLocationPlatform(
          permission: CustomerLocationPermission.granted,
          point: _gpsPoint,
        ),
        mapSurfaceBuilder: _manualIntentMapSurfaceBuilder(camera),
        onResult: (value) => result = value,
      );

      await tester.tap(find.text('موقعي الحالي'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('simulate_camera_move')));
      await tester.pump();
      await tester.tap(find.text('تأكيد موقع الخدمة'));
      await tester.pumpAndSettle();

      expect(result?.point.latitude, _gpsPoint.latitude);
      expect(result?.point.longitude, _gpsPoint.longitude);
      expect(result?.source, ServiceLocationSource.mapPin);
    },
  );

  testWidgets(
    'stale manual camera read cannot override a later successful GPS intent',
    (tester) async {
      final camera = _TrackingMapCamera(_previousPoint);
      final manualSurface = _DelayedManualMapSurface(camera);
      ServiceLocationPickerResult? result;
      await _pumpPicker(
        tester,
        platform: _FakeLocationPlatform(
          permission: CustomerLocationPermission.granted,
          point: _gpsPoint,
        ),
        mapSurfaceBuilder: manualSurface.build,
        onResult: (value) => result = value,
      );

      await tester.tap(find.byKey(const Key('simulate_camera_move')));
      await tester.pump();
      expect(manualSurface.readStarted, isTrue);

      await tester.tap(find.text('موقعي الحالي'));
      await tester.pumpAndSettle();
      expect(camera.visiblePoint, _gpsPoint);

      manualSurface.completeRead(_draftPoint);
      await tester.pump();
      await tester.tap(find.text('تأكيد موقع الخدمة'));
      await tester.pumpAndSettle();

      expect(result?.point, _gpsPoint);
      expect(result?.source, ServiceLocationSource.currentLocation);
    },
  );

  testWidgets('GPS is claimed after the camera reaches its visible center', (
    tester,
  ) async {
    final camera = _TrackingMapCamera(_previousPoint);
    ServiceLocationPickerResult? result;
    await _pumpPicker(
      tester,
      platform: _FakeLocationPlatform(
        permission: CustomerLocationPermission.granted,
        point: _gpsPoint,
      ),
      mapSurfaceBuilder: _mapSurfaceBuilderWithCamera(camera),
      onResult: (value) => result = value,
    );

    await tester.tap(find.text('موقعي الحالي'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('تأكيد موقع الخدمة'));
    await tester.pumpAndSettle();

    expect(result?.point.latitude, _gpsPoint.latitude);
    expect(result?.point.longitude, _gpsPoint.longitude);
    expect(result?.source, ServiceLocationSource.currentLocation);
  });

  testWidgets('denied current location remains recoverable with a manual pin', (
    tester,
  ) async {
    ServiceLocationPickerResult? result;
    await _pumpPicker(
      tester,
      platform: _FakeLocationPlatform(
        permission: CustomerLocationPermission.denied,
      ),
      onResult: (value) => result = value,
    );

    await tester.tap(find.text('موقعي الحالي'));
    await tester.pumpAndSettle();

    expect(
      find.text('لم نتمكن من استخدام موقعك. حرّك الخريطة وحدد الدبوس يدوياً.'),
      findsOneWidget,
    );
    expect(find.byKey(const Key('test_map_surface')), findsOneWidget);

    await tester.tap(find.byKey(const Key('simulate_camera_move')));
    await tester.tap(find.text('تأكيد موقع الخدمة'));
    await tester.pumpAndSettle();

    expect(result?.point.latitude, 26.360001);
    expect(result?.source, ServiceLocationSource.mapPin);
  });

  testWidgets('unavailable GPS remains recoverable with a manual pin', (
    tester,
  ) async {
    await _pumpPicker(
      tester,
      platform: _FakeLocationPlatform(
        permission: CustomerLocationPermission.unavailable,
      ),
    );

    await tester.tap(find.text('موقعي الحالي'));
    await tester.pumpAndSettle();

    expect(
      find.text(
        'تعذر الحصول على موقعك الحالي. حرّك الخريطة وحدد الدبوس يدوياً.',
      ),
      findsOneWidget,
    );
    expect(find.byKey(const Key('simulate_camera_move')), findsOneWidget);
  });
}

Future<void> _pumpPicker(
  WidgetTester tester, {
  required CustomerLocationPlatform platform,
  ValueChanged<ServiceLocationPickerResult>? onResult,
  ServiceLocationMapSurfaceBuilder mapSurfaceBuilder = _testMapSurfaceBuilder,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Builder(
        builder: (context) => FilledButton(
          onPressed: () async {
            final result = await Navigator.of(context).push(
              MaterialPageRoute<ServiceLocationPickerResult>(
                builder: (_) => ServiceLocationPickerPage(
                  initialPoint: _previousPoint,
                  initialSource: ServiceLocationSource.mapPin,
                  locationPlatform: platform,
                  mapSurfaceBuilder: mapSurfaceBuilder,
                ),
              ),
            );
            if (result != null) onResult?.call(result);
          },
          child: const Text('فتح'),
        ),
      ),
    ),
  );
  await tester.tap(find.text('فتح'));
  await tester.pumpAndSettle();
}

ServiceLocationMapSurfaceBuilder _mapSurfaceBuilderWithCamera(
  ServiceLocationMapCamera camera,
) =>
    (
      BuildContext context, {
      required ServiceLocationPoint initialPoint,
      required ServiceLocationCameraChanged onCameraChanged,
      required ServiceLocationManualCameraIntent onManualCameraMove,
      required ValueChanged<ServiceLocationMapCamera> onCameraReady,
    }) {
      onCameraReady(camera);
      return const ColoredBox(
        key: Key('test_map_surface'),
        color: Colors.tealAccent,
      );
    };

ServiceLocationMapSurfaceBuilder _manualIntentMapSurfaceBuilder(
  ServiceLocationMapCamera camera,
) =>
    (
      BuildContext context, {
      required ServiceLocationPoint initialPoint,
      required ServiceLocationCameraChanged onCameraChanged,
      required ServiceLocationManualCameraIntent onManualCameraMove,
      required ValueChanged<ServiceLocationMapCamera> onCameraReady,
    }) {
      onCameraReady(camera);
      return Center(
        child: FilledButton(
          key: const Key('simulate_camera_move'),
          onPressed: onManualCameraMove,
          child: const Text('تحريك تجريبي'),
        ),
      );
    };

ServiceLocationMapSurfaceBuilder _manualCameraMapSurfaceBuilder(
  _MutableMapCamera camera,
) =>
    (
      BuildContext context, {
      required ServiceLocationPoint initialPoint,
      required ServiceLocationCameraChanged onCameraChanged,
      required ServiceLocationManualCameraIntent onManualCameraMove,
      required ValueChanged<ServiceLocationMapCamera> onCameraReady,
    }) {
      onCameraReady(camera);
      return Center(
        child: FilledButton(
          key: const Key('simulate_camera_move'),
          onPressed: () {
            camera.visiblePoint = _draftPoint;
            final intentGeneration = onManualCameraMove();
            if (intentGeneration == null) return;
            onCameraChanged(_draftPoint, intentGeneration);
          },
          child: const Text('تحريك تجريبي'),
        ),
      );
    };

class _DelayedManualMapSurface {
  _DelayedManualMapSurface(this.camera);

  final ServiceLocationMapCamera camera;
  final _read = Completer<ServiceLocationPoint>();
  bool readStarted = false;

  void completeRead(ServiceLocationPoint point) {
    _read.complete(point);
  }

  Widget build(
    BuildContext context, {
    required ServiceLocationPoint initialPoint,
    required ServiceLocationCameraChanged onCameraChanged,
    required ServiceLocationManualCameraIntent onManualCameraMove,
    required ValueChanged<ServiceLocationMapCamera> onCameraReady,
  }) {
    onCameraReady(camera);
    return Center(
      child: FilledButton(
        key: const Key('simulate_camera_move'),
        onPressed: () async {
          final intentGeneration = onManualCameraMove();
          if (intentGeneration == null) return;
          readStarted = true;
          final point = await _read.future;
          onCameraChanged(point, intentGeneration);
        },
        child: const Text('تحريك تجريبي'),
      ),
    );
  }
}

ServiceLocationMapSurfaceBuilder _recordingMapSurfaceBuilder(
  List<ServiceLocationPoint> initialPoints,
) =>
    (
      BuildContext context, {
      required ServiceLocationPoint initialPoint,
      required ServiceLocationCameraChanged onCameraChanged,
      required ServiceLocationManualCameraIntent onManualCameraMove,
      required ValueChanged<ServiceLocationMapCamera> onCameraReady,
    }) {
      initialPoints.add(initialPoint);
      onCameraReady(_FakeMapCamera());
      return Center(
        child: FilledButton(
          key: const Key('simulate_camera_move'),
          onPressed: () {
            final intentGeneration = onManualCameraMove();
            if (intentGeneration == null) return;
            onCameraChanged(_draftPoint, intentGeneration);
          },
          child: const Text('تحريك تجريبي'),
        ),
      );
    };

Future<void> _pumpHarness(
  WidgetTester tester,
  GlobalKey<_PickerRouteHarnessState> key,
) async {
  await tester.pumpWidget(MaterialApp(home: _PickerRouteHarness(key: key)));
}

Future<void> _openAndMoveDraft(
  WidgetTester tester,
  GlobalKey<_PickerRouteHarnessState> key,
) async {
  await _pumpHarness(tester, key);
  await tester.tap(find.text('فتح محدد الموقع'));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const Key('simulate_camera_move')));
  await tester.pump();
}

void _expectPriorSelectionPreserved(GlobalKey<_PickerRouteHarnessState> key) {
  expect(key.currentState!.applyCount, 0);
  expect(key.currentState!.address, 'حي الصفراء، بريدة');
  expect(key.currentState!.controller.selection?.toJson(), {
    'point': {'latitude': 26.359123, 'longitude': 43.981988},
    'displayAddress': 'حي الصفراء، بريدة',
    'source': 'map_pin',
    'confirmed': true,
  });
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
    color: Colors.teal.shade50,
    child: Center(
      child: FilledButton(
        key: const Key('simulate_camera_move'),
        onPressed: () {
          final intentGeneration = onManualCameraMove();
          if (intentGeneration == null) return;
          onCameraChanged(_draftPoint, intentGeneration);
        },
        child: const Text('تحريك تجريبي'),
      ),
    ),
  );
}

class _PickerRouteHarness extends StatefulWidget {
  const _PickerRouteHarness({super.key});

  @override
  State<_PickerRouteHarness> createState() => _PickerRouteHarnessState();
}

class _PickerRouteHarnessState extends State<_PickerRouteHarness> {
  final controller = ServiceLocationController();
  String address = 'حي الصفراء، بريدة';
  int applyCount = 0;

  @override
  void initState() {
    super.initState();
    controller.applyConfirmedPoint(
      _previousPoint,
      ServiceLocationSource.mapPin,
    );
    controller.updateDisplayAddress(address);
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  Future<void> _open() async {
    final current = controller.selection;
    final result = await Navigator.of(context).push(
      MaterialPageRoute<ServiceLocationPickerResult>(
        builder: (_) => ServiceLocationPickerPage(
          initialPoint: current?.point,
          initialSource: current?.source,
          locationPlatform: _FakeLocationPlatform(
            permission: CustomerLocationPermission.denied,
          ),
          mapSurfaceBuilder: _testMapSurfaceBuilder,
        ),
      ),
    );
    if (!mounted || result == null) return;
    applyCount += 1;
    controller.applyConfirmedPoint(result.point, result.source);
    controller.updateDisplayAddress(address);
    setState(() {});
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Center(
      child: FilledButton(
        onPressed: _open,
        child: const Text('فتح محدد الموقع'),
      ),
    ),
  );
}

class _FakeMapCamera implements ServiceLocationMapCamera {
  @override
  Future<void> moveTo(ServiceLocationPoint point) async {}

  @override
  Future<ServiceLocationPoint> snapshotCurrentCenter() async => _draftPoint;
}

class _DelayedSnapshotMapCamera implements ServiceLocationMapCamera {
  final _snapshot = Completer<ServiceLocationPoint>();
  int snapshotCount = 0;
  int moveCount = 0;

  void completeSnapshot(ServiceLocationPoint point) {
    _snapshot.complete(point);
  }

  @override
  Future<ServiceLocationPoint> snapshotCurrentCenter() {
    snapshotCount += 1;
    return _snapshot.future;
  }

  @override
  Future<void> moveTo(ServiceLocationPoint point) async {
    moveCount += 1;
  }
}

abstract class _MutableMapCamera implements ServiceLocationMapCamera {
  ServiceLocationPoint get visiblePoint;

  set visiblePoint(ServiceLocationPoint point);
}

class _DelayedMoveMapCamera implements _MutableMapCamera {
  _DelayedMoveMapCamera(this.visiblePoint);

  final _move = Completer<void>();
  @override
  ServiceLocationPoint visiblePoint;
  ServiceLocationPoint? _pendingPoint;
  int moveCount = 0;
  int snapshotCount = 0;

  void completeMove() {
    visiblePoint = _pendingPoint!;
    _move.complete();
  }

  @override
  Future<void> moveTo(ServiceLocationPoint point) {
    moveCount += 1;
    _pendingPoint = point;
    return _move.future;
  }

  @override
  Future<ServiceLocationPoint> snapshotCurrentCenter() async {
    snapshotCount += 1;
    return visiblePoint;
  }
}

class _DelayedPermissionPlatform implements CustomerLocationPlatform {
  final _permission = Completer<CustomerLocationPermission>();
  bool permissionRequested = false;

  void completePermission(CustomerLocationPermission permission) {
    _permission.complete(permission);
  }

  @override
  Future<ServiceLocationPoint> getCurrentPosition() async => _previousPoint;

  @override
  Future<bool> openAppSettings() async => true;

  @override
  Future<CustomerLocationPermission> requestForegroundPermission() {
    permissionRequested = true;
    return _permission.future;
  }
}

class _DelayedLocationPlatform implements CustomerLocationPlatform {
  final _position = Completer<ServiceLocationPoint>();
  bool positionRequested = false;

  void completePosition(ServiceLocationPoint point) {
    _position.complete(point);
  }

  @override
  Future<ServiceLocationPoint> getCurrentPosition() {
    positionRequested = true;
    return _position.future;
  }

  @override
  Future<bool> openAppSettings() async => true;

  @override
  Future<CustomerLocationPermission> requestForegroundPermission() async =>
      CustomerLocationPermission.granted;
}

class _FailingMoveMapCamera implements ServiceLocationMapCamera {
  _FailingMoveMapCamera(this.visiblePoint);

  final ServiceLocationPoint visiblePoint;
  int moveCount = 0;

  @override
  Future<void> moveTo(ServiceLocationPoint point) async {
    moveCount += 1;
    throw StateError('camera move failed');
  }

  @override
  Future<ServiceLocationPoint> snapshotCurrentCenter() async => visiblePoint;
}

class _FailingSnapshotMapCamera implements ServiceLocationMapCamera {
  @override
  Future<void> moveTo(ServiceLocationPoint point) async {}

  @override
  Future<ServiceLocationPoint> snapshotCurrentCenter() =>
      Future<ServiceLocationPoint>.error(StateError('camera unavailable'));
}

class _NoopMoveMapCamera implements ServiceLocationMapCamera {
  _NoopMoveMapCamera(this.visiblePoint);

  final ServiceLocationPoint visiblePoint;

  @override
  Future<void> moveTo(ServiceLocationPoint point) async {}

  @override
  Future<ServiceLocationPoint> snapshotCurrentCenter() async => visiblePoint;
}

class _TrackingMapCamera implements _MutableMapCamera {
  _TrackingMapCamera(this.visiblePoint);

  @override
  ServiceLocationPoint visiblePoint;

  @override
  Future<void> moveTo(ServiceLocationPoint point) async {
    visiblePoint = point;
  }

  @override
  Future<ServiceLocationPoint> snapshotCurrentCenter() async => visiblePoint;
}

class _FakeLocationPlatform implements CustomerLocationPlatform {
  _FakeLocationPlatform({
    required this.permission,
    this.point = _previousPoint,
  });

  final CustomerLocationPermission permission;
  final ServiceLocationPoint point;

  @override
  Future<CustomerLocationPermission> requestForegroundPermission() async =>
      permission;

  @override
  Future<ServiceLocationPoint> getCurrentPosition() async => point;

  @override
  Future<bool> openAppSettings() async => true;
}
