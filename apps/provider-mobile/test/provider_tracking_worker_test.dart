import 'dart:async';
import 'dart:convert';

import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:flutter_foreground_task/flutter_foreground_task_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart' as geolocator;
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:moeen_provider/provider_tracking.dart';

void main() {
  late FlutterForegroundTaskPlatform previousForegroundPlatform;
  late geolocator.GeolocatorPlatform previousGeolocatorPlatform;
  late _WorkerForegroundPlatform foreground;
  late _WorkerGeolocatorPlatform geolocatorPlatform;

  setUp(() {
    previousForegroundPlatform = FlutterForegroundTaskPlatform.instance;
    previousGeolocatorPlatform = geolocator.GeolocatorPlatform.instance;
    FlutterForegroundTask.resetStatic();
    foreground = _WorkerForegroundPlatform()..running = true;
    geolocatorPlatform = _WorkerGeolocatorPlatform();
    FlutterForegroundTaskPlatform.instance = foreground;
    geolocator.GeolocatorPlatform.instance = geolocatorPlatform;
    FlutterForegroundTask.skipServiceResponseCheck = true;
    initializeProviderTrackingForegroundTask();
  });

  tearDown(() async {
    await geolocatorPlatform.close();
    FlutterForegroundTask.resetStatic();
    FlutterForegroundTaskPlatform.instance = previousForegroundPlatform;
    geolocator.GeolocatorPlatform.instance = previousGeolocatorPlatform;
  });

  test(
    'worker rejects malformed configuration before it can start a GPS stream',
    () async {
      final worker = ProviderTrackingTaskHandler(
        client: MockClient((_) async => _json('{}')),
        authorityRetryDelays: const [Duration.zero],
        wait: (_) async {},
      );

      await worker.onStart(DateTime.utc(2026), TaskStarter.developer);
      worker.onRepeatEvent(DateTime.utc(2026));
      worker.onReceiveData('not a command');
      worker.onReceiveData({'command': 'configure', 'baseUrl': 'ftp://bad'});
      worker.onReceiveData({
        'command': 'configure',
        'baseUrl': 'https://api.example.test',
        'token': 'provider-session',
        'requestId': 'MOE-1001',
        'status': 'assigned',
        'onTheWayCadenceMs': 15000,
        'inProgressCadenceMs': 60000,
      });
      await _settle();

      expect(foreground.updateCalls, 0);
      expect(geolocatorPlatform.positionStreamCalls, 0);
    },
  );

  test(
    'repeated stable authority keeps one foreground service and one GPS stream',
    () async {
      final worker = ProviderTrackingTaskHandler(
        client: MockClient((_) async => _json('{}', status: 201)),
      );

      worker.onReceiveData(_configuration());
      await _settle();
      worker.onReceiveData(_configuration());
      worker.onReceiveData(_configuration());
      await _settle();

      expect(foreground.running, isTrue);
      expect(foreground.updateCalls, 1);
      expect(foreground.stopCalls, 0);
      expect(geolocatorPlatform.positionStreamCalls, 1);
    },
  );

  test(
    'worker streams only valid server-authorized samples and removes successful submissions',
    () async {
      final requests = <http.Request>[];
      final worker = ProviderTrackingTaskHandler(
        client: MockClient((request) async {
          requests.add(request);
          return _json('{}', status: 201);
        }),
        authorityRetryDelays: const [Duration.zero],
        wait: (_) async {},
      );

      worker.onReceiveData(_configuration());
      await _settle();
      geolocatorPlatform.positions.add(_position());
      await _settle();

      expect(foreground.updateCalls, 1);
      expect(geolocatorPlatform.positionStreamCalls, 1);
      expect(requests, hasLength(1));
      expect(
        requests.single.url.path,
        '/provider/service-requests/MOE-1001/location',
      );
      expect(
        requests.single.headers['authorization'],
        'Bearer provider-session',
      );
      final body = jsonDecode(requests.single.body) as Map<String, dynamic>;
      expect(body['latitude'], 26.31);
      expect(body['longitude'], 43.98);
      expect(body['accuracyMeters'], 9.5);
      expect(body['capturedAt'], isA<String>());
    },
  );

  test(
    'worker fails closed and emits no coordinate data when location permission disappears',
    () async {
      final events = <Object>[];
      FlutterForegroundTask.addTaskDataCallback(events.add);
      final worker = ProviderTrackingTaskHandler(
        client: MockClient((_) async => _json('{}')),
        authorityRetryDelays: const [Duration.zero],
        wait: (_) async {},
      );
      worker.onReceiveData(_configuration());
      await _settle();
      geolocatorPlatform.serviceEnabled = false;
      geolocatorPlatform.positions.add(_position());
      await _settle();

      expect(foreground.stopCalls, 1);
      expect(events, [
        {'event': 'location_unavailable', 'requestId': 'MOE-1001'},
      ]);
    },
  );

  test(
    'worker handles unauthorized posts by clearing configuration and notifying only the safe event',
    () async {
      final events = <Object>[];
      FlutterForegroundTask.addTaskDataCallback(events.add);
      final worker = ProviderTrackingTaskHandler(
        client: MockClient(
          (_) async => _json('{"message":"Unauthorized"}', status: 401),
        ),
        authorityRetryDelays: const [Duration.zero],
        wait: (_) async {},
      );
      worker.onReceiveData(_configuration());
      await _settle();
      geolocatorPlatform.positions.add(_position());
      await _settle();

      expect(foreground.stopCalls, 1);
      expect(events.last, {'event': 'unauthorized', 'requestId': 'MOE-1001'});
      expect(
        events.first,
        isA<Map<String, String>>()
            .having((event) => event['event'], 'event', 'sample_collected')
            .having(
              (event) => event.containsKey('latitude'),
              'latitude',
              isFalse,
            )
            .having(
              (event) => event.containsKey('longitude'),
              'longitude',
              isFalse,
            ),
      );
    },
  );

  test(
    'worker pauses after a server failure then restores only fresh active authority',
    () async {
      final events = <Object>[];
      final methods = <String>[];
      FlutterForegroundTask.addTaskDataCallback(events.add);
      final worker = ProviderTrackingTaskHandler(
        client: MockClient((request) async {
          methods.add(request.method);
          if (request.method == 'POST') return _json('{}', status: 503);
          return _json(
            '{"tracking":{"active":true,"requestId":"MOE-1001",'
            '"status":"in_progress","onTheWayCadenceMs":15000,'
            '"inProgressCadenceMs":60000}}',
          );
        }),
        authorityRetryDelays: const [Duration.zero],
        wait: (_) async {},
      );
      worker.onReceiveData(_configuration());
      await _settle();
      geolocatorPlatform.positions.add(_position());
      await _settle();

      expect(methods, ['POST', 'GET']);
      expect(foreground.stopCalls, 0);
      expect(foreground.updateCalls, 2);
      expect(geolocatorPlatform.positionStreamCalls, 2);
      expect(events.last, {
        'event': 'authority_restored',
        'requestId': 'MOE-1001',
      });
      expect(
        events.first,
        isA<Map<String, String>>()
            .having((event) => event['event'], 'event', 'sample_collected')
            .having(
              (event) => event.containsKey('latitude'),
              'latitude',
              isFalse,
            )
            .having(
              (event) => event.containsKey('longitude'),
              'longitude',
              isFalse,
            ),
      );
    },
  );

  test(
    'authority recovery does not reset the cadence gate or post a catch-up sample',
    () async {
      var posts = 0;
      final worker = ProviderTrackingTaskHandler(
        client: MockClient((request) async {
          if (request.method == 'POST') {
            posts += 1;
            return _json('{}', status: 503);
          }
          return _json(
            '{"tracking":{"active":true,"requestId":"MOE-1001",'
            '"status":"on_the_way","onTheWayCadenceMs":15000,'
            '"inProgressCadenceMs":60000}}',
          );
        }),
        authorityRetryDelays: const [Duration.zero],
        wait: (_) async {},
      );

      worker.onReceiveData(_configuration());
      await _settle();
      geolocatorPlatform.positions.add(_position());
      await _settle();
      expect(posts, 1);

      // The new stream emits immediately after recovery, well before 15 seconds.
      // A reset gate would POST again here and create the observed burst.
      geolocatorPlatform.positions.add(_position());
      await _settle();

      expect(posts, 1);
    },
  );

  test(
    'a newly created worker seeds its in-memory cadence gate before it can post',
    () async {
      var posts = 0;
      final worker = ProviderTrackingTaskHandler(
        client: MockClient((request) async {
          if (request.method == 'POST') posts += 1;
          return _json('{}', status: 201);
        }),
      );
      final lastCollectedAt = DateTime.now().toUtc();

      worker.onReceiveData({
        ..._configuration(),
        'lastCollectedAt': lastCollectedAt.toIso8601String(),
      });
      await _settle();
      geolocatorPlatform.positions.add(_position());
      await _settle();

      expect(posts, 0);
    },
  );
}

Map<String, Object> _configuration() => {
  'command': 'configure',
  'baseUrl': 'https://api.example.test/',
  'token': 'provider-session',
  'requestId': 'MOE-1001',
  'status': 'on_the_way',
  'onTheWayCadenceMs': 15000,
  'inProgressCadenceMs': 60000,
};

geolocator.Position _position() => geolocator.Position(
  latitude: 26.31,
  longitude: 43.98,
  timestamp: DateTime.utc(2026, 8, 22),
  accuracy: 9.5,
  altitude: 0,
  altitudeAccuracy: 0,
  heading: 0,
  headingAccuracy: 0,
  speed: 0,
  speedAccuracy: 0,
);

http.Response _json(String body, {int status = 200}) => http.Response(
  body,
  status,
  headers: const {'content-type': 'application/json; charset=utf-8'},
);

Future<void> _settle() async {
  for (var index = 0; index < 4; index += 1) {
    await Future<void>.delayed(Duration.zero);
  }
}

class _WorkerForegroundPlatform extends FlutterForegroundTaskPlatform {
  bool running = false;
  int updateCalls = 0;
  int stopCalls = 0;

  @override
  Future<bool> get isRunningService async => running;

  @override
  Future<void> updateService({
    ForegroundTaskOptions? foregroundTaskOptions,
    String? notificationTitle,
    String? notificationText,
    NotificationIcon? notificationIcon,
    List<NotificationButton>? notificationButtons,
    String? notificationInitialRoute,
    Function? callback,
  }) async => updateCalls += 1;

  @override
  Future<void> stopService() async {
    stopCalls += 1;
    running = false;
  }
}

class _WorkerGeolocatorPlatform extends geolocator.GeolocatorPlatform {
  final positions = StreamController<geolocator.Position>.broadcast();
  bool serviceEnabled = true;
  int positionStreamCalls = 0;

  @override
  Future<geolocator.LocationPermission> checkPermission() async =>
      geolocator.LocationPermission.whileInUse;

  @override
  Future<bool> isLocationServiceEnabled() async => serviceEnabled;

  @override
  Stream<geolocator.Position> getPositionStream({
    geolocator.LocationSettings? locationSettings,
  }) {
    positionStreamCalls += 1;
    return positions.stream;
  }

  Future<void> close() => positions.close();
}
