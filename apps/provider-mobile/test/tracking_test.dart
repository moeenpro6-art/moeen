import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart' as geolocator;
import 'package:moeen_provider/tracking/permission_service.dart';
import 'package:moeen_provider/tracking/tracking_models.dart';
import 'package:moeen_provider/tracking/tracking_service.dart';

void main() {
  group('ProviderTrackingStatusResponseDto', () {
    test('parses the exact server authority shape', () {
      final response = ProviderTrackingStatusResponseDto.fromJson({
        'tracking': {
          'active': true,
          'requestId': 'MOE-1042',
          'status': 'on_the_way',
          'onTheWayCadenceMs': 15000,
          'inProgressCadenceMs': 60000,
        },
      });

      expect(response.tracking.active, isTrue);
      expect(response.tracking.requestId, 'MOE-1042');
      expect(response.tracking.status, 'on_the_way');
      expect(response.tracking.onTheWayCadenceMs, 15000);
      expect(response.tracking.inProgressCadenceMs, 60000);
    });

    test(
      'rejects malformed tracking authority rather than inferring access',
      () {
        expect(
          () => ProviderTrackingStatusResponseDto.fromJson({
            'tracking': {
              'active': true,
              'requestId': 'MOE-1042',
              'status': 'on_the_way',
              'onTheWayCadenceMs': 0,
              'inProgressCadenceMs': 60000,
            },
          }),
          throwsFormatException,
        );
      },
    );
  });

  group('TrackingService', () {
    test(
      'does not collect or start anything without current server authority',
      () async {
        final foregroundService = _FakeForegroundService();
        final messages = <String>[];
        final service = TrackingService(
          loadStatus: (requestId) async =>
              _status(requestId: requestId, active: false, status: 'assigned'),
          foregroundService: foregroundService,
          log: messages.add,
        );

        await expectLater(
          service.startTracking('MOE-1042'),
          completion(isFalse),
        );

        expect(service.isTrackingActive(), isFalse);
        expect(service.lastServerState?.active, isFalse);
        expect(foregroundService.stopCalls, 0);
        expect(messages, isEmpty);
      },
    );

    test('records active authority only and logs no coordinate data', () async {
      final foregroundService = _FakeForegroundService();
      final messages = <String>[];
      final service = TrackingService(
        loadStatus: (requestId) async =>
            _status(requestId: requestId, active: true, status: 'on_the_way'),
        foregroundService: foregroundService,
        log: messages.add,
      );

      await expectLater(service.startTracking('MOE-1042'), completion(isTrue));

      expect(service.isTrackingActive(), isTrue);
      expect(foregroundService.stopCalls, 0);
      expect(messages, [
        'Provider tracking authority confirmed for request MOE-1042.',
      ]);
    });

    test('fails closed after an authority load error', () async {
      final service = TrackingService(
        loadStatus: (_) async => throw StateError('offline'),
        foregroundService: _FakeForegroundService(),
        log: (_) {},
      );

      await expectLater(service.startTracking('MOE-1042'), throwsStateError);
      expect(service.isTrackingActive(), isFalse);
      expect(service.lastServerState, isNull);
    });

    test(
      'stopping clears local authority and stops the service adapter',
      () async {
        final foregroundService = _FakeForegroundService();
        final service = TrackingService(
          loadStatus: (requestId) async => _status(
            requestId: requestId,
            active: true,
            status: 'in_progress',
          ),
          foregroundService: foregroundService,
          log: (_) {},
        );

        await service.startTracking('MOE-1042');
        await service.stopTracking();

        expect(service.isTrackingActive(), isFalse);
        expect(service.lastServerState, isNull);
        expect(foregroundService.stopCalls, 1);
      },
    );
  });

  group('PermissionService', () {
    test(
      'checks permission and GPS availability without requesting permission',
      () async {
        final platform = _FakePermissionPlatform(
          permission: geolocator.LocationPermission.deniedForever,
          locationServiceEnabled: false,
        );
        final service = PermissionService(platform: platform);

        await expectLater(
          service.checkLocationPermission(),
          completion(LocationPermissionStatus.permanentlyDenied),
        );
        await expectLater(
          service.isLocationServiceEnabled(),
          completion(isFalse),
        );

        expect(platform.checkCalls, 1);
        expect(platform.requestCalls, 0);
      },
    );

    test('requests permission only when explicitly invoked', () async {
      final platform = _FakePermissionPlatform(
        permission: geolocator.LocationPermission.denied,
        requestedPermission: geolocator.LocationPermission.whileInUse,
        locationServiceEnabled: true,
      );
      final service = PermissionService(platform: platform);

      await expectLater(
        service.requestPermission(),
        completion(LocationPermissionStatus.granted),
      );

      expect(platform.checkCalls, 0);
      expect(platform.requestCalls, 1);
    });
  });
}

ProviderTrackingStatusResponseDto _status({
  required String requestId,
  required bool active,
  required String status,
}) => ProviderTrackingStatusResponseDto(
  tracking: TrackingState(
    requestId: requestId,
    status: status,
    onTheWayCadenceMs: 15000,
    inProgressCadenceMs: 60000,
    active: active,
  ),
);

class _FakeForegroundService implements TrackingForegroundServiceController {
  int stopCalls = 0;

  @override
  Future<void> stop() async {
    stopCalls += 1;
  }
}

class _FakePermissionPlatform implements LocationPermissionPlatform {
  _FakePermissionPlatform({
    required this.permission,
    required this.locationServiceEnabled,
    geolocator.LocationPermission? requestedPermission,
  }) : requestedPermission = requestedPermission ?? permission;

  final geolocator.LocationPermission permission;
  final geolocator.LocationPermission requestedPermission;
  final bool locationServiceEnabled;
  int checkCalls = 0;
  int requestCalls = 0;

  @override
  Future<geolocator.LocationPermission> checkPermission() async {
    checkCalls += 1;
    return permission;
  }

  @override
  Future<bool> isLocationServiceEnabled() async => locationServiceEnabled;

  @override
  Future<geolocator.LocationPermission> requestPermission() async {
    requestCalls += 1;
    return requestedPermission;
  }
}
