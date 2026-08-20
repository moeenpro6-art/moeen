import 'dart:async';
import 'dart:convert';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:http/http.dart' as http;

import 'api_config.dart';

/// Customer-app push notifications (FCM-3).
///
/// Push is an OPTIONAL capability. The controller never throws into the
/// caller: Firebase init failure, permission denial, token acquisition
/// failure, and device-registration failure are all swallowed so login,
/// session restore, and request creation behave exactly as before.
///
/// This module contains only the customer role. Provider notification types
/// and navigation targets are deliberately NOT parsed here.

/// Compile-time feature flag. Defaults to `false` so local/unconfigured
/// builds never touch Firebase. A configured build enables it with:
///
///   flutter run --dart-define=MOEEN_FCM_ENABLED=true
abstract final class CustomerFcmConfig {
  static const bool enabled = bool.fromEnvironment('MOEEN_FCM_ENABLED');
}

/// Approved FCM-2 payload version. Only payloads matching this version parse.
const int customerNotificationPayloadVersion = 1;

/// The only customer notification types wired in the FCM-2 matrix.
enum CustomerNotificationType {
  requestCreated,
  quoteReceived,
  assignmentConfirmed,
  providerOnTheWay,
  serviceInProgress,
  requestCompleted,
  requestCancelled,
}

/// Customer-facing navigation targets. Provider targets are rejected.
enum CustomerNotificationNavigate {
  customerRequestsList,
  customerRequestDetail,
}

/// Parsed, privacy-safe notification intent.
///
/// Contains ONLY the approved FCM-2 data fields (`type`, `requestId`,
/// `navigate`, `eventId`, `v`). It has no field for names, phones, emails,
/// addresses, descriptions, images, storage keys, tokens, quote text or any
/// other sensitive data; full request details must always be re-fetched from
/// the authenticated API after opening.
class CustomerNotificationIntent {
  const CustomerNotificationIntent({
    required this.type,
    required this.requestId,
    required this.navigate,
    required this.eventId,
    required this.version,
  });

  final CustomerNotificationType type;
  final String requestId;
  final CustomerNotificationNavigate navigate;
  final String eventId;
  final int version;
}

/// Maps a wire notification type to the customer enum, or `null` when the
/// value is not a customer type (provider types and unknowns are rejected).
CustomerNotificationType? customerNotificationTypeFromWire(Object? value) =>
    switch (value) {
      'request_created' => CustomerNotificationType.requestCreated,
      'quote_received' => CustomerNotificationType.quoteReceived,
      'assignment_confirmed' => CustomerNotificationType.assignmentConfirmed,
      'provider_on_the_way' => CustomerNotificationType.providerOnTheWay,
      'service_in_progress' => CustomerNotificationType.serviceInProgress,
      'request_completed' => CustomerNotificationType.requestCompleted,
      'request_cancelled' => CustomerNotificationType.requestCancelled,
      _ => null,
    };

/// Maps a wire navigation target to the customer enum, or `null` when the
/// value is a provider target or unknown.
CustomerNotificationNavigate? customerNavigateFromWire(Object? value) =>
    switch (value) {
      'customer_requests_list' =>
        CustomerNotificationNavigate.customerRequestsList,
      'customer_request_detail' =>
        CustomerNotificationNavigate.customerRequestDetail,
      _ => null,
    };

/// Parses the FCM data payload against the exact FCM-2 contract.
///
/// Returns `null` for any malformed, unknown, or role-inappropriate payload.
/// Extra keys are ignored (the FCM `data` map may carry transport-level keys),
/// but every one of the five required fields must be present and valid. No
/// sensitive field is ever read or retained.
CustomerNotificationIntent? parseCustomerNotificationIntent(
  Map<String, dynamic> data,
) {
  if (data.isEmpty) return null;
  final type = customerNotificationTypeFromWire(data['type']);
  if (type == null) return null;

  final requestId = data['requestId'];
  if (requestId is! String || !RegExp(r'^MOE-\d+$').hasMatch(requestId)) {
    return null;
  }

  final navigate = customerNavigateFromWire(data['navigate']);
  if (navigate == null) return null;

  final eventId = data['eventId'];
  if (eventId is! String || eventId.isEmpty) return null;

  // The backend serializes the version as the string "1".
  if (data['v'] != '1') return null;

  return CustomerNotificationIntent(
    type: type,
    requestId: requestId,
    navigate: navigate,
    eventId: eventId,
    version: customerNotificationPayloadVersion,
  );
}

/// Short, safe Arabic summary for the in-app (foreground) indication.
///
/// Interpolates ONLY the public MOE-XXXX request identifier; it never reads
/// any other push data.
String customerNotificationSummary(CustomerNotificationIntent intent) =>
    switch (intent.type) {
      CustomerNotificationType.requestCreated =>
        'تم استلام طلبك ${intent.requestId}',
      CustomerNotificationType.quoteReceived =>
        'وصل عرض سعر جديد على طلبك ${intent.requestId}',
      CustomerNotificationType.assignmentConfirmed =>
        'تم تأكيد طلبك ${intent.requestId}',
      CustomerNotificationType.providerOnTheWay =>
        'مقدم الخدمة في الطريق لطلبك ${intent.requestId}',
      CustomerNotificationType.serviceInProgress =>
        'بدأ تنفيذ طلبك ${intent.requestId}',
      CustomerNotificationType.requestCompleted =>
        'اكتمل تنفيذ طلبك ${intent.requestId}',
      CustomerNotificationType.requestCancelled =>
        'تم إلغاء طلبك ${intent.requestId}',
    };

/// Notification permission as understood by the customer app.
enum CustomerNotificationPermission {
  authorized,
  provisional,
  denied,
  notDetermined,
}

/// Messaging client seam. The production implementation wraps
/// `firebase_core` + `firebase_messaging`; tests inject a fake so widget and
/// unit tests never require real Firebase or `google-services.json`.
abstract interface class CustomerMessagingClient {
  Future<bool> initialize();

  Future<CustomerNotificationPermission> currentPermission();

  Future<CustomerNotificationPermission> requestPermission();

  Future<String?> getToken();

  Stream<String> get onTokenRefresh;

  /// Parsed foreground messages. Invalid payloads are filtered to `null`.
  Stream<CustomerNotificationIntent?> get onMessage;

  /// Parsed tap-on-background messages. Invalid payloads are `null`.
  Stream<CustomerNotificationIntent?> get onMessageOpenedApp;

  /// Parsed tap-on-terminated message, consumed once.
  Future<CustomerNotificationIntent?> getInitialMessage();
}

/// Production messaging adapter. Every public method is guarded and returns a
/// safe default (or `null`) when Firebase failed to initialize, so a missing
/// `google-services.json` can never break core customer flows.
class FirebaseMessagingClient implements CustomerMessagingClient {
  FirebaseMessagingClient({this.platform = 'android'});

  /// Registration platform for /my/devices. Android-first; pass 'ios' later.
  final String platform;

  FirebaseMessaging? _messaging;

  @override
  Future<bool> initialize() async {
    if (_messaging != null) return true;
    try {
      await Firebase.initializeApp();
      final messaging = FirebaseMessaging.instance;
      // Foreground messages are surfaced in-app via SnackBar, not as a
      // duplicate system notification.
      await messaging.setForegroundNotificationPresentationOptions(
        alert: false,
        badge: false,
        sound: false,
      );
      _messaging = messaging;
      return true;
    } catch (_) {
      _messaging = null;
      return false;
    }
  }

  CustomerNotificationPermission _map(AuthorizationStatus status) =>
      switch (status) {
        AuthorizationStatus.authorized =>
          CustomerNotificationPermission.authorized,
        AuthorizationStatus.provisional =>
          CustomerNotificationPermission.provisional,
        AuthorizationStatus.denied => CustomerNotificationPermission.denied,
        AuthorizationStatus.notDetermined =>
          CustomerNotificationPermission.notDetermined,
      };

  @override
  Future<CustomerNotificationPermission> currentPermission() async {
    final messaging = _messaging;
    if (messaging == null) return CustomerNotificationPermission.denied;
    try {
      final settings = await messaging.getNotificationSettings();
      return _map(settings.authorizationStatus);
    } catch (_) {
      return CustomerNotificationPermission.denied;
    }
  }

  @override
  Future<CustomerNotificationPermission> requestPermission() async {
    final messaging = _messaging;
    if (messaging == null) return CustomerNotificationPermission.denied;
    try {
      final settings = await messaging.requestPermission();
      return _map(settings.authorizationStatus);
    } catch (_) {
      return CustomerNotificationPermission.denied;
    }
  }

  @override
  Future<String?> getToken() async {
    final messaging = _messaging;
    if (messaging == null) return null;
    try {
      return await messaging.getToken();
    } catch (_) {
      return null;
    }
  }

  @override
  Stream<String> get onTokenRefresh {
    final messaging = _messaging;
    if (messaging == null) return const Stream<String>.empty();
    return messaging.onTokenRefresh;
  }

  @override
  Stream<CustomerNotificationIntent?> get onMessage {
    final messaging = _messaging;
    if (messaging == null) {
      return const Stream<CustomerNotificationIntent?>.empty();
    }
    return FirebaseMessaging.onMessage.map(
      (message) => parseCustomerNotificationIntent(message.data),
    );
  }

  @override
  Stream<CustomerNotificationIntent?> get onMessageOpenedApp {
    final messaging = _messaging;
    if (messaging == null) {
      return const Stream<CustomerNotificationIntent?>.empty();
    }
    return FirebaseMessaging.onMessageOpenedApp.map(
      (message) => parseCustomerNotificationIntent(message.data),
    );
  }

  @override
  Future<CustomerNotificationIntent?> getInitialMessage() async {
    final messaging = _messaging;
    if (messaging == null) return null;
    try {
      final message = await messaging.getInitialMessage();
      return message == null
          ? null
          : parseCustomerNotificationIntent(message.data);
    } catch (_) {
      return null;
    }
  }
}

/// Safe public device representation returned by `POST /my/devices`.
class RegisteredDevice {
  const RegisteredDevice({
    required this.deviceId,
    required this.platform,
    required this.createdAt,
    required this.lastSeenAt,
    required this.active,
  });

  final String deviceId;
  final String platform;
  final String createdAt;
  final String lastSeenAt;
  final bool active;

  factory RegisteredDevice.fromJson(Map<String, dynamic> json) =>
      RegisteredDevice(
        deviceId: json['deviceId'] as String,
        platform: json['platform'] as String? ?? '',
        createdAt: json['createdAt'] as String? ?? '',
        lastSeenAt: json['lastSeenAt'] as String? ?? '',
        active: json['active'] as bool? ?? false,
      );
}

/// Device-registration API seam backed by the FCM-1 customer endpoints.
abstract interface class CustomerDeviceApi {
  Future<RegisteredDevice> register({
    required String fcmToken,
    required String sessionToken,
  });

  Future<void> revoke({required String deviceId, required String sessionToken});
}

class DeviceApiException implements Exception {
  const DeviceApiException(this.statusCode);

  final int statusCode;
}

/// Production device API. Never sends a customer id; ownership is derived
/// server-side from the bearer token. Never logs the FCM token.
class HttpCustomerDeviceApi implements CustomerDeviceApi {
  HttpCustomerDeviceApi({
    required this.client,
    required this.config,
    this.platform = 'android',
  });

  final http.Client client;
  final MoeenApiConfig config;
  final String platform;

  static const _timeout = Duration(seconds: 10);

  @override
  Future<RegisteredDevice> register({
    required String fcmToken,
    required String sessionToken,
  }) async {
    final response = await client
        .post(
          config.endpoint('/my/devices'),
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer $sessionToken',
          },
          body: jsonEncode({'token': fcmToken, 'platform': platform}),
        )
        .timeout(_timeout);
    if (response.statusCode != 201) {
      throw DeviceApiException(response.statusCode);
    }
    return RegisteredDevice.fromJson(
      jsonDecode(response.body) as Map<String, dynamic>,
    );
  }

  @override
  Future<void> revoke({
    required String deviceId,
    required String sessionToken,
  }) async {
    final response = await client
        .delete(
          config.endpoint('/my/devices/${Uri.encodeComponent(deviceId)}'),
          headers: {'Authorization': 'Bearer $sessionToken'},
        )
        .timeout(_timeout);
    if (response.statusCode != 200) {
      throw DeviceApiException(response.statusCode);
    }
  }
}

/// Local store for the registered device identity (only the backend-issued
/// `deviceId` is kept; never the raw FCM token). The concrete secure-storage
/// implementation lives with the app wiring in `main.dart`; tests inject a
/// fake so no platform storage plugin is required.
abstract interface class CustomerDeviceIdStore {
  Future<String?> read();

  Future<void> write(String deviceId);

  Future<void> clear();
}

/// Local record of whether this app has already attempted to request the
/// notification permission (Android-first).
///
/// On Android 13+, `firebase_messaging` reports `denied` BOTH before the
/// permission has ever been requested AND after the user explicitly denied
/// it. Without a persistent "attempted" flag, a fresh install would never
/// show the native first prompt (the status is not `notDetermined`), while a
/// returning user who already denied would be re-prompted on every launch.
///
/// Only a boolean is stored — never the FCM token, account ids, request data,
/// or secrets. The flag is app-level, not account-level, so logout does not
/// reset it; clearing app data / a fresh install does (because the storage is
/// wiped with the app data).
abstract interface class CustomerPermissionRequestedStore {
  /// Whether the app has previously attempted the native permission request.
  Future<bool> hasRequested();

  /// Persists that the native permission request has now been attempted.
  Future<void> markRequested();
}

/// Lifecycle controller: Firebase init, permission, token registration,
/// refresh, revocation, and tap routing. Everything is best-effort; no method
/// throws into the caller.
class CustomerNotificationController {
  CustomerNotificationController({
    required this.enabled,
    required this.messaging,
    required this.deviceApi,
    required this.deviceStore,
    required this.permissionRequestedStore,
    required this.sessionTokenProvider,
    this.onForegroundMessage,
    this.onOpenedIntent,
  });

  final bool enabled;
  final CustomerMessagingClient messaging;
  final CustomerDeviceApi deviceApi;
  final CustomerDeviceIdStore deviceStore;

  /// Persistent record of whether the native permission prompt has been
  /// attempted on this Android device. The flag is app-level, not
  /// account-level, so logout does not reset it; it is naturally cleared
  /// when the user wipes app data.
  final CustomerPermissionRequestedStore permissionRequestedStore;

  /// Resolves the current authenticated session token, or `null` when logged
  /// out. Used to decide whether a tap may open request UI and to authorize
  /// device registration.
  final Future<String?> Function() sessionTokenProvider;

  /// Foreground message callback (UI shows a lightweight indication).
  void Function(CustomerNotificationIntent intent)? onForegroundMessage;

  /// Tap / terminated-message callback once authenticated (UI navigates).
  void Function(CustomerNotificationIntent intent)? onOpenedIntent;

  bool _initialized = false;
  bool _ready = false;
  bool _permissionRequested = false;
  CustomerNotificationIntent? _pendingIntent;

  /// Monotonically increasing session generation. Bumped whenever
  /// authenticated ownership changes (login/restore, logout, dispose) so an
  /// in-flight registration from an older account can never write device
  /// state for the current one.
  int _sessionGeneration = 0;

  /// In-flight device registrations keyed by `<generation>:<token>`, so
  /// duplicate registrations for the SAME session+token are collapsed while
  /// an older account's registration never suppresses a newer one.
  final Map<String, Future<void>> _inFlightRegistrations = {};

  StreamSubscription<String>? _tokenRefreshSub;
  StreamSubscription<CustomerNotificationIntent?>? _messageSub;
  StreamSubscription<CustomerNotificationIntent?>? _openedSub;

  /// Initializes Firebase and subscribes to messaging streams. No-op when
  /// disabled. A failure leaves push disabled for this process with no retry
  /// loop; a future app launch retries naturally.
  Future<void> initialize() async {
    if (!enabled) return;
    if (_initialized) return;
    _initialized = true;
    final ready = await messaging.initialize();
    if (!ready) return;
    _ready = true;
    _tokenRefreshSub = messaging.onTokenRefresh.listen(
      (_) => _registerCurrentToken(),
    );
    _messageSub = messaging.onMessage.listen((intent) {
      if (intent != null) onForegroundMessage?.call(intent);
    });
    _openedSub = messaging.onMessageOpenedApp.listen((intent) {
      if (intent != null) _handleOpenedIntent(intent);
    });
  }

  /// Called after a customer logs in or a session is restored. Requests
  /// permission once, registers the current token, and resolves any pending
  /// tap intent. Never throws.
  Future<void> onAuthenticated() async {
    if (!enabled) return;
    _sessionGeneration++;
    await initialize();
    if (!_ready) return;
    await _requestPermissionOnce();
    await _registerCurrentToken();
    await _resolvePendingIntent();
  }

  /// Called during logout. Best-effort revokes the locally-known device
  /// BEFORE the session is destroyed, then clears the local record. A
  /// revocation failure never traps the user in the account.
  Future<void> onLogout({required String sessionToken}) async {
    if (!enabled) return;
    _sessionGeneration++;
    _inFlightRegistrations.clear();
    _pendingIntent = null;
    final deviceId = await deviceStore.read();
    if (deviceId != null && deviceId.isNotEmpty) {
      try {
        await deviceApi.revoke(deviceId: deviceId, sessionToken: sessionToken);
      } catch (_) {
        // Offline or a server error must not block logout.
      }
    }
    await deviceStore.clear();
  }

  /// Consumes the terminated-state message (if any) after the app is ready.
  Future<void> handleInitialMessage() async {
    if (!enabled) return;
    await initialize();
    if (!_ready) return;
    final intent = await messaging.getInitialMessage();
    if (intent != null) await _handleOpenedIntent(intent);
  }

  Future<bool> _hasSession() async {
    final token = await sessionTokenProvider();
    return token != null && token.isNotEmpty;
  }

  /// Requests the native permission at most once per app install.
  ///
  /// Android first: on Android 13+, the OS reports `denied` BOTH before the
  /// permission has ever been requested and after the user denied it, so the
  /// persisted "attempted" flag distinguishes a fresh install (prompt now)
  /// from an explicit denial (never re-prompt). `notDetermined` (iOS and some
  /// Android builds) is handled the same way: request once, then record it.
  ///
  /// Every outcome — authorized, provisional, denied, or an unavailable
  /// permission store — still lets token acquisition and device registration
  /// proceed; notification permission never gates the core lifecycle.
  Future<void> _requestPermissionOnce() async {
    if (_permissionRequested) return;
    _permissionRequested = true;
    try {
      final current = await messaging.currentPermission();
      if (current == CustomerNotificationPermission.authorized ||
          current == CustomerNotificationPermission.provisional) {
        // Already authorized (or provisional on iOS): no prompt needed.
        return;
      }
      if (await permissionRequestedStore.hasRequested()) {
        // Explicitly denied on a previous attempt: never re-prompt on
        // login/rebuild/session restore. Registration still proceeds.
        return;
      }
      // Fresh install (or flag cleared): show the native prompt once.
      await messaging.requestPermission();
      // Record the attempt even when the user denies, so the prompt is
      // never shown again for this app install.
      try {
        await permissionRequestedStore.markRequested();
      } catch (_) {
        // A persistence failure only risks one extra prompt later; it never
        // affects login or registration.
      }
    } catch (_) {
      // Permission is best-effort; denied must never break the app.
    }
  }

  Future<void> _registerCurrentToken() async {
    // Capture the session generation at entry so a response that returns
    // after an ownership change is recognised as stale and discarded.
    final generation = _sessionGeneration;
    if (!await _hasSession()) return;
    final token = await messaging.getToken();
    if (token == null || token.isEmpty) return;
    final sessionToken = await sessionTokenProvider();
    if (sessionToken == null || sessionToken.isEmpty) return;

    // Ownership may have changed while awaiting the token/session above.
    if (generation != _sessionGeneration) return;

    // Deduplicate concurrent registrations for the SAME session+token; a
    // different session (generation) or token registers independently.
    final key = '$generation:$token';
    final existing = _inFlightRegistrations[key];
    if (existing != null) {
      await existing;
      return;
    }

    final future = _register(
      generation: generation,
      token: token,
      sessionToken: sessionToken,
    );
    _inFlightRegistrations[key] = future;
    try {
      await future;
    } finally {
      _inFlightRegistrations.remove(key);
    }
  }

  Future<void> _register({
    required int generation,
    required String token,
    required String sessionToken,
  }) async {
    try {
      final device = await deviceApi.register(
        fcmToken: token,
        sessionToken: sessionToken,
      );
      // Persist the returned deviceId only if this exact session is still
      // current. A stale response from an older account/session is discarded
      // and must never write into secure storage.
      if (generation != _sessionGeneration) return;
      await deviceStore.write(device.deviceId);
    } catch (_) {
      // Best-effort and retried on the next auth activation or token refresh.
    }
  }

  Future<void> _handleOpenedIntent(CustomerNotificationIntent intent) async {
    if (await _hasSession()) {
      onOpenedIntent?.call(intent);
    } else {
      // Logged out: keep only the safe public-id intent in memory for after
      // the next login. It never contains sensitive data.
      _pendingIntent = intent;
    }
  }

  Future<void> _resolvePendingIntent() async {
    final intent = _pendingIntent;
    if (intent == null) return;
    if (!await _hasSession()) return;
    _pendingIntent = null;
    onOpenedIntent?.call(intent);
  }

  void dispose() {
    _sessionGeneration++;
    _inFlightRegistrations.clear();
    _tokenRefreshSub?.cancel();
    _messageSub?.cancel();
    _openedSub?.cancel();
  }
}
