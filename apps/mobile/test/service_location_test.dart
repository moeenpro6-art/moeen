import 'package:flutter_test/flutter_test.dart';
import 'package:moeen_mobile/service_location.dart';

void main() {
  group('service location feature mode', () {
    test('off mode preserves the legacy request flow', () {
      expect(serviceLocationModeFromRaw('off'), ServiceLocationMode.off);
      expect(
        locationForSubmission(
          mode: ServiceLocationMode.off,
          selection: confirmedSelection(),
        ),
        isNull,
      );
    });

    test('optional mode permits a request without a selected location', () {
      expect(
        validateLocationForSubmission(
          mode: ServiceLocationMode.optional,
          selection: null,
        ),
        isNull,
      );
      expect(
        locationForSubmission(
          mode: ServiceLocationMode.optional,
          selection: null,
        ),
        isNull,
      );
    });

    test('required mode blocks a request until a valid location is confirmed', () {
      expect(
        validateLocationForSubmission(
          mode: ServiceLocationMode.required,
          selection: null,
        ),
        isNotNull,
      );

      final unconfirmed = ServiceLocationController();
      unconfirmed.selectMapPin(
        const ServiceLocationPoint(latitude: 26.3591234, longitude: 43.9819876),
      );
      unconfirmed.updateDisplayAddress('حي الصفراء، بريدة');
      expect(
        validateLocationForSubmission(
          mode: ServiceLocationMode.required,
          selection: unconfirmed.selection,
        ),
        isNotNull,
      );
    });
  });

  group('ServiceLocationController', () {
    test('a current location result seeds an unconfirmed current-location pin', () async {
      final controller = ServiceLocationController(
        platform: _FakeLocationPlatform(
          permission: CustomerLocationPermission.granted,
          position: const ServiceLocationPoint(
            latitude: 26.3591234,
            longitude: 43.9819876,
          ),
        ),
      );

      await controller.useCurrentLocation();

      expect(controller.status, ServiceLocationPickerStatus.selected);
      expect(controller.selection?.point.latitude, 26.3591234);
      expect(controller.selection?.point.longitude, 43.9819876);
      expect(controller.selection?.source, ServiceLocationSource.currentLocation);
      expect(controller.selection?.confirmed, isFalse);
    });

    test('moving the pin changes the source to map_pin', () {
      final controller = ServiceLocationController();
      controller.seedCurrentLocation(
        const ServiceLocationPoint(latitude: 26.3591234, longitude: 43.9819876),
      );

      controller.selectMapPin(
        const ServiceLocationPoint(latitude: 26.360001, longitude: 43.980001),
      );

      expect(controller.selection?.source, ServiceLocationSource.mapPin);
      expect(controller.selection?.confirmed, isFalse);
    });

    test('moving a confirmed pin invalidates confirmation', () {
      final controller = confirmedController();

      controller.selectMapPin(
        const ServiceLocationPoint(latitude: 26.360001, longitude: 43.980001),
      );

      expect(controller.status, ServiceLocationPickerStatus.selected);
      expect(controller.selection?.confirmed, isFalse);
    });

    test('editing a confirmed address invalidates confirmation', () {
      final controller = confirmedController();

      controller.updateDisplayAddress('حي الريان، بريدة');

      expect(controller.status, ServiceLocationPickerStatus.selected);
      expect(controller.selection?.confirmed, isFalse);
    });

    test('explicit confirmation builds the exact API ServiceLocationInput', () {
      final controller = ServiceLocationController();
      controller.selectMapPin(
        const ServiceLocationPoint(latitude: 26.3591234, longitude: 43.9819876),
      );
      controller.updateDisplayAddress('حي الصفراء، بريدة');

      expect(controller.confirm(), isTrue);
      expect(controller.status, ServiceLocationPickerStatus.confirmed);
      expect(controller.selection?.toJson(), {
        'point': {'latitude': 26.3591234, 'longitude': 43.9819876},
        'displayAddress': 'حي الصفراء، بريدة',
        'source': 'map_pin',
        'confirmed': true,
      });
    });

    test('denied permission leaves manual pin selection recoverable', () async {
      final controller = ServiceLocationController(
        platform: _FakeLocationPlatform(
          permission: CustomerLocationPermission.denied,
        ),
      );

      await controller.useCurrentLocation();

      expect(controller.status, ServiceLocationPickerStatus.permissionDenied);
      controller.selectMapPin(
        const ServiceLocationPoint(latitude: 26.3591234, longitude: 43.9819876),
      );
      expect(controller.status, ServiceLocationPickerStatus.selected);
    });

    test('GPS failure retains the manual pin path', () async {
      final controller = ServiceLocationController(
        platform: _FakeLocationPlatform(
          permission: CustomerLocationPermission.granted,
          failure: StateError('GPS unavailable'),
        ),
      );

      await controller.useCurrentLocation();

      expect(controller.status, ServiceLocationPickerStatus.gpsUnavailable);
      controller.selectMapPin(
        const ServiceLocationPoint(latitude: 26.3591234, longitude: 43.9819876),
      );
      expect(controller.status, ServiceLocationPickerStatus.selected);
    });
  });
}

ServiceLocationController confirmedController() {
  final controller = ServiceLocationController();
  controller.selectMapPin(
    const ServiceLocationPoint(latitude: 26.3591234, longitude: 43.9819876),
  );
  controller.updateDisplayAddress('حي الصفراء، بريدة');
  expect(controller.confirm(), isTrue);
  return controller;
}

ServiceLocationInput confirmedSelection() {
  final controller = confirmedController();
  return controller.selection!;
}

class _FakeLocationPlatform implements CustomerLocationPlatform {
  _FakeLocationPlatform({required this.permission, this.position, this.failure});

  final CustomerLocationPermission permission;
  final ServiceLocationPoint? position;
  final Object? failure;

  @override
  Future<CustomerLocationPermission> requestForegroundPermission() async =>
      permission;

  @override
  Future<ServiceLocationPoint> getCurrentPosition() async {
    if (failure != null) throw failure!;
    return position!;
  }

  @override
  Future<bool> openAppSettings() async => true;
}
