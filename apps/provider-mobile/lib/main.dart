import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import 'request_images.dart';
import 'moeen_ui.dart';
import 'provider_notifications.dart';

const _providerTokenStorageKey = 'moeen_provider_session_token';
const _serviceNames = {
  'ac-cleaning': 'تنظيف المكيفات',
  'upholstery': 'غسيل الكنب والمجالس',
  'home-cleaning': 'تنظيف المنازل',
  'tank-cleaning': 'تنظيف الخزانات',
  'plumbing': 'سباكة وتسربات',
};
const _statusLabels = {
  'assigned': 'تم التعيين',
  'on_the_way': 'في الطريق',
  'in_progress': 'قيد التنفيذ',
  'completed': 'مكتمل',
};

const _timingLabels = {
  'as-soon-as-possible': 'في أقرب وقت',
  'scheduled': 'موعد محدد',
};

const _opportunityStatusLabels = {
  'invited': 'مدعو',
  'quoted': 'بانتظار قرار العميل',
  'withdrawn': 'عرضك مسحوب',
  'closed': 'مغلقة',
  'rejected': 'تم رفض عرضك',
};

String opportunityMessage(ProviderOpportunity opp) {
  if (opp.opportunityStatus == 'rejected') {
    return 'تم رفض عرضك';
  }
  if (opp.opportunityStatus == 'closed' &&
      opp.myQuote != null &&
      opp.myQuote!.status != 'approved') {
    return 'تم إغلاق الفرصة بعد اختيار عرض آخر';
  }
  return _opportunityStatusLabels[opp.opportunityStatus] ??
      opp.opportunityStatus;
}

void main() {
  runApp(MoeenProviderApp());
}

class ProviderApiConfigurationException implements Exception {
  const ProviderApiConfigurationException();
}

class ProviderApiException implements Exception {
  const ProviderApiException();
}

class ProviderUnauthorizedException implements Exception {
  const ProviderUnauthorizedException();
}

class ProviderApiConfig {
  const ProviderApiConfig(this.baseUrl);

  final String baseUrl;

  Uri endpoint(String path) {
    final normalizedBase = baseUrl.trim().replaceFirst(RegExp(r'/$'), '');
    final parsed = Uri.tryParse(normalizedBase);
    if (parsed == null ||
        !(parsed.scheme == 'http' || parsed.scheme == 'https') ||
        parsed.host.isEmpty ||
        !path.startsWith('/')) {
      throw const ProviderApiConfigurationException();
    }
    return Uri.parse('$normalizedBase$path');
  }
}

class ProviderQuote {
  const ProviderQuote({
    required this.id,
    required this.amountHalalas,
    required this.scope,
    required this.status,
  });

  final String id;
  final int amountHalalas;
  final String scope;
  final String status;

  factory ProviderQuote.fromJson(Map<String, dynamic> json) {
    return ProviderQuote(
      id: json['id'] as String,
      amountHalalas: (json['amountHalalas'] as num).toInt(),
      scope: json['scope'] as String,
      status: json['status'] as String,
    );
  }
}

class ProviderJob {
  const ProviderJob({
    required this.id,
    required this.serviceId,
    required this.address,
    required this.details,
    required this.timing,
    required this.status,
    this.quote,
    this.customerPhone,
  });

  final String id;
  final String serviceId;
  final String address;
  final String? details;
  final String timing;
  final String status;
  final ProviderQuote? quote;

  /// Post-assignment customer contact number. Present ONLY when the API
  /// returns it for the authenticated assigned provider in an active
  /// lifecycle state; never synthesized or defaulted on the client.
  final String? customerPhone;

  factory ProviderJob.fromJson(Map<String, dynamic> json) {
    final quote = json['quote'];
    return ProviderJob(
      id: json['id'] as String,
      serviceId: json['serviceId'] as String,
      address: json['address'] as String,
      details: json['details'] as String?,
      timing: json['timing'] as String,
      status: json['status'] as String,
      quote: quote is Map<String, dynamic>
          ? ProviderQuote.fromJson(quote)
          : null,
      customerPhone: json['customerPhone'] as String?,
    );
  }
}

class ProviderOpportunity {
  const ProviderOpportunity({
    required this.requestId,
    required this.serviceId,
    required this.timing,
    required this.opportunityStatus,
    this.myQuote,
    this.address,
    this.details,
    this.images = const [],
  });

  final String requestId;
  final String serviceId;
  final String timing;
  final String opportunityStatus;
  final ProviderQuote? myQuote;

  /// Pre-quote fields the API includes ONLY while this provider owns the
  /// opportunity and it is eligible/current (`invited`/`quoted` with the
  /// request still pending dispatch). Terminal or ineligible opportunities
  /// never carry them, and customer identity/contact data is never part of
  /// the opportunity shape at all.
  final String? address;
  final String? details;
  final List<ProviderRequestImage> images;

  factory ProviderOpportunity.fromJson(Map<String, dynamic> json) {
    final quote = json['myQuote'];
    return ProviderOpportunity(
      requestId: json['requestId'] as String,
      serviceId: json['serviceId'] as String,
      timing: json['timing'] as String,
      opportunityStatus: json['opportunityStatus'] as String,
      myQuote: quote is Map<String, dynamic>
          ? ProviderQuote.fromJson(quote)
          : null,
      address: json['address'] as String?,
      details: json['details'] as String?,
      images: ProviderRequestImage.listFromJson(json['images']),
    );
  }
}

class ProviderProfile {
  const ProviderProfile({
    required this.id,
    required this.name,
    required this.specialties,
    required this.serviceZone,
    required this.available,
  });

  final String id;
  final String name;
  final List<String> specialties;
  final String serviceZone;
  final bool available;

  factory ProviderProfile.fromJson(Map<String, dynamic> json) {
    return ProviderProfile(
      id: json['id'] as String,
      name: json['name'] as String,
      specialties: (json['specialties'] as List<dynamic>).cast<String>(),
      serviceZone: json['serviceZone'] as String,
      available: json['available'] as bool,
    );
  }
}

class ProviderLoginResult {
  const ProviderLoginResult({required this.provider, required this.token});

  final ProviderProfile provider;
  final String token;
}

String? nextProviderStatus(ProviderJob job) {
  if (job.status == 'assigned') return 'on_the_way';
  if (job.status == 'on_the_way') {
    if (job.quote != null && job.quote!.status != 'approved') return null;
    return 'in_progress';
  }
  if (job.status == 'in_progress') return 'completed';
  return null;
}

String providerActionLabel(ProviderJob job) {
  final nextStatus = nextProviderStatus(job);
  if (nextStatus == 'on_the_way') return 'تأكيد الانطلاق';
  if (nextStatus == 'in_progress') return 'بدء الخدمة';
  if (nextStatus == 'completed') return 'إنهاء الخدمة';
  if (job.status == 'on_the_way' && job.quote != null) {
    return job.quote!.status == 'rejected'
        ? 'أرسل التشغيل عرضًا بديلًا'
        : 'بانتظار قرار العميل على عرض السعر';
  }
  return 'لا يوجد إجراء متاح';
}

class ProviderApi {
  ProviderApi({http.Client? client, String? baseUrl})
    : _client = client ?? http.Client(),
      _config = ProviderApiConfig(baseUrl ?? _defaultBaseUrl);

  static const _defaultBaseUrl = String.fromEnvironment('MOEEN_API_BASE_URL');

  final http.Client _client;
  final ProviderApiConfig _config;

  Future<ProviderLoginResult> login(String accessCode) async {
    final response = await _client.post(
      _config.endpoint('/provider/auth/login'),
      headers: const {'Content-Type': 'application/json'},
      body: jsonEncode({'accessCode': accessCode}),
    );
    final body = _responseObject(response);
    return ProviderLoginResult(
      provider: ProviderProfile.fromJson(
        Map<String, dynamic>.from(body['provider'] as Map<dynamic, dynamic>),
      ),
      token: body['token'] as String,
    );
  }

  Future<ProviderProfile> currentProvider(String token) async {
    final response = await _client.get(
      _config.endpoint('/provider/auth/me'),
      headers: _authorization(token),
    );
    return ProviderProfile.fromJson(_responseObject(response));
  }

  Future<List<ProviderJob>> jobs(String token) async {
    final response = await _client.get(
      _config.endpoint('/provider/service-requests'),
      headers: _authorization(token),
    );
    if (response.statusCode == 401) {
      throw const ProviderUnauthorizedException();
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw const ProviderApiException();
    }
    final body = jsonDecode(response.body);
    if (body is! List<dynamic>) throw const ProviderApiException();
    return body
        .whereType<Map<dynamic, dynamic>>()
        .map((job) => ProviderJob.fromJson(Map<String, dynamic>.from(job)))
        .toList();
  }

  Future<List<ProviderOpportunity>> opportunities(String token) async {
    final response = await _client.get(
      _config.endpoint('/provider/opportunities'),
      headers: _authorization(token),
    );
    if (response.statusCode == 401) {
      throw const ProviderUnauthorizedException();
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw const ProviderApiException();
    }
    final body = jsonDecode(response.body);
    if (body is! List<dynamic>) throw const ProviderApiException();
    return body
        .whereType<Map<dynamic, dynamic>>()
        .map(
          (item) =>
              ProviderOpportunity.fromJson(Map<String, dynamic>.from(item)),
        )
        .toList();
  }

  Future<ProviderQuote> submitQuote(
    String token,
    String requestId,
    int amountHalalas,
    String scope,
  ) async {
    final response = await _client.post(
      _config.endpoint('/provider/opportunities/$requestId/quotes'),
      headers: _authorization(token, json: true),
      body: jsonEncode({'amountHalalas': amountHalalas, 'scope': scope}),
    );
    return ProviderQuote.fromJson(_responseObject(response));
  }

  Future<ProviderJob> updateJobStatus(
    String token,
    String requestId,
    String status,
  ) async {
    final response = await _client.patch(
      _config.endpoint('/provider/service-requests/$requestId/status'),
      headers: _authorization(token, json: true),
      body: jsonEncode({'status': status}),
    );
    return ProviderJob.fromJson(_responseObject(response));
  }

  Future<ProviderProfile> updateAvailability(
    String token,
    bool available,
  ) async {
    final response = await _client.patch(
      _config.endpoint('/provider/availability'),
      headers: _authorization(token, json: true),
      body: jsonEncode({'available': available}),
    );
    return ProviderProfile.fromJson(_responseObject(response));
  }

  Future<void> logout(String token) async {
    final response = await _client.post(
      _config.endpoint('/provider/auth/logout'),
      headers: _authorization(token),
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw const ProviderApiException();
    }
  }

  Map<String, String> _authorization(String token, {bool json = false}) => {
    'Authorization': 'Bearer $token',
    if (json) 'Content-Type': 'application/json',
  };

  Map<String, dynamic> _responseObject(http.Response response) {
    if (response.statusCode == 401) {
      throw const ProviderUnauthorizedException();
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw const ProviderApiException();
    }
    final decoded = jsonDecode(response.body);
    if (decoded is! Map<dynamic, dynamic>) throw const ProviderApiException();
    return Map<String, dynamic>.from(decoded);
  }
}

abstract class ProviderSessionStore {
  Future<String?> readToken();
  Future<void> writeToken(String token);
  Future<void> clearToken();
}

class SecureProviderSessionStore implements ProviderSessionStore {
  SecureProviderSessionStore({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  @override
  Future<String?> readToken() => _storage.read(key: _providerTokenStorageKey);

  @override
  Future<void> writeToken(String token) =>
      _storage.write(key: _providerTokenStorageKey, value: token);

  @override
  Future<void> clearToken() => _storage.delete(key: _providerTokenStorageKey);
}

/// Stores requestIds the provider chose to hide from their own opportunity
/// list on this device only. Keyed per provider account so a different
/// provider on the same device never sees another account's hidden list.
abstract class HiddenOpportunitiesStore {
  Future<Set<String>> readHidden(String providerId);
  Future<void> hideRequest(String providerId, String requestId);
}

class SecureHiddenOpportunitiesStore implements HiddenOpportunitiesStore {
  SecureHiddenOpportunitiesStore({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  String _keyFor(String providerId) =>
      'moeen_provider_hidden_opportunities_$providerId';

  @override
  Future<Set<String>> readHidden(String providerId) async {
    final raw = await _storage.read(key: _keyFor(providerId));
    if (raw == null || raw.isEmpty) return {};
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! List) return {};
      return decoded.whereType<String>().toSet();
    } catch (_) {
      return {};
    }
  }

  @override
  Future<void> hideRequest(String providerId, String requestId) async {
    final hidden = await readHidden(providerId);
    hidden.add(requestId);
    await _storage.write(
      key: _keyFor(providerId),
      value: jsonEncode(hidden.toList()),
    );
  }
}

class MoeenProviderApp extends StatefulWidget {
  MoeenProviderApp({
    super.key,
    ProviderApi? api,
    ProviderSessionStore? sessionStore,
    HiddenOpportunitiesStore? hiddenStore,
  }) : _api = api ?? ProviderApi(),
       _sessionStore = sessionStore ?? SecureProviderSessionStore(),
       _hiddenStore = hiddenStore ?? SecureHiddenOpportunitiesStore();

  final ProviderApi _api;
  final ProviderSessionStore _sessionStore;
  final HiddenOpportunitiesStore _hiddenStore;

  @override
  State<MoeenProviderApp> createState() => _MoeenProviderAppState();
}

class _MoeenProviderAppState extends State<MoeenProviderApp> {
  final _accessCodeController = TextEditingController();
  final _scaffoldMessengerKey = GlobalKey<ScaffoldMessengerState>();
  final Map<String, GlobalKey> _opportunityCardKeys = {};
  final Map<String, GlobalKey> _jobCardKeys = {};
  late final ProviderNotificationController _notifications;

  String? _token;
  ProviderProfile? _provider;
  List<ProviderJob> _jobs = const [];
  List<ProviderOpportunity> _opportunities = const [];
  Set<String> _hiddenRequestIds = {};
  bool _opportunitiesLoading = true;
  String? _opportunitiesError;
  bool _loading = true;
  bool _submitting = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _notifications = ProviderNotificationController(
      enabled: ProviderFcmConfig.enabled,
      messaging: FirebaseProviderMessagingClient(),
      deviceApi: HttpProviderDeviceApi(
        endpoint: (path) => widget._api._config.endpoint(path),
      ),
      deviceStore: SecureProviderDeviceIdStore(),
      sessionTokenProvider: () async => _token,
      onForegroundMessage: _showForegroundNotification,
      onOpenedIntent: _openNotificationIntent,
    );
    // Both calls are intentionally non-blocking. If Firebase is unconfigured,
    // the controller swallows that optional failure and the existing restore
    // flow continues unchanged.
    unawaited(_notifications.handleInitialMessage());
    _restoreSession();
  }

  @override
  void dispose() {
    _notifications.dispose();
    _accessCodeController.dispose();
    super.dispose();
  }

  Future<void> _restoreSession() async {
    try {
      final token = await widget._sessionStore.readToken();
      if (token == null) {
        if (mounted) setState(() => _loading = false);
        return;
      }
      await _loadDashboard(token);
      await _loadHiddenOpportunities();
      await _loadOpportunities();
      // Authentication and provider data are ready before a pending notification
      // tap may focus an existing opportunity or assigned-job card.
      unawaited(_notifications.onAuthenticated());
    } catch (_) {
      await _expireSession();
    }
  }

  Future<void> _loadHiddenOpportunities() async {
    final providerId = _provider?.id;
    if (providerId == null) return;
    try {
      final hidden = await widget._hiddenStore.readHidden(providerId);
      if (mounted) setState(() => _hiddenRequestIds = hidden);
    } catch (_) {
      // Best-effort local feature: a storage failure must not break the
      // session; the list simply starts empty.
    }
  }

  Future<void> _expireSession() async {
    // There may be no trustworthy bearer token left after an auth expiry, but
    // invalidate the FCM generation before clearing app state so a stale device
    // registration can never reappear for a later provider login.
    unawaited(_notifications.onSessionInvalidated());
    await widget._sessionStore.clearToken();

    if (mounted) {
      setState(() {
        _token = null;
        _provider = null;
        _jobs = const [];
        _opportunities = const [];
        _hiddenRequestIds = {};
        _opportunitiesLoading = true;
        _opportunitiesError = null;
        _loading = false;
        _error = null;
      });
    }
  }

  Future<void> _loadOpportunities() async {
    final token = _token;
    if (token == null) return;
    setState(() {
      _opportunitiesLoading = true;
      _opportunitiesError = null;
    });
    try {
      final opportunities = await widget._api.opportunities(token);
      if (!mounted) return;
      setState(() {
        _opportunities = opportunities
            .where(
              (opportunity) =>
                  !_hiddenRequestIds.contains(opportunity.requestId),
            )
            .toList();
        _opportunitiesLoading = false;
      });
    } on ProviderUnauthorizedException {
      await _expireSession();
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _opportunitiesLoading = false;
        _opportunitiesError = 'تعذر تحميل الفرص. حاول مرة أخرى.';
      });
    }
  }

  /// Shows a lightweight foreground indication. The push payload itself never
  /// changes provider data; choosing the action re-fetches authenticated API
  /// state before the existing list UI is focused.
  void _showForegroundNotification(ProviderNotificationIntent intent) {
    if (!mounted || _provider == null) return;
    _scaffoldMessengerKey.currentState
      ?..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(providerNotificationSummary(intent)),
          action: SnackBarAction(
            label: 'فتح',
            onPressed: () => unawaited(_openNotificationIntent(intent)),
          ),
        ),
      );
  }

  /// Routes only through refreshed, already-authorized provider data. The public
  /// request id is a focus hint, never a credential or source of service data.
  Future<void> _openNotificationIntent(
    ProviderNotificationIntent intent,
  ) async {
    final token = _token;
    if (!mounted || token == null || _provider == null) return;
    try {
      switch (intent.navigate) {
        case ProviderNotificationNavigate.opportunity:
          await _loadOpportunities();
          _focusCard(_opportunityCardKeys[intent.requestId]);
          return;
        case ProviderNotificationNavigate.job:
          await _loadDashboard(token);
          _focusCard(_jobCardKeys[intent.requestId]);
          return;
        case ProviderNotificationNavigate.dashboard:
          await _refresh();
          return;
      }
    } on ProviderUnauthorizedException {
      await _expireSession();
    } catch (_) {
      // A stale/closed/ineligible request simply leaves the provider on the
      // refreshed dashboard. Push navigation must never create a new route or
      // surface unverified data.
    }
  }

  void _focusCard(GlobalKey? cardKey) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final cardContext = cardKey?.currentContext;
      if (cardContext != null) {
        Scrollable.ensureVisible(
          cardContext,
          duration: const Duration(milliseconds: 250),
          curve: Curves.easeOut,
          alignment: 0.18,
        );
      }
    });
  }

  Future<void> _openQuoteSheet(
    BuildContext sheetContext,
    ProviderOpportunity opportunity,
  ) async {
    final token = _token;
    if (token == null) return;
    final result = await showModalBottomSheet<Object>(
      context: sheetContext,
      isScrollControlled: true,
      builder: (_) => _QuoteSheet(
        api: widget._api,
        token: token,
        requestId: opportunity.requestId,
        serviceLabel:
            _serviceNames[opportunity.serviceId] ?? opportunity.serviceId,
      ),
    );
    if (result == 'unauthorized') {
      await _expireSession();
      return;
    }
    if (result == true) {
      await _loadOpportunities();
    }
  }

  Future<void> _loadDashboard(String token) async {
    final results = await Future.wait([
      widget._api.currentProvider(token),
      widget._api.jobs(token),
    ]);
    if (!mounted) return;
    setState(() {
      _token = token;
      _provider = results[0] as ProviderProfile;
      _jobs = results[1] as List<ProviderJob>;
      _loading = false;
      _error = null;
    });
  }

  Future<void> _login() async {
    final accessCode = _accessCodeController.text.trim();
    if (accessCode.length < 16) {
      setState(() => _error = 'أدخل رمز وصول صحيحًا من 16 حرفًا أو أكثر.');
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      final login = await widget._api.login(accessCode);
      await widget._sessionStore.writeToken(login.token);
      await _loadDashboard(login.token);
      await _loadHiddenOpportunities();
      await _loadOpportunities();
      // Device registration and notification permission are optional. They run
      // after login has succeeded and never decide its outcome.
      unawaited(_notifications.onAuthenticated());
    } on ProviderApiConfigurationException {
      if (mounted) {
        setState(() => _error = 'لم يتم ضبط رابط النظام لهذا الإصدار.');
      }
    } on ProviderUnauthorizedException {
      if (mounted) {
        setState(() => _error = 'رمز الوصول غير صحيح أو الحساب غير معتمد.');
      }
    } on ProviderApiException {
      if (mounted) {
        setState(() => _error = 'رمز الوصول غير صحيح أو الحساب غير معتمد.');
      }
    } catch (_) {
      if (mounted) {
        setState(
          () => _error = 'تعذر تسجيل الدخول. تحقق من الاتصال وحاول مرة أخرى.',
        );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _refresh() async {
    final token = _token;
    if (token == null) return;
    setState(() => _submitting = true);
    try {
      await Future.wait([_loadDashboard(token), _loadOpportunities()]);
    } on ProviderUnauthorizedException {
      await _expireSession();
    } catch (_) {
      if (mounted) setState(() => _error = 'تعذر تحديث الطلبات.');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _updateAvailability(bool available) async {
    final token = _token;
    if (token == null) return;
    setState(() => _submitting = true);
    try {
      final provider = await widget._api.updateAvailability(token, available);
      if (mounted) setState(() => _provider = provider);
    } on ProviderUnauthorizedException {
      await _expireSession();
    } catch (_) {
      if (mounted) setState(() => _error = 'تعذر تحديث حالة التوفر.');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _confirmAndAdvance(
    ProviderJob job,
    BuildContext sheetContext,
  ) async {
    final nextStatus = nextProviderStatus(job);
    if (nextStatus == null) return;
    final action = providerActionLabel(job);
    final explanation = switch (nextStatus) {
      'on_the_way' =>
        'سيتم إبلاغ العميل بأنك في الطريق. تأكد من استعدادك للمغادرة.',
      'in_progress' =>
        'سيتم تحديث حالة الطلب إلى قيد التنفيذ. ابدأ الخدمة بعد وصولك للموقع.',
      'completed' =>
        'سيتم إبلاغ العميل باكتمال الخدمة. تأكد من إنهاء العمل المتفق عليه قبل المتابعة.',
      _ => 'سيتم تحديث حالة المهمة.',
    };

    // The sheet must be shown from a context inside the MaterialApp /
    // Navigator subtree. `this.context` is the MoeenProviderApp element,
    // which sits ABOVE the MaterialApp returned by build(), so it has no
    // MaterialLocalizations. The caller therefore passes the transition
    // button's Builder context (same pattern as _openQuoteSheet).
    final confirmed = await showModalBottomSheet<bool>(
      context: sheetContext,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (bottomSheetContext) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                action,
                style: Theme.of(bottomSheetContext).textTheme.titleLarge
                    ?.copyWith(
                      color: MoeenColors.primaryDark,
                      fontWeight: FontWeight.w800,
                    ),
              ),
              const SizedBox(height: MoeenSpacing.sm),
              Text(
                explanation,
                style: Theme.of(bottomSheetContext).textTheme.bodyLarge
                    ?.copyWith(color: MoeenColors.mutedText, height: 1.45),
              ),
              const SizedBox(height: MoeenSpacing.lg),
              FilledButton(
                onPressed: () => Navigator.of(bottomSheetContext).pop(true),
                child: Text('تأكيد: $action'),
              ),
              const SizedBox(height: MoeenSpacing.sm),
              OutlinedButton(
                onPressed: () => Navigator.of(bottomSheetContext).pop(false),
                child: const Text('رجوع'),
              ),
            ],
          ),
        ),
      ),
    );
    if (confirmed == true && mounted) await _advance(job);
  }

  Future<void> _advance(ProviderJob job) async {
    final token = _token;
    final status = nextProviderStatus(job);
    if (token == null || status == null) return;
    setState(() => _submitting = true);
    try {
      await widget._api.updateJobStatus(token, job.id, status);
      await _loadDashboard(token);
    } on ProviderUnauthorizedException {
      await _expireSession();
    } on ProviderApiException {
      if (mounted) {
        setState(
          () => _error =
              'تعذر تحديث المهمة. تحقق من موافقة العميل والحالة الحالية.',
        );
      }
    } catch (_) {
      if (mounted) setState(() => _error = 'تعذر تحديث المهمة. حاول مرة أخرى.');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _logout() async {
    final token = _token;
    if (token != null) {
      // Starts by invalidating notification ownership and attempts the device
      // revoke while this provider bearer token is still usable. It is detached
      // so an offline notification endpoint can never trap the provider in the
      // logout UI.
      unawaited(_notifications.onLogout(sessionToken: token));
      try {
        await widget._api.logout(token);
      } catch (_) {}
    }
    await widget._sessionStore.clearToken();

    if (mounted) {
      setState(() {
        _token = null;
        _provider = null;
        _jobs = const [];
        _error = null;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      scaffoldMessengerKey: _scaffoldMessengerKey,
      title: 'معين للمحترفين',

      theme: MoeenTheme.light(),
      home: Directionality(
        textDirection: TextDirection.rtl,
        child: _loading
            ? const Scaffold(body: Center(child: CircularProgressIndicator()))
            : _provider == null
            ? _buildLogin()
            : _buildDashboard(),
      ),
    );
  }

  Widget _buildLogin() {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Card(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      const Text(
                        'معين',
                        style: TextStyle(
                          fontSize: 32,
                          fontWeight: FontWeight.bold,
                          color: Color(0xFF0B6E69),
                        ),
                      ),
                      const SizedBox(height: 8),
                      const Text(
                        'تطبيق مقدم الخدمة',
                        style: TextStyle(
                          fontSize: 20,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 12),
                      const Text(
                        'استخدم رمز الوصول الذي أرسله لك فريق التشغيل عبر قناة آمنة.',
                      ),
                      const SizedBox(height: 24),
                      TextField(
                        controller: _accessCodeController,
                        obscureText: true,
                        autocorrect: false,
                        enableSuggestions: false,
                        textInputAction: TextInputAction.done,
                        onSubmitted: (_) => _login(),
                        decoration: const InputDecoration(
                          labelText: 'رمز دخول مقدم الخدمة',
                          border: OutlineInputBorder(),
                        ),
                      ),
                      if (_error != null) ...[
                        const SizedBox(height: 12),
                        Text(
                          _error!,
                          style: const TextStyle(color: Color(0xFFB42318)),
                        ),
                      ],
                      const SizedBox(height: 20),
                      FilledButton(
                        onPressed: _submitting ? null : _login,
                        child: Text(_submitting ? 'جارٍ الدخول…' : 'دخول'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildDashboard() {
    final provider = _provider!;
    return Scaffold(
      appBar: AppBar(
        title: const Text('معين للمحترفين'),
        actions: [
          IconButton(
            onPressed: _submitting ? null : _refresh,
            icon: const Icon(Icons.refresh),
            tooltip: 'تحديث',
          ),
          IconButton(
            onPressed: _submitting ? null : _logout,
            icon: const Icon(Icons.logout),
            tooltip: 'تسجيل الخروج',
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      provider.name,
                      style: const TextStyle(
                        fontSize: 22,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '${provider.serviceZone} · ${provider.specialties.map((item) => _serviceNames[item] ?? item).join('، ')}',
                    ),
                    const SizedBox(height: 12),
                    SwitchListTile.adaptive(
                      contentPadding: EdgeInsets.zero,
                      title: const Text('متاح لاستقبال التعيينات'),
                      value: provider.available,
                      onChanged: _submitting ? null : _updateAvailability,
                    ),
                  ],
                ),
              ),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: const TextStyle(color: Color(0xFFB42318))),
            ],
            const SizedBox(height: 20),
            const Text(
              'فرص العمل المتاحة',
              style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            if (_opportunitiesLoading && _opportunities.isEmpty)
              const Card(
                child: Padding(
                  padding: EdgeInsets.all(20),
                  child: Center(child: CircularProgressIndicator()),
                ),
              )
            else if (_opportunitiesError != null)
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(
                        _opportunitiesError!,
                        style: const TextStyle(color: Color(0xFFB42318)),
                      ),
                      const SizedBox(height: 8),
                      OutlinedButton(
                        onPressed: _loadOpportunities,
                        child: const Text('إعادة المحاولة'),
                      ),
                    ],
                  ),
                ),
              )
            else if (_opportunities.isEmpty)
              const Card(
                child: Padding(
                  padding: EdgeInsets.all(20),
                  child: Text('لا توجد فرص متاحة حاليًا.'),
                ),
              )
            else
              ..._opportunities.map(_buildOpportunityCard),
            const SizedBox(height: 20),
            const Text(
              'مهامي المسندة',
              style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            if (_jobs.isEmpty)
              const Card(
                child: Padding(
                  padding: EdgeInsets.all(20),
                  child: Text('لا توجد مهام مسندة لك الآن.'),
                ),
              )
            else
              ..._jobs.map(_buildJobCard),
          ],
        ),
      ),
    );
  }

  bool _isOpportunityHideable(ProviderOpportunity opportunity) {
    if (opportunity.opportunityStatus == 'rejected') return true;
    if (opportunity.opportunityStatus == 'withdrawn') return true;
    return opportunity.opportunityStatus == 'closed' &&
        opportunity.myQuote?.status != 'approved';
  }

  Future<void> _hideOpportunity(ProviderOpportunity opportunity) async {
    final providerId = _provider?.id;
    if (providerId == null) return;
    try {
      await widget._hiddenStore.hideRequest(providerId, opportunity.requestId);
    } catch (_) {
      // Best-effort: the card still hides for this session even if the
      // local persistence write fails.
    }
    if (!mounted) return;
    setState(() {
      _hiddenRequestIds.add(opportunity.requestId);
      _opportunities = _opportunities
          .where((item) => item.requestId != opportunity.requestId)
          .toList();
    });
  }

  Widget _buildOpportunityCard(ProviderOpportunity opportunity) {
    final cardKey = _opportunityCardKeys.putIfAbsent(
      opportunity.requestId,
      GlobalKey.new,
    );
    final serviceLabel =
        _serviceNames[opportunity.serviceId] ?? opportunity.serviceId;
    final timingLabel = _timingLabels[opportunity.timing] ?? opportunity.timing;
    final statusLabel = opportunityMessage(opportunity);
    final quote = opportunity.myQuote;
    return Card(
      key: cardKey,
      margin: const EdgeInsets.only(bottom: 12),

      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              serviceLabel,
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 4),
            Text('$timingLabel · $statusLabel'),
            if (opportunity.address == null ||
                (opportunity.details?.trim().isEmpty ?? true)) ...[
              const SizedBox(height: 10),
              Semantics(
                liveRegion: true,
                child: Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: const Color(0xFFFFF4D6),
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: const Color(0xFFE7C56C)),
                  ),
                  child: const Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(
                        Icons.info_outline_rounded,
                        color: MoeenColors.warning,
                      ),
                      SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          'بعض تفاصيل الموقع أو وصف الطلب غير متاحة بعد. قدّم عرضاً بعد تقديرك المهني فقط، ولا نفترض معلومات غير ظاهرة.',
                          style: TextStyle(
                            color: MoeenColors.primaryDark,
                            height: 1.4,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
            if (opportunity.address != null) ...[
              const SizedBox(height: 8),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(
                    Icons.location_on_outlined,
                    size: 18,
                    color: Color(0xFF0B6E69),
                  ),
                  const SizedBox(width: 6),
                  Expanded(child: Text(opportunity.address!)),
                ],
              ),
            ],
            if (opportunity.details?.isNotEmpty ?? false) ...[
              const SizedBox(height: 6),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(
                    Icons.notes_rounded,
                    size: 18,
                    color: Color(0xFF0B6E69),
                  ),
                  const SizedBox(width: 6),
                  Expanded(child: Text(opportunity.details!)),
                ],
              ),
            ],
            if (opportunity.images.isNotEmpty) ...[
              const SizedBox(height: 10),
              ProviderRequestImageThumbnails(images: opportunity.images),
            ],
            if (quote != null && opportunity.opportunityStatus == 'quoted') ...[
              const SizedBox(height: 8),
              Text(
                'عرضك: ${(quote.amountHalalas / 100).toStringAsFixed(2)} ر.س — بانتظار قرار العميل',
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              Text(quote.scope),
            ],
            if (opportunity.opportunityStatus == 'invited') ...[
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                child: Builder(
                  builder: (buttonContext) => FilledButton(
                    onPressed: _submitting
                        ? null
                        : () => _openQuoteSheet(buttonContext, opportunity),
                    child: const Text('تقديم عرض'),
                  ),
                ),
              ),
            ],
            if (_isOpportunityHideable(opportunity)) ...[
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton(
                  onPressed: () => _hideOpportunity(opportunity),
                  child: const Text('إخفاء من قائمتي'),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildJobCard(ProviderJob job) {
    final nextStatus = nextProviderStatus(job);
    final cardKey = _jobCardKeys.putIfAbsent(job.id, GlobalKey.new);
    return Card(
      key: cardKey,
      margin: const EdgeInsets.only(bottom: 12),

      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              _serviceNames[job.serviceId] ?? job.serviceId,
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 6),
            Text(job.id, style: const TextStyle(color: Color(0xFF66807D))),
            const SizedBox(height: 4),
            Text(job.address),
            if (job.details?.isNotEmpty ?? false) ...[
              const SizedBox(height: 4),
              Text(job.details!),
            ],
            const SizedBox(height: 10),
            Chip(label: Text(_statusLabels[job.status] ?? job.status)),
            if (job.quote != null) ...[
              const SizedBox(height: 8),
              Text(
                'عرض السعر: ${(job.quote!.amountHalalas / 100).toStringAsFixed(2)} ر.س',
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              Text(job.quote!.scope),
              Text(
                job.quote!.status == 'approved'
                    ? 'وافق العميل على العرض'
                    : job.quote!.status == 'rejected'
                    ? 'رفض العميل العرض'
                    : 'بانتظار قرار العميل على عرض السعر',
                style: TextStyle(
                  color: job.quote!.status == 'approved'
                      ? const Color(0xFF0B6E69)
                      : const Color(0xFF9A6700),
                ),
              ),
            ],
            const SizedBox(height: 12),
            if (job.customerPhone != null && job.customerPhone!.isNotEmpty) ...[
              Text(
                'رقم العميل: ${job.customerPhone}',
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
            ],
            const SizedBox(height: 12),
            if (nextStatus != null)
              Builder(
                builder: (buttonContext) => FilledButton(
                  onPressed: _submitting
                      ? null
                      : () => _confirmAndAdvance(job, buttonContext),
                  child: Text(providerActionLabel(job)),
                ),
              )
            else
              Text(
                providerActionLabel(job),
                style: const TextStyle(color: Color(0xFF66807D)),
              ),
          ],
        ),
      ),
    );
  }
}

class _QuoteSheet extends StatefulWidget {
  const _QuoteSheet({
    required this.api,
    required this.token,
    required this.requestId,
    required this.serviceLabel,
  });

  final ProviderApi api;
  final String token;
  final String requestId;
  final String serviceLabel;

  @override
  State<_QuoteSheet> createState() => _QuoteSheetState();
}

class _QuoteSheetState extends State<_QuoteSheet> {
  final _amountController = TextEditingController();
  final _scopeController = TextEditingController();
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _amountController.dispose();
    _scopeController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final amountText = _amountController.text.trim();
    final scope = _scopeController.text.trim();
    final amount = double.tryParse(amountText);
    if (amount == null || amount <= 0) {
      setState(() => _error = 'أدخل مبلغًا صحيحًا أكبر من صفر.');
      return;
    }
    if (scope.length < 3) {
      setState(() => _error = 'أدخل وصفًا للنطاق (3 أحرف على الأقل).');
      return;
    }
    final amountHalalas = (amount * 100).round();
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await widget.api.submitQuote(
        widget.token,
        widget.requestId,
        amountHalalas,
        scope,
      );
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } on ProviderUnauthorizedException {
      if (!mounted) return;
      Navigator.of(context).pop('unauthorized');
    } catch (_) {
      if (!mounted) return;
      setState(() => _error = 'تعذر إرسال العرض. حاول مرة أخرى.');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Directionality(
      textDirection: TextDirection.rtl,
      child: Padding(
        padding: EdgeInsets.only(
          left: 16,
          right: 16,
          top: 16,
          bottom: MediaQuery.of(context).viewInsets.bottom + 16,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'تقديم عرض — ${widget.serviceLabel}',
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _amountController,
              keyboardType: const TextInputType.numberWithOptions(
                decimal: true,
              ),
              decoration: const InputDecoration(
                labelText: 'المبلغ (ر.س)',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _scopeController,
              decoration: const InputDecoration(
                labelText: 'وصف النطاق (3 أحرف على الأقل)',
                border: OutlineInputBorder(),
              ),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: const TextStyle(color: Color(0xFFB42318))),
            ],
            const SizedBox(height: 16),
            FilledButton(
              onPressed: _submitting ? null : _submit,
              child: Text(_submitting ? 'جارٍ الإرسال…' : 'إرسال العرض'),
            ),
          ],
        ),
      ),
    );
  }
}
