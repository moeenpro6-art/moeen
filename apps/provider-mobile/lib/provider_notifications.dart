import 'dart:async';
import 'dart:convert';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

/// Optional provider-app push notifications (FCM-4).
///
/// The feature is deliberately fail-open: Firebase setup, notification
/// permission, token acquisition, and backend registration are never allowed
/// to interrupt authentication or the provider's operational workflows.
abstract final class ProviderFcmConfig {
  static const bool enabled = bool.fromEnvironment('MOEEN_FCM_ENABLED');
}

/// The provider client accepts only the FCM-2 payload version currently emitted
/// by the backend.
const int providerNotificationPayloadVersion = 1;

/// Exact provider notification events emitted by the FCM-2 template matrix.
enum ProviderNotificationType {
  opportunityInvited,
  providerAssigned,
  opportunityClosed,
}

/// Existing provider dashboard targets supported by the FCM-2 template matrix.
enum ProviderNotificationNavigate { opportunity, job, dashboard }

/// A parsed, privacy-safe navigation hint. It carries only the five approved
/// transport fields and has no fields capable of retaining service or identity
/// information from the push payload.
class ProviderNotificationIntent {
  const ProviderNotificationIntent({
    required this.type,
    required this.requestId,
    required this.navigate,
    required this.eventId,
    required this.version,
  });

  final ProviderNotificationType type;
  final String requestId;
  final ProviderNotificationNavigate navigate;
  final String eventId;
  final int version;
}

ProviderNotificationType? providerNotificationTypeFromWire(Object? value) =>
    switch (value) {
      'opportunity_invited' => ProviderNotificationType.opportunityInvited,
      'provider_assigned' => ProviderNotificationType.providerAssigned,
      'opportunity_closed' => ProviderNotificationType.opportunityClosed,
      _ => null,
    };

ProviderNotificationNavigate? providerNavigateFromWire(Object? value) =>
    switch (value) {
      'provider_opportunity' => ProviderNotificationNavigate.opportunity,
      'provider_job' => ProviderNotificationNavigate.job,
      'provider_dashboard' => ProviderNotificationNavigate.dashboard,
      _ => null,
    };

bool _isExpectedTarget(
  ProviderNotificationType type,
  ProviderNotificationNavigate navigate,
) => switch (type) {
  ProviderNotificationType.opportunityInvited =>
    navigate == ProviderNotificationNavigate.opportunity,
  ProviderNotificationType.providerAssigned =>
    navigate == ProviderNotificationNavigate.job,
  ProviderNotificationType.opportunityClosed =>
    navigate == ProviderNotificationNavigate.dashboard,
};

/// Validates only the approved provider FCM data contract. Unknown, malformed,
/// customer-only, and target-mismatched payloads are ignored safely. Transport
/// extras are deliberately not read or retained.
ProviderNotificationIntent? parseProviderNotificationIntent(
  Map<String, dynamic> data,
) {
  final type = providerNotificationTypeFromWire(data['type']);
  if (type == null) return null;

  final requestId = data['requestId'];
  if (requestId is! String || !RegExp(r'^MOE-\d+$').hasMatch(requestId)) {
    return null;
  }

  final navigate = providerNavigateFromWire(data['navigate']);
  if (navigate == null || !_isExpectedTarget(type, navigate)) return null;

  final eventId = data['eventId'];
  if (eventId is! String || eventId.isEmpty) return null;

  // FCM serializes the backend's numeric payload version as the string "1".
  if (data['v'] != '1') return null;

  return ProviderNotificationIntent(
    type: type,
    requestId: requestId,
    navigate: navigate,
    eventId: eventId,
    version: providerNotificationPayloadVersion,
  );
}

/// Short foreground copy that interpolates only the existing public request id.
String providerNotificationSummary(ProviderNotificationIntent intent) =>
    switch (intent.type) {
      ProviderNotificationType.opportunityInvited =>
        'فرصة عمل جديدة متاحة لك: ${intent.requestId}',
      ProviderNotificationType.providerAssigned =>
        'تم إسناد الطلب ${intent.requestId} إليك',
      ProviderNotificationType.opportunityClosed =>
        'تم إغلاق فرصة الطلب ${intent.requestId}',
    };

enum ProviderNotificationPermission {
  authorized,
  provisional,
  denied,
  notDetermined,
}

/// Firebase boundary used by the production adapter and in-memory test fakes.
abstract interface class ProviderMessagingClient {
  Future<bool> initialize();

  Future<ProviderNotificationPermission> currentPermission();

  Future<ProviderNotificationPermission> requestPermission();

  Future<String?> getToken();

  Stream<String> get onTokenRefresh;

  Stream<ProviderNotificationIntent?> get onMessage;

  Stream<ProviderNotificationIntent?> get onMessageOpenedApp;

  Future<ProviderNotificationIntent?> getInitialMessage();
}

/// Production Firebase adapter. Public methods return safe defaults if Firebase
/// is not configured or the platform integration fails, so disabled/unconfigured
/// builds retain all ordinary provider behavior.
class FirebaseProviderMessagingClient implements ProviderMessagingClient {
  FirebaseMessaging? _messaging;

  @override
  Future<bool> initialize() async {
    if (_messaging != null) return true;
    try {
      await Firebase.initializeApp();
      final messaging = FirebaseMessaging.instance;
      // Foreground messages are surfaced by the app's small Material SnackBar,
      // rather than duplicating them as system notifications.
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

  ProviderNotificationPermission _map(AuthorizationStatus status) =>
      switch (status) {
        AuthorizationStatus.authorized =>
          ProviderNotificationPermission.authorized,
        AuthorizationStatus.provisional =>
          ProviderNotificationPermission.provisional,
        AuthorizationStatus.denied => ProviderNotificationPermission.denied,
        AuthorizationStatus.notDetermined =>
          ProviderNotificationPermission.notDetermined,
      };

  @override
  Future<ProviderNotificationPermission> currentPermission() async {
    final messaging = _messaging;
    if (messaging == null) return ProviderNotificationPermission.denied;
    try {
      return _map(
        (await messaging.getNotificationSettings()).authorizationStatus,
      );
    } catch (_) {
      return ProviderNotificationPermission.denied;
    }
  }

  @override
  Future<ProviderNotificationPermission> requestPermission() async {
    final messaging = _messaging;
    if (messaging == null) return ProviderNotificationPermission.denied;
    try {
      return _map((await messaging.requestPermission()).authorizationStatus);
    } catch (_) {
      return ProviderNotificationPermission.denied;
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
    return messaging == null
        ? const Stream<String>.empty()
        : messaging.onTokenRefresh;
  }

  @override
  Stream<ProviderNotificationIntent?> get onMessage {
    final messaging = _messaging;
    if (messaging == null) {
      return const Stream<ProviderNotificationIntent?>.empty();
    }
    return FirebaseMessaging.onMessage.map(
      (message) => parseProviderNotificationIntent(message.data),
    );
  }

  @override
  Stream<ProviderNotificationIntent?> get onMessageOpenedApp {
    final messaging = _messaging;
    if (messaging == null) {
      return const Stream<ProviderNotificationIntent?>.empty();
    }
    return FirebaseMessaging.onMessageOpenedApp.map(
      (message) => parseProviderNotificationIntent(message.data),
    );
  }

  @override
  Future<ProviderNotificationIntent?> getInitialMessage() async {
    final messaging = _messaging;
    if (messaging == null) return null;
    try {
      final message = await messaging.getInitialMessage();
      return message == null
          ? null
          : parseProviderNotificationIntent(message.data);
    } catch (_) {
      return null;
    }
  }
}

/// Backend-issued safe device identity. Raw FCM tokens are never stored or
/// exposed after registration.
class RegisteredProviderDevice {
  const RegisteredProviderDevice({required this.deviceId});

  final String deviceId;

  factory RegisteredProviderDevice.fromJson(Map<String, dynamic> json) =>
      RegisteredProviderDevice(deviceId: json['deviceId'] as String);
}

abstract interface class ProviderDeviceApi {
  Future<RegisteredProviderDevice> register({
    required String fcmToken,
    required String sessionToken,
  });

  Future<void> revoke({required String deviceId, required String sessionToken});
}

class ProviderDeviceApiException implements Exception {
  const ProviderDeviceApiException(this.statusCode);

  final int statusCode;
}

/// HTTP implementation of the authenticated provider device contract. Identity
/// comes solely from the bearer token; the JSON body intentionally contains no
/// provider id or other account identity.
class HttpProviderDeviceApi implements ProviderDeviceApi {
  HttpProviderDeviceApi({
    required this._endpoint,
    http.Client? client,
    this.platform = 'android',
  }) : _client = client ?? http.Client();

  static const _timeout = Duration(seconds: 10);

  final Uri Function(String path) _endpoint;
  final http.Client _client;
  final String platform;

  @override
  Future<RegisteredProviderDevice> register({
    required String fcmToken,
    required String sessionToken,
  }) async {
    final response = await _client
        .post(
          _endpoint('/provider/devices'),
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer $sessionToken',
          },
          body: jsonEncode({'token': fcmToken, 'platform': platform}),
        )
        .timeout(_timeout);
    if (response.statusCode != 201) {
      throw ProviderDeviceApiException(response.statusCode);
    }
    final body = jsonDecode(response.body);
    if (body is! Map<dynamic, dynamic>) {
      throw ProviderDeviceApiException(response.statusCode);
    }
    try {
      return RegisteredProviderDevice.fromJson(Map<String, dynamic>.from(body));
    } catch (_) {
      throw ProviderDeviceApiException(response.statusCode);
    }
  }

  @override
  Future<void> revoke({
    required String deviceId,
    required String sessionToken,
  }) async {
    final response = await _client
        .delete(
          _endpoint('/provider/devices/${Uri.encodeComponent(deviceId)}'),
          headers: {'Authorization': 'Bearer $sessionToken'},
        )
        .timeout(_timeout);
    if (response.statusCode != 200) {
      throw ProviderDeviceApiException(response.statusCode);
    }
  }
}

/// Persists the safe backend-issued device id only.
abstract interface class ProviderDeviceIdStore {
  Future<String?> read();

  Future<void> write(String deviceId);

  Future<void> clear();
}

/// Local record of whether this app has already attempted to request the
/// notification permission (Android-first, app-level).
///
/// On Android 13+, `firebase_messaging` reports `denied` both when the
/// permission has never been requested and after an explicit denial, so the
/// persisted "attempted" flag is the only way to (a) show the native first
/// prompt on a fresh install and (b) never nag a provider who already denied.
///
/// Only a boolean is stored — never the FCM token, provider ids, request
/// data, or secrets. Logout does not reset it (the permission belongs to the
/// app, not the account); wiping app data / reinstalling does reset it.
abstract interface class ProviderPermissionRequestedStore {
  /// Whether the app has previously attempted the native permission request.
  Future<bool> hasRequested();

  /// Persists that the native permission request has now been attempted.
  Future<void> markRequested();
}

class SecureProviderDeviceIdStore implements ProviderDeviceIdStore {
  SecureProviderDeviceIdStore({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  static const _key = 'moeen_provider_fcm_device_id';
  final FlutterSecureStorage _storage;

  @override
  Future<String?> read() => _storage.read(key: _key);

  @override
  Future<void> write(String deviceId) =>
      _storage.write(key: _key, value: deviceId);

  @override
  Future<void> clear() => _storage.delete(key: _key);
}

/// Owns optional Firebase setup, permission, token registration/refresh,
/// revocation, and authentication-gated navigation. All public lifecycle
/// methods swallow optional-push failures so callers can safely invoke them in
/// login, restore, logout, and app-start paths.
class ProviderNotificationController {
  ProviderNotificationController({
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
  final ProviderMessagingClient messaging;
  final ProviderDeviceApi deviceApi;
  final ProviderDeviceIdStore deviceStore;

  /// Persistent record of whether the native permission prompt has been
  /// attempted on this Android device. App-level, never account-level, so it
  /// survives logout and is cleared only by wiping app data / reinstalling.
  final ProviderPermissionRequestedStore permissionRequestedStore;

  /// The current authenticated provider session, or null while logged out.
  final Future<String?> Function() sessionTokenProvider;

  /// UI callback for a valid foreground message. It receives only safe intent
  /// data and must fetch current API data before acting on it.
  final void Function(ProviderNotificationIntent intent)? onForegroundMessage;

  /// Async UI callback for a valid tap after authentication is ready.
  final Future<void> Function(ProviderNotificationIntent intent)?
  onOpenedIntent;

  Future<void>? _initializing;
  bool _ready = false;
  bool _permissionRequested = false;
  bool _initialMessageHandled = false;
  ProviderNotificationIntent? _pendingIntent;

  /// Incremented whenever session ownership can change. Every async register
  /// captures this generation so stale account responses cannot write storage.
  int _sessionGeneration = 0;

  /// In-flight registrations deduplicate only an identical token in an
  /// identical session. A new generation is always independent.
  final Map<String, Future<void>> _inFlightRegistrations = {};

  StreamSubscription<String>? _tokenRefreshSub;
  StreamSubscription<ProviderNotificationIntent?>? _messageSub;
  StreamSubscription<ProviderNotificationIntent?>? _openedSub;

  /// Initializes Firebase and creates the three bounded stream subscriptions.
  /// Concurrent callers share the same initialization future rather than racing
  /// a terminated-message read with Firebase startup.
  Future<void> initialize() {
    if (!enabled) return Future<void>.value();
    final current = _initializing;
    if (current != null) return current;
    final future = _initialize();
    _initializing = future;
    return future;
  }

  Future<void> _initialize() async {
    final ready = await messaging.initialize();
    if (!ready) return;
    _ready = true;
    _tokenRefreshSub = messaging.onTokenRefresh.listen(
      (token) => unawaited(_registerCurrentToken(tokenOverride: token)),
    );
    _messageSub = messaging.onMessage.listen((intent) {
      if (intent != null) onForegroundMessage?.call(intent);
    });
    _openedSub = messaging.onMessageOpenedApp.listen((intent) {
      if (intent != null) unawaited(_handleOpenedIntent(intent));
    });
  }

  /// Called after a provider session is fully restored or a new access-code
  /// login has loaded the authenticated dashboard. It never throws into login.
  Future<void> onAuthenticated() async {
    if (!enabled) return;
    final generation = ++_sessionGeneration;
    await initialize();
    if (!_ready || generation != _sessionGeneration) return;
    await _requestPermissionOnce();
    if (generation != _sessionGeneration) return;
    await _registerCurrentToken();
    if (generation != _sessionGeneration) return;
    await _resolvePendingIntent(generation);
  }

  /// Invalidates the provider session before attempting best-effort revocation.
  /// The local id is always cleared while the passed bearer token is still
  /// available; any revoke failure is deliberately ignored.
  Future<void> onLogout({required String sessionToken}) async {
    if (!enabled) return;
    final generation = ++_sessionGeneration;
    _inFlightRegistrations.clear();
    _pendingIntent = null;

    final deviceId = await deviceStore.read();
    if (generation != _sessionGeneration) return;
    if (deviceId != null && deviceId.isNotEmpty) {
      try {
        await deviceApi.revoke(deviceId: deviceId, sessionToken: sessionToken);
      } catch (_) {
        // Logout remains available offline and after server-side failures.
      }
    }
    if (generation != _sessionGeneration) return;
    try {
      await deviceStore.clear();
    } catch (_) {
      // Secure-storage failure must not block core logout.
    }
  }

  /// Clears local notification ownership after an authentication expiry, where
  /// a usable bearer token may no longer exist for backend revocation.
  Future<void> onSessionInvalidated() async {
    if (!enabled) return;
    final generation = ++_sessionGeneration;
    _inFlightRegistrations.clear();
    _pendingIntent = null;
    try {
      await deviceStore.clear();
    } catch (_) {
      // Optional local cleanup.
    }
    if (generation != _sessionGeneration) return;
  }

  /// Reads the terminated-app notification once. A logged-out app keeps only a
  /// safe in-memory hint until a real provider session is established.
  Future<void> handleInitialMessage() async {
    if (!enabled || _initialMessageHandled) return;
    _initialMessageHandled = true;
    await initialize();
    if (!_ready) return;
    final intent = await messaging.getInitialMessage();
    if (intent != null) await _handleOpenedIntent(intent);
  }

  /// Requests the native permission at most once per app install.
  ///
  /// Android first: on Android 13+, the OS reports `denied` BOTH before the
  /// permission has ever been requested and after the user denied it, so the
  /// persisted "attempted" flag distinguishes a fresh install (prompt now)
  /// from an explicit denial (never re-prompt). `notDetermined` (iOS and some
  /// Android builds) is handled the same way: request once, then record it.
  ///
  /// Every outcome — authorized, provisional, or denied — still lets token
  /// acquisition and device registration proceed; notification permission
  /// never gates login or operational flows.
  Future<void> _requestPermissionOnce() async {
    if (_permissionRequested) return;
    _permissionRequested = true;
    try {
      final current = await messaging.currentPermission();
      if (current == ProviderNotificationPermission.authorized ||
          current == ProviderNotificationPermission.provisional) {
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
      // Permission rejection must not affect device registration or app use.
    }
  }

  Future<bool> _hasSession() async {
    final token = await sessionTokenProvider();
    return token != null && token.isNotEmpty;
  }

  Future<void> _registerCurrentToken({String? tokenOverride}) async {
    final generation = _sessionGeneration;
    if (!await _hasSession()) return;
    final fcmToken = tokenOverride ?? await messaging.getToken();
    if (fcmToken == null || fcmToken.isEmpty) return;
    final sessionToken = await sessionTokenProvider();
    if (sessionToken == null || sessionToken.isEmpty) return;

    // Session ownership can change while token/session lookups await.
    if (generation != _sessionGeneration) return;

    final key = '$generation:$fcmToken';
    final existing = _inFlightRegistrations[key];
    if (existing != null) {
      await existing;
      return;
    }

    final future = _register(
      generation: generation,
      fcmToken: fcmToken,
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
    required String fcmToken,
    required String sessionToken,
  }) async {
    try {
      final device = await deviceApi.register(
        fcmToken: fcmToken,
        sessionToken: sessionToken,
      );
      // The response is safe to persist only for its exact original owner.
      if (generation != _sessionGeneration) return;
      await deviceStore.write(device.deviceId);
    } catch (_) {
      // A later authentication activation or FCM refresh can retry naturally;
      // there is intentionally no automatic retry loop.
    }
  }

  Future<void> _handleOpenedIntent(ProviderNotificationIntent intent) async {
    final generation = _sessionGeneration;
    if (await _hasSession()) {
      if (generation != _sessionGeneration) return;
      await onOpenedIntent?.call(intent);
      return;
    }
    // Do not carry an intent across a session ownership change. A tap received
    // while genuinely logged out is retained only until the next login.
    if (generation == _sessionGeneration) _pendingIntent = intent;
  }

  Future<void> _resolvePendingIntent(int generation) async {
    final intent = _pendingIntent;
    if (intent == null || generation != _sessionGeneration) return;
    if (!await _hasSession() || generation != _sessionGeneration) return;
    _pendingIntent = null;
    await onOpenedIntent?.call(intent);
  }

  void dispose() {
    _sessionGeneration++;
    _inFlightRegistrations.clear();
    _tokenRefreshSub?.cancel();
    _messageSub?.cancel();
    _openedSub?.cancel();
  }
}
