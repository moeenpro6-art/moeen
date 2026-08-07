import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

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
  });

  final String id;
  final String serviceId;
  final String address;
  final String? details;
  final String timing;
  final String status;
  final ProviderQuote? quote;

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

class MoeenProviderApp extends StatefulWidget {
  MoeenProviderApp({
    super.key,
    ProviderApi? api,
    ProviderSessionStore? sessionStore,
  }) : _api = api ?? ProviderApi(),
       _sessionStore = sessionStore ?? SecureProviderSessionStore();

  final ProviderApi _api;
  final ProviderSessionStore _sessionStore;

  @override
  State<MoeenProviderApp> createState() => _MoeenProviderAppState();
}

class _MoeenProviderAppState extends State<MoeenProviderApp> {
  final _accessCodeController = TextEditingController();
  String? _token;
  ProviderProfile? _provider;
  List<ProviderJob> _jobs = const [];
  bool _loading = true;
  bool _submitting = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _restoreSession();
  }

  @override
  void dispose() {
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
    } catch (_) {
      await _expireSession();
    }
  }

  Future<void> _expireSession() async {
    await widget._sessionStore.clearToken();
    if (mounted) {
      setState(() {
        _token = null;
        _provider = null;
        _jobs = const [];
        _loading = false;
        _error = null;
      });
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
      await _loadDashboard(token);
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
      title: 'معين للمحترفين',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF0B6E69)),
        useMaterial3: true,
        scaffoldBackgroundColor: const Color(0xFFF7FAF9),
      ),
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

  Widget _buildJobCard(ProviderJob job) {
    final nextStatus = nextProviderStatus(job);
    return Card(
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
            if (nextStatus != null)
              FilledButton(
                onPressed: _submitting ? null : () => _advance(job),
                child: Text(providerActionLabel(job)),
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
