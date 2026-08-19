import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:moeen_provider/provider_notifications.dart';

class FakeDeviceIdStore implements ProviderDeviceIdStore {
  String? deviceId;

  @override
  Future<String?> read() async => deviceId;

  @override
  Future<void> write(String deviceId) async {
    this.deviceId = deviceId;
  }

  @override
  Future<void> clear() async {
    deviceId = null;
  }
}

class FakeDeviceApi implements ProviderDeviceApi {
  final registrations = <({String token, String session})>[];
  final revoked = <String>[];
  final callOrder = <String>[];
  ProviderDeviceApiException? registerError;
  ProviderDeviceApiException? revokeError;
  int _nextDeviceId = 1;

  @override
  Future<RegisteredProviderDevice> register({
    required String fcmToken,
    required String sessionToken,
  }) async {
    registrations.add((token: fcmToken, session: sessionToken));
    callOrder.add('register:$fcmToken');
    if (registerError != null) throw registerError!;
    return RegisteredProviderDevice(deviceId: 'DEV-${_nextDeviceId++}');
  }

  @override
  Future<void> revoke({
    required String deviceId,
    required String sessionToken,
  }) async {
    callOrder.add('revoke:$deviceId');
    if (revokeError != null) throw revokeError!;
    revoked.add(deviceId);
  }
}

class ControllableDeviceApi implements ProviderDeviceApi {
  final pending = <ControlledRegistration>[];
  final revoked = <String>[];
  int _nextDeviceId = 1;

  @override
  Future<RegisteredProviderDevice> register({
    required String fcmToken,
    required String sessionToken,
  }) {
    final registration = ControlledRegistration(
      fcmToken: fcmToken,
      sessionToken: sessionToken,
      deviceId: 'DEV-${_nextDeviceId++}',
    );
    pending.add(registration);
    return registration.completer.future;
  }

  @override
  Future<void> revoke({
    required String deviceId,
    required String sessionToken,
  }) async {
    revoked.add(deviceId);
  }
}

class ControlledRegistration {
  ControlledRegistration({
    required this.fcmToken,
    required this.sessionToken,
    required this.deviceId,
  });

  final String fcmToken;
  final String sessionToken;
  final String deviceId;
  final Completer<RegisteredProviderDevice> completer = Completer();

  void complete() =>
      completer.complete(RegisteredProviderDevice(deviceId: deviceId));
}

class FakeMessagingClient implements ProviderMessagingClient {
  FakeMessagingClient({
    this.initializeResult = true,
    this.currentPermissionValue = ProviderNotificationPermission.notDetermined,
    this.requestedPermission = ProviderNotificationPermission.authorized,
    this.token = 'provider-fcm-token',
  });

  bool initializeResult;
  ProviderNotificationPermission currentPermissionValue;
  ProviderNotificationPermission requestedPermission;
  String? token;
  int initializeCalls = 0;
  int requestPermissionCalls = 0;
  int getTokenCalls = 0;

  final tokenRefreshController = StreamController<String>.broadcast();
  final messageController =
      StreamController<ProviderNotificationIntent?>.broadcast();
  final openedController =
      StreamController<ProviderNotificationIntent?>.broadcast();
  ProviderNotificationIntent? initialMessage;

  @override
  Future<bool> initialize() async {
    initializeCalls++;
    return initializeResult;
  }

  @override
  Future<ProviderNotificationPermission> currentPermission() async =>
      currentPermissionValue;

  @override
  Future<ProviderNotificationPermission> requestPermission() async {
    requestPermissionCalls++;
    return requestedPermission;
  }

  @override
  Future<String?> getToken() async {
    getTokenCalls++;
    return token;
  }

  @override
  Stream<String> get onTokenRefresh => tokenRefreshController.stream;

  @override
  Stream<ProviderNotificationIntent?> get onMessage => messageController.stream;

  @override
  Stream<ProviderNotificationIntent?> get onMessageOpenedApp =>
      openedController.stream;

  @override
  Future<ProviderNotificationIntent?> getInitialMessage() async =>
      initialMessage;
}

class RecordingClient extends http.BaseClient {
  RecordingClient({
    this.statusCode = 201,
    this.responseBody = '{"deviceId":"DEV-1"}',
  });

  final int statusCode;
  final String responseBody;
  String? method;
  Uri? url;
  Map<String, String>? headers;
  String? body;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    method = request.method;
    url = request.url;
    headers = request.headers;
    body = await request.finalize().bytesToString();
    return http.StreamedResponse(
      Stream<List<int>>.fromIterable([utf8.encode(responseBody)]),
      statusCode,
      headers: const {'content-type': 'application/json'},
    );
  }
}

Future<void> pumpUntil(bool Function() condition) async {
  for (var i = 0; i < 200 && !condition(); i++) {
    await Future<void>.delayed(Duration.zero);
  }
  expect(condition(), isTrue, reason: 'condition not reached after pumping');
}

const validOpportunityIntent = ProviderNotificationIntent(
  type: ProviderNotificationType.opportunityInvited,
  requestId: 'MOE-1001',
  navigate: ProviderNotificationNavigate.opportunity,
  eventId: 'evt-1',
  version: 1,
);

ProviderNotificationController controller({
  required FakeMessagingClient messaging,
  ProviderDeviceApi? deviceApi,
  FakeDeviceIdStore? deviceStore,
  Future<String?> Function()? sessionTokenProvider,
  void Function(ProviderNotificationIntent)? onForegroundMessage,
  Future<void> Function(ProviderNotificationIntent)? onOpenedIntent,
}) => ProviderNotificationController(
  enabled: true,
  messaging: messaging,
  deviceApi: deviceApi ?? FakeDeviceApi(),
  deviceStore: deviceStore ?? FakeDeviceIdStore(),
  sessionTokenProvider: sessionTokenProvider ?? () async => 'provider-session',
  onForegroundMessage: onForegroundMessage,
  onOpenedIntent: onOpenedIntent,
);

void main() {
  group('provider payload parsing', () {
    test('parses an exact provider opportunity payload', () {
      final intent = parseProviderNotificationIntent({
        'type': 'opportunity_invited',
        'requestId': 'MOE-1001',
        'navigate': 'provider_opportunity',
        'eventId': 'evt-1',
        'v': '1',
      });

      expect(intent, isNotNull);
      expect(intent!.type, ProviderNotificationType.opportunityInvited);
      expect(intent.navigate, ProviderNotificationNavigate.opportunity);
      expect(intent.requestId, 'MOE-1001');
    });

    test('parses the other exact provider events', () {
      final assigned = parseProviderNotificationIntent({
        'type': 'provider_assigned',
        'requestId': 'MOE-1002',
        'navigate': 'provider_job',
        'eventId': 'evt-2',
        'v': '1',
      });
      final closed = parseProviderNotificationIntent({
        'type': 'opportunity_closed',
        'requestId': 'MOE-1003',
        'navigate': 'provider_dashboard',
        'eventId': 'evt-3',
        'v': '1',
      });

      expect(assigned?.navigate, ProviderNotificationNavigate.job);
      expect(closed?.navigate, ProviderNotificationNavigate.dashboard);
    });

    test('rejects customer-only and unknown notification types', () {
      expect(
        parseProviderNotificationIntent({
          'type': 'quote_received',
          'requestId': 'MOE-1001',
          'navigate': 'customer_request_detail',
          'eventId': 'evt-1',
          'v': '1',
        }),
        isNull,
      );
      expect(
        parseProviderNotificationIntent({
          'type': 'own_quote_rejected',
          'requestId': 'MOE-1001',
          'navigate': 'provider_opportunity',
          'eventId': 'evt-1',
          'v': '1',
        }),
        isNull,
      );
    });

    test('rejects unknown or type-mismatched navigation', () {
      expect(
        parseProviderNotificationIntent({
          'type': 'opportunity_invited',
          'requestId': 'MOE-1001',
          'navigate': 'provider_job',
          'eventId': 'evt-1',
          'v': '1',
        }),
        isNull,
      );
      expect(
        parseProviderNotificationIntent({
          'type': 'provider_assigned',
          'requestId': 'MOE-1001',
          'navigate': 'untrusted_route',
          'eventId': 'evt-1',
          'v': '1',
        }),
        isNull,
      );
    });

    test('rejects malformed public ids, event ids, and versions', () {
      for (final data in [
        {
          'type': 'opportunity_invited',
          'requestId': 'private-id',
          'navigate': 'provider_opportunity',
          'eventId': 'evt-1',
          'v': '1',
        },
        {
          'type': 'opportunity_invited',
          'requestId': 'MOE-1001',
          'navigate': 'provider_opportunity',
          'eventId': '',
          'v': '1',
        },
        {
          'type': 'opportunity_invited',
          'requestId': 'MOE-1001',
          'navigate': 'provider_opportunity',
          'eventId': 'evt-1',
          'v': '2',
        },
      ]) {
        expect(parseProviderNotificationIntent(data), isNull);
      }
    });

    test('never retains smuggled private fields', () {
      final intent = parseProviderNotificationIntent({
        'type': 'opportunity_invited',
        'requestId': 'MOE-1001',
        'navigate': 'provider_opportunity',
        'eventId': 'evt-1',
        'v': '1',
        'customerPhone': '+966500000000',
        'customerName': 'أحمد',
        'address': 'الرياض',
        'images': 'https://example.test/image',
        'token': 'secret',
      });

      expect(intent, isNotNull);
      expect(intent.toString(), isNot(contains('أحمد')));
      expect(intent.toString(), isNot(contains('secret')));
      expect(providerNotificationSummary(intent!), contains('MOE-1001'));
      expect(providerNotificationSummary(intent), isNot(contains('evt-1')));
    });
  });

  group('provider device HTTP contract', () {
    test('registers only token and platform; never a providerId', () async {
      final client = RecordingClient();
      final api = HttpProviderDeviceApi(
        client: client,
        endpoint: (path) => Uri.parse('https://api.example.test$path'),
      );

      final device = await api.register(
        fcmToken: 'fcm-token',
        sessionToken: 'provider-session',
      );

      expect(device.deviceId, 'DEV-1');
      expect(client.method, 'POST');
      expect(client.url!.path, '/provider/devices');
      expect(client.headers!['authorization'], 'Bearer provider-session');
      expect(jsonDecode(client.body!), {
        'token': 'fcm-token',
        'platform': 'android',
      });
      expect(jsonDecode(client.body!).containsKey('providerId'), isFalse);
    });
  });

  group('config and registration lifecycle', () {
    test(
      'disabled controller never touches Firebase or provider devices',
      () async {
        final messaging = FakeMessagingClient();
        final api = FakeDeviceApi();
        final disabled = ProviderNotificationController(
          enabled: false,
          messaging: messaging,
          deviceApi: api,
          deviceStore: FakeDeviceIdStore(),
          sessionTokenProvider: () async => 'provider-session',
        );

        await disabled.initialize();
        await disabled.onAuthenticated();
        await disabled.onLogout(sessionToken: 'provider-session');
        await disabled.handleInitialMessage();

        expect(messaging.initializeCalls, 0);
        expect(messaging.requestPermissionCalls, 0);
        expect(messaging.getTokenCalls, 0);
        expect(api.registrations, isEmpty);
        expect(api.revoked, isEmpty);
      },
    );

    test(
      'authenticated provider registers token and safely stores device id',
      () async {
        final messaging = FakeMessagingClient();
        final api = FakeDeviceApi();
        final store = FakeDeviceIdStore();

        await controller(
          messaging: messaging,
          deviceApi: api,
          deviceStore: store,
        ).onAuthenticated();

        expect(api.registrations.single.token, 'provider-fcm-token');
        expect(api.registrations.single.session, 'provider-session');
        expect(store.deviceId, 'DEV-1');
      },
    );

    test(
      'registration failure is optional and does not fail login lifecycle',
      () async {
        final api = FakeDeviceApi()
          ..registerError = const ProviderDeviceApiException(500);
        final store = FakeDeviceIdStore();

        await controller(
          messaging: FakeMessagingClient(),
          deviceApi: api,
          deviceStore: store,
        ).onAuthenticated();

        expect(api.registrations, hasLength(1));
        expect(store.deviceId, isNull);
      },
    );

    test('token refresh registers the fresh token', () async {
      final messaging = FakeMessagingClient();
      final api = FakeDeviceApi();
      final sut = controller(messaging: messaging, deviceApi: api);

      await sut.onAuthenticated();
      messaging.tokenRefreshController.add('refreshed-provider-token');
      await pumpUntil(() => api.registrations.length == 2);

      expect(api.registrations.last.token, 'refreshed-provider-token');
    });

    test(
      'same-generation same-token concurrent registrations deduplicate',
      () async {
        final messaging = FakeMessagingClient()..token = 'shared-token';
        final api = ControllableDeviceApi();
        final sut = controller(messaging: messaging, deviceApi: api);

        await sut.initialize();
        final login = sut.onAuthenticated();
        await pumpUntil(() => api.pending.length == 1);
        for (var i = 0; i < 5; i++) {
          messaging.tokenRefreshController.add('shared-token');
        }
        await Future<void>.delayed(Duration.zero);

        expect(api.pending, hasLength(1));
        api.pending.single.complete();
        await login;
      },
    );

    test(
      'logout revokes before clear and local device id is always cleared',
      () async {
        final api = FakeDeviceApi();
        final store = FakeDeviceIdStore();
        final sut = controller(
          messaging: FakeMessagingClient(),
          deviceApi: api,
          deviceStore: store,
        );
        await sut.onAuthenticated();

        await sut.onLogout(sessionToken: 'provider-session');

        expect(api.revoked, ['DEV-1']);
        expect(store.deviceId, isNull);
        expect(
          api.callOrder,
          containsAllInOrder(['register:provider-fcm-token', 'revoke:DEV-1']),
        );
      },
    );

    test(
      'failed revoke does not block logout and still clears local id',
      () async {
        final api = FakeDeviceApi()
          ..revokeError = const ProviderDeviceApiException(500);
        final store = FakeDeviceIdStore()..deviceId = 'DEV-9';

        await controller(
          messaging: FakeMessagingClient(),
          deviceApi: api,
          deviceStore: store,
        ).onLogout(sessionToken: 'provider-session');

        expect(store.deviceId, isNull);
      },
    );

    test('null FCM token remains non-blocking', () async {
      final api = FakeDeviceApi();
      await controller(
        messaging: FakeMessagingClient()..token = null,
        deviceApi: api,
      ).onAuthenticated();
      expect(api.registrations, isEmpty);
    });
  });

  group('account-switch race protections', () {
    test(
      'A logout then B login starts B registration and ignores late A',
      () async {
        final messaging = FakeMessagingClient()..token = 'shared-token';
        final api = ControllableDeviceApi();
        final store = FakeDeviceIdStore();
        var session = 'provider-A';
        final sut = controller(
          messaging: messaging,
          deviceApi: api,
          deviceStore: store,
          sessionTokenProvider: () async => session,
        );

        final aLogin = sut.onAuthenticated();
        await pumpUntil(() => api.pending.length == 1);
        expect(api.pending.single.sessionToken, 'provider-A');

        await sut.onLogout(sessionToken: 'provider-A');
        session = 'provider-B';
        final bLogin = sut.onAuthenticated();
        await pumpUntil(() => api.pending.length == 2);
        final bRegistration = api.pending.last;
        expect(bRegistration.sessionToken, 'provider-B');

        bRegistration.complete();
        await bLogin;
        expect(store.deviceId, bRegistration.deviceId);

        final aRegistration = api.pending.first;
        aRegistration.complete();
        await aLogin;
        expect(store.deviceId, bRegistration.deviceId);
        expect(store.deviceId, isNot(aRegistration.deviceId));
      },
    );

    test(
      'late registration after logout with no new session cannot restore id',
      () async {
        final api = ControllableDeviceApi();
        final store = FakeDeviceIdStore();
        final sut = controller(
          messaging: FakeMessagingClient(),
          deviceApi: api,
          deviceStore: store,
        );

        final login = sut.onAuthenticated();
        await pumpUntil(() => api.pending.length == 1);
        await sut.onLogout(sessionToken: 'provider-session');
        api.pending.single.complete();
        await login;

        expect(store.deviceId, isNull);
      },
    );

    test(
      'failed registration releases the in-flight key for a later retry',
      () async {
        final api = ControllableDeviceApi();
        final sut = controller(
          messaging: FakeMessagingClient(),
          deviceApi: api,
        );
        await sut.initialize();

        final first = sut.onAuthenticated();
        await pumpUntil(() => api.pending.length == 1);
        api.pending.single.completer.completeError(
          const ProviderDeviceApiException(500),
        );
        await first;

        final retry = sut.onAuthenticated();
        await pumpUntil(() => api.pending.length == 2);
        api.pending.last.complete();
        await retry;
      },
    );
  });

  group('foreground, tap, and permission behavior', () {
    test('foreground callback receives only a valid safe intent', () async {
      ProviderNotificationIntent? seen;
      final messaging = FakeMessagingClient();
      final sut = controller(
        messaging: messaging,
        onForegroundMessage: (intent) => seen = intent,
      );
      await sut.initialize();

      messaging.messageController.add(validOpportunityIntent);
      await pumpUntil(() => seen != null);
      expect(seen!.requestId, 'MOE-1001');

      seen = null;
      messaging.messageController.add(null);
      await Future<void>.delayed(Duration.zero);
      expect(seen, isNull);
    });

    test(
      'logged-out notification tap waits for authenticated session',
      () async {
        var loggedIn = false;
        ProviderNotificationIntent? seen;
        final messaging = FakeMessagingClient();
        final sut = controller(
          messaging: messaging,
          sessionTokenProvider: () async =>
              loggedIn ? 'provider-session' : null,
          onOpenedIntent: (intent) async => seen = intent,
        );
        await sut.initialize();

        messaging.openedController.add(validOpportunityIntent);
        await Future<void>.delayed(Duration.zero);
        expect(seen, isNull);

        loggedIn = true;
        await sut.onAuthenticated();
        expect(seen?.requestId, 'MOE-1001');
      },
    );

    test(
      'authenticated opportunity and job taps route through callback',
      () async {
        final seen = <ProviderNotificationNavigate>[];
        final messaging = FakeMessagingClient();
        final sut = controller(
          messaging: messaging,
          onOpenedIntent: (intent) async => seen.add(intent.navigate),
        );
        await sut.initialize();
        messaging.openedController.add(validOpportunityIntent);
        messaging.openedController.add(
          const ProviderNotificationIntent(
            type: ProviderNotificationType.providerAssigned,
            requestId: 'MOE-1002',
            navigate: ProviderNotificationNavigate.job,
            eventId: 'evt-2',
            version: 1,
          ),
        );

        await pumpUntil(() => seen.length == 2);
        expect(seen, [
          ProviderNotificationNavigate.opportunity,
          ProviderNotificationNavigate.job,
        ]);
      },
    );

    test(
      'terminated-app message routes once readiness and auth exist',
      () async {
        ProviderNotificationIntent? seen;
        final messaging = FakeMessagingClient()
          ..initialMessage = validOpportunityIntent;
        final sut = controller(
          messaging: messaging,
          onOpenedIntent: (intent) async => seen = intent,
        );

        await sut.handleInitialMessage();
        await sut.handleInitialMessage();
        expect(seen?.requestId, 'MOE-1001');
      },
    );

    test('denied permission does not prevent registration', () async {
      final api = FakeDeviceApi();
      await controller(
        messaging: FakeMessagingClient()
          ..currentPermissionValue = ProviderNotificationPermission.denied,
        deviceApi: api,
      ).onAuthenticated();
      expect(api.registrations, hasLength(1));
    });

    test('authorized permission proceeds without requesting again', () async {
      final messaging = FakeMessagingClient()
        ..currentPermissionValue = ProviderNotificationPermission.authorized;
      final api = FakeDeviceApi();
      await controller(messaging: messaging, deviceApi: api).onAuthenticated();
      expect(messaging.requestPermissionCalls, 0);
      expect(api.registrations, hasLength(1));
    });

    test('not-determined permission is requested only once', () async {
      final messaging = FakeMessagingClient();
      final sut = controller(messaging: messaging);
      await sut.onAuthenticated();
      await sut.onAuthenticated();
      expect(messaging.requestPermissionCalls, 1);
    });

    test(
      'Firebase initialization failure leaves provider lifecycle usable',
      () async {
        final messaging = FakeMessagingClient()..initializeResult = false;
        final api = FakeDeviceApi();
        await controller(
          messaging: messaging,
          deviceApi: api,
        ).onAuthenticated();
        expect(api.registrations, isEmpty);
      },
    );
  });
}
