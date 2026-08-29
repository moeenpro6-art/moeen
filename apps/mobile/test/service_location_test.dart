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

    test(
      'required mode blocks a request until a valid location is confirmed',
      () {
        expect(
          validateLocationForSubmission(
            mode: ServiceLocationMode.required,
            selection: null,
          ),
          isNotNull,
        );

        const unconfirmed = ServiceLocationInput(
          point: ServiceLocationPoint(
            latitude: 26.3591234,
            longitude: 43.9819876,
          ),
          displayAddress: 'حي الصفراء، بريدة',
          source: ServiceLocationSource.mapPin,
          confirmed: false,
        );
        expect(
          validateLocationForSubmission(
            mode: ServiceLocationMode.required,
            selection: unconfirmed,
          ),
          isNotNull,
        );
      },
    );
  });

  group('ServiceLocationController', () {
    test(
      'picker confirmation applies a confirmed point without an address',
      () {
        final controller = ServiceLocationController();

        expect(
          controller.applyConfirmedPoint(
            const ServiceLocationPoint(
              latitude: 26.3591234,
              longitude: 43.9819876,
            ),
            ServiceLocationSource.currentLocation,
          ),
          isTrue,
        );

        expect(controller.status, ServiceLocationPickerStatus.confirmed);
        expect(controller.selection?.point.latitude, 26.3591234);
        expect(controller.selection?.point.longitude, 43.9819876);
        expect(
          controller.selection?.source,
          ServiceLocationSource.currentLocation,
        );
        expect(controller.selection?.displayAddress, isEmpty);
        expect(controller.selection?.confirmed, isTrue);
        expect(controller.selection?.isValid, isFalse);
      },
    );

    test('editing a confirmed address preserves point confirmation', () {
      final controller = confirmedController();

      controller.updateDisplayAddress('حي الريان، بريدة، شارع الملك عبدالعزيز');

      expect(controller.status, ServiceLocationPickerStatus.confirmed);
      expect(controller.selection?.confirmed, isTrue);
      expect(
        controller.selection?.displayAddress,
        'حي الريان، بريدة، شارع الملك عبدالعزيز',
      );
    });

    test('blank or too-short address blocks a confirmed point submission', () {
      final controller = ServiceLocationController();
      controller.applyConfirmedPoint(
        const ServiceLocationPoint(latitude: 26.3591234, longitude: 43.9819876),
        ServiceLocationSource.mapPin,
      );

      expect(
        validateLocationForSubmission(
          mode: ServiceLocationMode.required,
          selection: controller.selection,
        ),
        isNotNull,
      );

      controller.updateDisplayAddress('حي');
      expect(controller.selection?.confirmed, isTrue);
      expect(
        validateLocationForSubmission(
          mode: ServiceLocationMode.required,
          selection: controller.selection,
        ),
        isNotNull,
      );
    });

    test('confirmed point builds the exact API ServiceLocationInput', () {
      final controller = ServiceLocationController();
      controller.applyConfirmedPoint(
        const ServiceLocationPoint(latitude: 26.3591234, longitude: 43.9819876),
        ServiceLocationSource.mapPin,
      );
      controller.updateDisplayAddress('حي الصفراء، بريدة');

      expect(controller.selection?.toJson(), {
        'point': {'latitude': 26.3591234, 'longitude': 43.9819876},
        'displayAddress': 'حي الصفراء، بريدة',
        'source': 'map_pin',
        'confirmed': true,
      });
    });
  });
}

ServiceLocationController confirmedController() {
  final controller = ServiceLocationController();
  controller.applyConfirmedPoint(
    const ServiceLocationPoint(latitude: 26.3591234, longitude: 43.9819876),
    ServiceLocationSource.mapPin,
  );
  controller.updateDisplayAddress('حي الصفراء، بريدة');
  return controller;
}

ServiceLocationInput confirmedSelection() {
  final controller = confirmedController();
  return controller.selection!;
}
