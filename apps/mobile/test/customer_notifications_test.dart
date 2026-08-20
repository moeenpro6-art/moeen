import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:moeen_mobile/customer_notifications.dart';

/// In-memory device-id store for tests (no platform storage plugin).
class FakeDeviceIdStore implements CustomerDeviceIdStore {
  String? deviceId;

  @override
  Future<String?> read() async => deviceId;

  @override
  Future<void> write(String deviceId) async => this.deviceId = deviceId;

  @override
  Future<void> clear() async => deviceId = null;
}

/// In-memory "permission attempt" store. Mirrors the app-level semantics of
/// the real secure-storage store: the flag is set once a prompt was
/// attempted and is NOT cleared by logout.
class FakePermissionRequestedStore implements CustomerPermissionRequestedStore {
  FakePermissionRequestedStore({this.permissionRequested = false});

  bool permissionRequested;

  @override
  Future<bool> hasRequested() async => permissionRequested;

  @override
  Future<void> markRequested() async => permissionRequested = true;
}

/// In-memory device API for tests. Records registration/revocation calls.
class FakeDeviceApi implements CustomerDeviceApi {
  final registered = <String>[];
  final revoked = <String>[];
  DeviceApiException? registerError;
  DeviceApiException? revokeError;
  int _nextDeviceId = 1;

  @override
  Future<RegisteredDevice> register({
    required String fcmToken,
    required String sessionToken,
  }) async {
    if (registerError != null) throw registerError!;
    registered.add(fcmToken);
    return RegisteredDevice(
      deviceId: 'DEV-${_nextDeviceId++}',
      platform: 'android',
      createdAt: '2026-08-18T00:00:00.000Z',
      lastSeenAt: '2026-08-18T00:00:00.000Z',
      active: true,
    );
  }

  @override
  Future<void> revoke({
    required String deviceId,
    required String sessionToken,
  }) async {
    if (revokeError != null) throw revokeError!;
    revoked.add(deviceId);
  }
}

/// Controllable device API: every registration stays pending until the test
/// explicitly completes it, so an old account's response can be held open
/// while a new account logs in. Each call records the token/session it was
/// made with so tests can prove which account a registration belonged to.
class ControllableDeviceApi implements CustomerDeviceApi {
  final List<ControlledRegistration> pending = [];
  final revoked = <String>[];
  int _next = 1;

  @override
  Future<RegisteredDevice> register({
    required String fcmToken,
    required String sessionToken,
  }) {
    final registration = ControlledRegistration(
      fcmToken: fcmToken,
      sessionToken: sessionToken,
      deviceId: 'DEV-${_next++}',
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
  final Completer<RegisteredDevice> completer = Completer<RegisteredDevice>();

  void complete() {
    completer.complete(
      RegisteredDevice(
        deviceId: deviceId,
        platform: 'android',
        createdAt: '2026-08-18T00:00:00.000Z',
        lastSeenAt: '2026-08-18T00:00:00.000Z',
        active: true,
      ),
    );
  }
}

/// Advances microtasks/event-loop turns until [condition] is satisfied (used
/// to let an in-flight async registration reach the point under test).
Future<void> pumpUntil(bool Function() condition) async {
  for (var i = 0; i < 200 && !condition(); i++) {
    await Future<void>.delayed(Duration.zero);
  }
  expect(condition(), isTrue, reason: 'condition not reached after pumping');
}

/// Configurable messaging fake.
class FakeMessagingClient implements CustomerMessagingClient {
  FakeMessagingClient({
    this.initializeResult = true,
    this.currentPermissionValue = CustomerNotificationPermission.notDetermined,
    this.requestedPermission = CustomerNotificationPermission.authorized,
    this.token = 'fcm-token-1234567890',
  });

  bool initializeResult;
  CustomerNotificationPermission currentPermissionValue;
  CustomerNotificationPermission requestedPermission;
  String? token;

  int initializeCalls = 0;
  int requestPermissionCalls = 0;
  int getTokenCalls = 0;

  final tokenRefreshController = StreamController<String>.broadcast();
  final messageController =
      StreamController<CustomerNotificationIntent?>.broadcast();
  final openedController =
      StreamController<CustomerNotificationIntent?>.broadcast();
  CustomerNotificationIntent? initialMessage;

  @override
  Future<bool> initialize() async {
    initializeCalls++;
    return initializeResult;
  }

  @override
  Future<CustomerNotificationPermission> currentPermission() async =>
      currentPermissionValue;

  @override
  Future<CustomerNotificationPermission> requestPermission() async {
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
  Stream<CustomerNotificationIntent?> get onMessage => messageController.stream;

  @override
  Stream<CustomerNotificationIntent?> get onMessageOpenedApp =>
      openedController.stream;

  @override
  Future<CustomerNotificationIntent?> getInitialMessage() async =>
      initialMessage;
}

const _validIntent = CustomerNotificationIntent(
  type: CustomerNotificationType.quoteReceived,
  requestId: 'MOE-1001',
  navigate: CustomerNotificationNavigate.customerRequestDetail,
  eventId: 'evt-1',
  version: 1,
);

CustomerNotificationController _controller({
  required FakeMessagingClient messaging,
  CustomerDeviceApi? deviceApi,
  FakeDeviceIdStore? deviceStore,
  CustomerPermissionRequestedStore? permissionRequestedStore,
  Future<String?> Function()? sessionTokenProvider,
  void Function(CustomerNotificationIntent)? onForegroundMessage,
  void Function(CustomerNotificationIntent)? onOpenedIntent,
}) {
  return CustomerNotificationController(
    enabled: true,
    messaging: messaging,
    deviceApi: deviceApi ?? FakeDeviceApi(),
    deviceStore: deviceStore ?? FakeDeviceIdStore(),
    permissionRequestedStore:
        permissionRequestedStore ?? FakePermissionRequestedStore(),
    sessionTokenProvider: sessionTokenProvider ?? () async => 'token-123',
    onForegroundMessage: onForegroundMessage,
    onOpenedIntent: onOpenedIntent,
  );
}

void main() {
  group('payload parsing', () {
    test('parses a valid customer payload', () {
      final intent = parseCustomerNotificationIntent({
        'type': 'quote_received',
        'requestId': 'MOE-1001',
        'navigate': 'customer_request_detail',
        'eventId': 'evt-1',
        'v': '1',
      });

      expect(intent, isNotNull);
      expect(intent!.type, CustomerNotificationType.quoteReceived);
      expect(intent.requestId, 'MOE-1001');
      expect(
        intent.navigate,
        CustomerNotificationNavigate.customerRequestDetail,
      );
      expect(intent.eventId, 'evt-1');
    });

    test('parses a list navigation target', () {
      final intent = parseCustomerNotificationIntent({
        'type': 'request_cancelled',
        'requestId': 'MOE-1002',
        'navigate': 'customer_requests_list',
        'eventId': 'evt-2',
        'v': '1',
      });
      expect(intent, isNotNull);
      expect(
        intent!.navigate,
        CustomerNotificationNavigate.customerRequestsList,
      );
    });

    test('ignores provider/unknown notification types', () {
      expect(
        parseCustomerNotificationIntent({
          'type': 'opportunity_invited',
          'requestId': 'MOE-1001',
          'navigate': 'provider_opportunity',
          'eventId': 'evt-1',
          'v': '1',
        }),
        isNull,
      );
      expect(
        parseCustomerNotificationIntent({
          'type': 'totally_unknown',
          'requestId': 'MOE-1001',
          'navigate': 'customer_request_detail',
          'eventId': 'evt-1',
          'v': '1',
        }),
        isNull,
      );
    });

    test('ignores unknown navigation targets', () {
      expect(
        parseCustomerNotificationIntent({
          'type': 'quote_received',
          'requestId': 'MOE-1001',
          'navigate': 'provider_job',
          'eventId': 'evt-1',
          'v': '1',
        }),
        isNull,
      );
    });

    test('rejects malformed or missing requestId', () {
      expect(
        parseCustomerNotificationIntent({
          'type': 'quote_received',
          'requestId': 'not-a-public-id',
          'navigate': 'customer_request_detail',
          'eventId': 'evt-1',
          'v': '1',
        }),
        isNull,
      );
      expect(
        parseCustomerNotificationIntent({
          'type': 'quote_received',
          'navigate': 'customer_request_detail',
          'eventId': 'evt-1',
          'v': '1',
        }),
        isNull,
      );
      expect(parseCustomerNotificationIntent({}), isNull);
    });

    test('rejects an unsupported payload version', () {
      expect(
        parseCustomerNotificationIntent({
          'type': 'quote_received',
          'requestId': 'MOE-1001',
          'navigate': 'customer_request_detail',
          'eventId': 'evt-1',
          'v': '2',
        }),
        isNull,
      );
      expect(
        parseCustomerNotificationIntent({
          'type': 'quote_received',
          'requestId': 'MOE-1001',
          'navigate': 'customer_request_detail',
          'eventId': 'evt-1',
          'v': 1,
        }),
        isNull,
      );
    });

    test('rejects a missing eventId', () {
      expect(
        parseCustomerNotificationIntent({
          'type': 'quote_received',
          'requestId': 'MOE-1001',
          'navigate': 'customer_request_detail',
          'v': '1',
        }),
        isNull,
      );
    });

    test('parser ignores smuggled sensitive fields (never renders them)', () {
      // Even if an unexpected sensitive field rides along, it is not read and
      // the parsed intent has no field capable of carrying it.
      final intent = parseCustomerNotificationIntent({
        'type': 'quote_received',
        'requestId': 'MOE-1001',
        'navigate': 'customer_request_detail',
        'eventId': 'evt-1',
        'v': '1',
        'customerName': 'أحمد',
        'phone': '+966500000000',
        'address': 'بريدة',
        'images': 'https://example.test/x.jpg',
        'scope': 'quote free text',
        'token': 'secret',
      });
      expect(intent, isNotNull);
      expect(intent.toString(), isNot(contains('أحمد')));
      expect(intent.toString(), isNot(contains('secret')));
      expect(intent.toString(), isNot(contains('https://')));
    });

    test('summaries only interpolate the public request id', () {
      final summary = customerNotificationSummary(_validIntent);
      expect(summary, contains('MOE-1001'));
      expect(summary, isNot(contains('evt-1')));
    });
  });

  group('config / lifecycle', () {
    test('disabled controller never initializes or registers', () async {
      final messaging = FakeMessagingClient();
      final deviceApi = FakeDeviceApi();
      final controller = CustomerNotificationController(
        enabled: false,
        messaging: messaging,
        deviceApi: deviceApi,
        deviceStore: FakeDeviceIdStore(),
        permissionRequestedStore: FakePermissionRequestedStore(),
        sessionTokenProvider: () async => 'token-123',
      );

      await controller.initialize();
      await controller.onAuthenticated();
      await controller.onLogout(sessionToken: 'token-123');
      await controller.handleInitialMessage();

      expect(messaging.initializeCalls, 0);
      expect(messaging.requestPermissionCalls, 0);
      expect(messaging.getTokenCalls, 0);
      expect(deviceApi.registered, isEmpty);
      expect(deviceApi.revoked, isEmpty);
    });

    test('authenticated login registers token and stores deviceId', () async {
      final messaging = FakeMessagingClient();
      final deviceApi = FakeDeviceApi();
      final store = FakeDeviceIdStore();
      final controller = _controller(
        messaging: messaging,
        deviceApi: deviceApi,
        deviceStore: store,
      );

      await controller.onAuthenticated();

      expect(deviceApi.registered, ['fcm-token-1234567890']);
      expect(store.deviceId, 'DEV-1');
    });

    test('registration failure does not fail login', () async {
      final messaging = FakeMessagingClient();
      final deviceApi = FakeDeviceApi()
        ..registerError = const DeviceApiException(500);
      final controller = _controller(
        messaging: messaging,
        deviceApi: deviceApi,
      );

      await controller.onAuthenticated();

      // No exception thrown; nothing is stored because registration failed.
      expect(deviceApi.registered, isEmpty);
    });

    test('token refresh triggers a new registration', () async {
      final messaging = FakeMessagingClient();
      final deviceApi = FakeDeviceApi();
      final controller = _controller(
        messaging: messaging,
        deviceApi: deviceApi,
      );

      await controller.initialize();
      await controller.onAuthenticated();
      expect(deviceApi.registered, hasLength(1));

      messaging.token = 'refreshed-token-abcdef';
      messaging.tokenRefreshController.add('refreshed-token-abcdef');
      await Future<void>.delayed(Duration.zero);

      expect(deviceApi.registered, hasLength(2));
      expect(deviceApi.registered.last, 'refreshed-token-abcdef');
    });

    test(
      'duplicate concurrent same-token registrations are deduplicated',
      () async {
        final messaging = FakeMessagingClient()..token = 'shared-token';
        final deviceApi = ControllableDeviceApi();
        final controller = _controller(
          messaging: messaging,
          deviceApi: deviceApi,
        );

        await controller.initialize();
        final login = controller.onAuthenticated();
        await pumpUntil(() => deviceApi.pending.length == 1);

        // Fire several refresh events while the registration is still in-flight.
        // They share the same token, so the in-flight key collapses them to one.
        for (var i = 0; i < 5; i++) {
          messaging.tokenRefreshController.add('shared-token');
        }
        await Future<void>.delayed(Duration.zero);

        expect(deviceApi.pending.length, 1);

        deviceApi.pending.single.complete();
        await login;
      },
    );

    test('logout revokes own deviceId and clears local record', () async {
      final messaging = FakeMessagingClient();
      final deviceApi = FakeDeviceApi();
      final store = FakeDeviceIdStore();
      final controller = _controller(
        messaging: messaging,
        deviceApi: deviceApi,
        deviceStore: store,
      );

      await controller.onAuthenticated();
      expect(store.deviceId, 'DEV-1');

      await controller.onLogout(sessionToken: 'token-123');

      expect(deviceApi.revoked, ['DEV-1']);
      expect(store.deviceId, isNull);
    });

    test(
      'failed revoke does not block logout and clears local record',
      () async {
        final messaging = FakeMessagingClient();
        final deviceApi = FakeDeviceApi()
          ..revokeError = const DeviceApiException(500);
        final store = FakeDeviceIdStore()..deviceId = 'DEV-9';
        final controller = _controller(
          messaging: messaging,
          deviceApi: deviceApi,
          deviceStore: store,
        );

        await controller.onLogout(sessionToken: 'token-123');

        // No exception; local record is cleared even though revoke failed.
        expect(store.deviceId, isNull);
      },
    );

    test('next account login re-registers/rebinds the current token', () async {
      final messaging = FakeMessagingClient();
      final deviceApi = FakeDeviceApi();
      final store = FakeDeviceIdStore()..deviceId = 'DEV-OLD-ACCOUNT';
      final controller = _controller(
        messaging: messaging,
        deviceApi: deviceApi,
        deviceStore: store,
      );

      // First account registered DEV-1, then logged out.
      await controller.onAuthenticated();
      await controller.onLogout(sessionToken: 'token-1');
      expect(store.deviceId, isNull);

      // Second account login registers again and stores the NEW deviceId.
      await controller.onAuthenticated();
      expect(deviceApi.registered, hasLength(2));
      expect(store.deviceId, 'DEV-2');
    });

    test('getToken returning null never crashes', () async {
      final messaging = FakeMessagingClient()..token = null;
      final deviceApi = FakeDeviceApi();
      final controller = _controller(
        messaging: messaging,
        deviceApi: deviceApi,
      );

      await controller.onAuthenticated();

      expect(deviceApi.registered, isEmpty);
    });
  });

  group('account-switch registration race (H1 regression)', () {
    test('A: old account late response cannot overwrite B deviceId', () async {
      final messaging = FakeMessagingClient()..token = 'fcm-token-1234567890';
      final deviceApi = ControllableDeviceApi();
      final store = FakeDeviceIdStore();
      var sessionToken = 'token-A';
      final controller = _controller(
        messaging: messaging,
        deviceApi: deviceApi,
        deviceStore: store,
        sessionTokenProvider: () async => sessionToken,
      );

      // 1-2. Account A logs in; its registration starts and stays pending.
      final aLogin = controller.onAuthenticated();
      await pumpUntil(() => deviceApi.pending.length == 1);
      expect(deviceApi.pending.single.sessionToken, 'token-A');

      // 3-4. A logs out (invalidates A's in-flight work), then B logs in.
      await controller.onLogout(sessionToken: 'token-A');
      sessionToken = 'token-B';
      final bLogin = controller.onAuthenticated();

      // 5-6. B's registration MUST start even while A's request is pending.
      await pumpUntil(() => deviceApi.pending.length == 2);
      expect(deviceApi.pending.last.sessionToken, 'token-B');

      // 7. B's response returns -> B deviceId stored.
      final bReg = deviceApi.pending.last;
      bReg.complete();
      await bLogin;
      expect(store.deviceId, bReg.deviceId);

      // 8. A's response returns late.
      final aReg = deviceApi.pending.first;
      aReg.complete();
      await aLogin;

      // 9. Stored deviceId must remain B's, not A's.
      expect(store.deviceId, bReg.deviceId);
      expect(store.deviceId, isNot(aReg.deviceId));
    });

    test(
      'B: logout with no new login discards the in-flight response',
      () async {
        final messaging = FakeMessagingClient()..token = 'fcm-token-1234567890';
        final deviceApi = ControllableDeviceApi();
        final store = FakeDeviceIdStore();
        final controller = _controller(
          messaging: messaging,
          deviceApi: deviceApi,
          deviceStore: store,
          sessionTokenProvider: () async => 'token-A',
        );

        // 1. A's registration is in-flight.
        final login = controller.onAuthenticated();
        await pumpUntil(() => deviceApi.pending.length == 1);

        // 2. Logout invalidates it.
        await controller.onLogout(sessionToken: 'token-A');
        expect(store.deviceId, isNull);

        // 3. Old response returns.
        deviceApi.pending.single.complete();
        await login;

        // 4. No deviceId is re-written.
        expect(store.deviceId, isNull);
      },
    );

    test(
      'C: same session + same token collapses concurrent registrations',
      () async {
        final messaging = FakeMessagingClient()..token = 'shared-token';
        final deviceApi = ControllableDeviceApi();
        final controller = _controller(
          messaging: messaging,
          deviceApi: deviceApi,
          sessionTokenProvider: () async => 'token-A',
        );

        await controller.initialize();
        final login = controller.onAuthenticated();
        await pumpUntil(() => deviceApi.pending.length == 1);

        // Fire a burst of refresh events for the SAME token in the SAME session.
        for (var i = 0; i < 5; i++) {
          messaging.tokenRefreshController.add('shared-token');
        }
        await Future<void>.delayed(Duration.zero);

        // Only the original registration is outstanding.
        expect(deviceApi.pending.length, 1);

        deviceApi.pending.single.complete();
        await login;
        await Future<void>.delayed(Duration.zero);
      },
    );

    test(
      'D: token refresh after account switch registers for new session',
      () async {
        final messaging = FakeMessagingClient()..token = 'fcm-token-1234567890';
        final deviceApi = ControllableDeviceApi();
        final store = FakeDeviceIdStore();
        var sessionToken = 'token-A';
        final controller = _controller(
          messaging: messaging,
          deviceApi: deviceApi,
          deviceStore: store,
          sessionTokenProvider: () async => sessionToken,
        );

        await controller.initialize();

        // Account A: refresh fires, registration stays pending.
        final aLogin = controller.onAuthenticated();
        await pumpUntil(() => deviceApi.pending.length == 1);
        expect(deviceApi.pending.single.sessionToken, 'token-A');

        // Logout A, login B.
        await controller.onLogout(sessionToken: 'token-A');
        sessionToken = 'token-B';
        final bLogin = controller.onAuthenticated();
        await pumpUntil(() => deviceApi.pending.length == 2);

        // B's registration completes normally.
        final bReg = deviceApi.pending.last;
        bReg.complete();
        await bLogin;
        expect(store.deviceId, bReg.deviceId);

        // Old A registration returns late and is discarded.
        final aReg = deviceApi.pending.first;
        aReg.complete();
        await aLogin;
        expect(store.deviceId, bReg.deviceId);

        // A token refresh in B's session registers again (not suppressed).
        messaging.token = 'refreshed-token-b';
        messaging.tokenRefreshController.add('refreshed-token-b');
        await pumpUntil(() => deviceApi.pending.length == 3);
        expect(deviceApi.pending.last.sessionToken, 'token-B');
        expect(deviceApi.pending.last.fcmToken, 'refreshed-token-b');
      },
    );

    test('E: failed registration releases in-flight state for retry', () async {
      final messaging = FakeMessagingClient()..token = 'fcm-token-1234567890';
      final deviceApi = ControllableDeviceApi();
      final controller = _controller(
        messaging: messaging,
        deviceApi: deviceApi,
        sessionTokenProvider: () async => 'token-A',
      );

      await controller.initialize();

      // First attempt fails (complete with an error).
      final first = controller.onAuthenticated();
      await pumpUntil(() => deviceApi.pending.length == 1);
      deviceApi.pending.single.completer.completeError(
        const DeviceApiException(500),
      );
      await first;
      await Future<void>.delayed(Duration.zero);

      // A later retry in the same session must start a NEW registration.
      final retry = controller.onAuthenticated();
      await pumpUntil(() => deviceApi.pending.length == 2);
      expect(deviceApi.pending.length, 2);

      // Clean up: complete the retry so the future resolves.
      deviceApi.pending.last.complete();
      await retry;
    });
  });

  group('navigation', () {
    test('foreground message produces a safe in-app callback', () async {
      final messaging = FakeMessagingClient();
      CustomerNotificationIntent? seen;
      final controller = _controller(
        messaging: messaging,
        onForegroundMessage: (intent) => seen = intent,
      );

      await controller.initialize();
      messaging.messageController.add(_validIntent);
      await Future<void>.delayed(Duration.zero);

      expect(seen, isNotNull);
      expect(seen!.requestId, 'MOE-1001');
    });

    test('foreground message with invalid payload is ignored', () async {
      final messaging = FakeMessagingClient();
      var called = 0;
      final controller = _controller(
        messaging: messaging,
        onForegroundMessage: (_) => called++,
      );

      await controller.initialize();
      messaging.messageController.add(null);
      await Future<void>.delayed(Duration.zero);

      expect(called, 0);
    });

    test('tap while authenticated routes via onOpenedIntent', () async {
      final messaging = FakeMessagingClient();
      CustomerNotificationIntent? seen;
      final controller = _controller(
        messaging: messaging,
        onOpenedIntent: (intent) => seen = intent,
      );

      await controller.initialize();
      messaging.openedController.add(_validIntent);
      await Future<void>.delayed(Duration.zero);

      expect(seen, isNotNull);
      expect(seen!.requestId, 'MOE-1001');
    });

    test(
      'tap while logged out defers until after login (does not bypass auth)',
      () async {
        final messaging = FakeMessagingClient();
        final deviceApi = FakeDeviceApi();
        CustomerNotificationIntent? seen;
        var loggedIn = false;
        final controller = CustomerNotificationController(
          enabled: true,
          messaging: messaging,
          deviceApi: deviceApi,
          deviceStore: FakeDeviceIdStore(),
          permissionRequestedStore: FakePermissionRequestedStore(),
          sessionTokenProvider: () async => loggedIn ? 'token-123' : null,
          onOpenedIntent: (intent) => seen = intent,
        );

        await controller.initialize();
        messaging.openedController.add(_validIntent);
        await Future<void>.delayed(Duration.zero);
        expect(seen, isNull);

        // After login the pending intent is resolved.
        loggedIn = true;
        await controller.onAuthenticated();
        expect(seen, isNotNull);
        expect(seen!.requestId, 'MOE-1001');
      },
    );

    test('terminated initial message routes after readiness', () async {
      final messaging = FakeMessagingClient()..initialMessage = _validIntent;
      CustomerNotificationIntent? seen;
      final controller = _controller(
        messaging: messaging,
        onOpenedIntent: (intent) => seen = intent,
      );

      await controller.handleInitialMessage();

      expect(seen, isNotNull);
      expect(seen!.requestId, 'MOE-1001');
    });

    test('stale/missing request falls back safely (no crash)', () async {
      // The controller only routes an intent; the page-level fallback (no
      // matching request => stay on list) is exercised in widget_test. Here we
      // assert a null initial message routes nothing.
      final messaging = FakeMessagingClient()..initialMessage = null;
      var called = 0;
      final controller = _controller(
        messaging: messaging,
        onOpenedIntent: (_) => called++,
      );

      await controller.handleInitialMessage();
      expect(called, 0);
    });
  });

  group('android / permission', () {
    test(
      'fresh install (denied + never requested) prompts once and registers',
      () async {
        final messaging = FakeMessagingClient()
          ..currentPermissionValue = CustomerNotificationPermission.denied;
        final deviceApi = FakeDeviceApi();
        final permissionStore = FakePermissionRequestedStore();
        final controller = _controller(
          messaging: messaging,
          deviceApi: deviceApi,
          permissionRequestedStore: permissionStore,
        );

        await controller.onAuthenticated();

        // Android 13+ reports `denied` before the first request; a fresh
        // install must show the native prompt exactly once and record it.
        expect(messaging.requestPermissionCalls, 1);
        expect(permissionStore.permissionRequested, isTrue);
        // Denied permission never blocks token registration.
        expect(deviceApi.registered, ['fcm-token-1234567890']);
      },
    );

    test(
      'explicit prior denial (flag set) never re-prompts on login/restore',
      () async {
        final messaging = FakeMessagingClient()
          ..currentPermissionValue = CustomerNotificationPermission.denied;
        final permissionStore = FakePermissionRequestedStore(
          permissionRequested: true,
        );
        final deviceApi = FakeDeviceApi();
        final controller = _controller(
          messaging: messaging,
          deviceApi: deviceApi,
          permissionRequestedStore: permissionStore,
        );

        await controller.onAuthenticated();
        await controller.onAuthenticated();

        expect(messaging.requestPermissionCalls, 0);
        // Registration still proceeds (each auth activation registers once,
        // independently of display permission).
        expect(deviceApi.registered, isNotEmpty);
      },
    );

    test('authorized permission proceeds to registration', () async {
      final messaging = FakeMessagingClient()
        ..currentPermissionValue = CustomerNotificationPermission.authorized;
      final deviceApi = FakeDeviceApi();
      final controller = _controller(
        messaging: messaging,
        deviceApi: deviceApi,
      );

      await controller.onAuthenticated();

      expect(messaging.requestPermissionCalls, 0);
      expect(deviceApi.registered, ['fcm-token-1234567890']);
    });

    test('notDetermined permission is requested exactly once', () async {
      final messaging = FakeMessagingClient()
        ..currentPermissionValue = CustomerNotificationPermission.notDetermined;
      final permissionStore = FakePermissionRequestedStore();
      final deviceApi = FakeDeviceApi();
      final controller = _controller(
        messaging: messaging,
        deviceApi: deviceApi,
        permissionRequestedStore: permissionStore,
      );

      await controller.onAuthenticated();
      await controller.onAuthenticated();

      expect(messaging.requestPermissionCalls, 1);
      expect(permissionStore.permissionRequested, isTrue);
    });

    test('denied permission does not break login/core lifecycle', () async {
      final messaging = FakeMessagingClient()
        ..currentPermissionValue = CustomerNotificationPermission.denied
        ..requestedPermission = CustomerNotificationPermission.denied;
      final deviceApi = FakeDeviceApi();
      final sessionStore = FakeDeviceIdStore();
      final controller = _controller(
        messaging: messaging,
        deviceApi: deviceApi,
        deviceStore: sessionStore,
      );

      // Logout followed by a fresh login on a NEW controller instance
      // (simulating an app restart) must not throw or block registration.
      await controller.onAuthenticated();
      await controller.onLogout(sessionToken: 'token-123');
      final second = _controller(
        messaging: messaging,
        deviceApi: deviceApi,
        deviceStore: sessionStore,
        permissionRequestedStore: FakePermissionRequestedStore(
          permissionRequested: true,
        ),
      );
      await second.onAuthenticated();

      expect(deviceApi.registered, isNotEmpty);
      expect(deviceApi.revoked, isNotEmpty);
    });

    test(
      'logout/login again does not re-prompt after explicit denial',
      () async {
        // The attempt flag is app-level and survives logout and restarts.
        final messaging = FakeMessagingClient()
          ..currentPermissionValue = CustomerNotificationPermission.denied;
        final permissionStore = FakePermissionRequestedStore();
        final first = _controller(
          messaging: messaging,
          permissionRequestedStore: permissionStore,
        );
        await first.onAuthenticated();
        expect(messaging.requestPermissionCalls, 1);
        expect(permissionStore.permissionRequested, isTrue);

        await first.onLogout(sessionToken: 'token-123');

        // A later login (even in a new process sharing the same store)
        // never re-prompts after the explicit denial.
        final second = _controller(
          messaging: messaging,
          permissionRequestedStore: permissionStore,
        );
        await second.onAuthenticated();

        expect(messaging.requestPermissionCalls, 1);
        expect(permissionStore.permissionRequested, isTrue);
      },
    );

    test('messaging initialize failure leaves app usable', () async {
      final messaging = FakeMessagingClient()..initializeResult = false;
      final deviceApi = FakeDeviceApi();
      final controller = _controller(
        messaging: messaging,
        deviceApi: deviceApi,
      );

      await controller.onAuthenticated();

      // Firebase failed to init, so nothing registered, but nothing threw.
      expect(deviceApi.registered, isEmpty);
    });
  });
}
