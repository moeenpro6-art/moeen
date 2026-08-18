import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'api_config.dart';
import 'customer_session.dart';
import 'request_images.dart';
import 'moeen_ui.dart';

void main() {
  runApp(const MoeenApp());
}

class ServiceOption {
  const ServiceOption({
    required this.id,
    required this.name,
    required this.description,
    required this.icon,
  });

  final String id;
  final String name;
  final String description;
  final IconData icon;
}

class MoeenApp extends StatefulWidget {
  const MoeenApp({super.key});

  static const launchServices = <ServiceOption>[
    ServiceOption(
      id: 'ac-cleaning',
      name: 'تنظيف المكيفات',
      description: 'تنظيف وصيانة المكيفات المنزلية',
      icon: Icons.ac_unit_rounded,
    ),
    ServiceOption(
      id: 'upholstery',
      name: 'غسيل الكنب والمجالس',
      description: 'تنظيف عميق للمجالس والكنب والمراتب',
      icon: Icons.chair_alt_rounded,
    ),
    ServiceOption(
      id: 'home-cleaning',
      name: 'تنظيف المنازل',
      description: 'تنظيف الشقق والفلل بموعد مناسب لك',
      icon: Icons.cleaning_services_rounded,
    ),
    ServiceOption(
      id: 'tank-cleaning',
      name: 'تنظيف الخزانات',
      description: 'تنظيف وتعقيم الخزانات عبر فريق متخصص',
      icon: Icons.water_drop_outlined,
    ),
    ServiceOption(
      id: 'plumbing',
      name: 'سباكة وتسربات',
      description: 'أعطال السباكة والتسربات المنزلية',
      icon: Icons.plumbing_rounded,
    ),
  ];

  @override
  State<MoeenApp> createState() => _MoeenAppState();
}

class _MoeenAppState extends State<MoeenApp> {
  Widget _home = const CustomerLoginPage();

  @override
  void initState() {
    super.initState();
    _restoreSession();
  }

  Future<void> _restoreSession() async {
    try {
      final session = await customerSessionManager.restore();
      if (session != null && mounted) {
        setState(() => _home = const MoeenHomePage());
      }
    } catch (_) {
      // A storage failure should not block a customer from signing in again.
    }
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'معين',
      debugShowCheckedModeBanner: false,
      theme: MoeenTheme.light(),
      builder: (context, child) => Directionality(
        textDirection: TextDirection.rtl,
        child: child ?? const SizedBox.shrink(),
      ),
      home: _home,
    );
  }
}

class MoeenHomePage extends StatelessWidget {
  const MoeenHomePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text(
          'معين',
          style: TextStyle(fontWeight: FontWeight.w700),
        ),
        actions: [
          IconButton(
            tooltip: 'طلباتي',
            icon: const Icon(Icons.receipt_long_outlined),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => const CustomerRequestsPage(),
              ),
            ),
          ),
          IconButton(
            tooltip: 'تسجيل الخروج',
            icon: const Icon(Icons.logout_rounded),
            onPressed: () async {
              await customerSessionManager.clear();
              if (!context.mounted) return;
              Navigator.of(context).pushAndRemoveUntil(
                MaterialPageRoute<void>(
                  builder: (_) => const CustomerLoginPage(),
                ),
                (route) => false,
              );
            },
          ),
        ],
      ),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 680),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 32),
              children: [
                const _WelcomeCard(),
                const SizedBox(height: 28),
                Text(
                  'خدماتنا',
                  style: Theme.of(context).textTheme.titleLarge?.copyWith(
                    color: const Color(0xFF163C39),
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 12),
                ...MoeenApp.launchServices.map(
                  (service) => Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: _ServiceCard(service: service),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _WelcomeCard extends StatelessWidget {
  const _WelcomeCard();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(24),
        gradient: const LinearGradient(
          colors: [Color(0xFF0B6E69), Color(0xFF17413E)],
          begin: Alignment.topRight,
          end: Alignment.bottomLeft,
        ),
      ),
      child: const Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            Icons.home_repair_service_rounded,
            color: Color(0xFFD7F2EF),
            size: 32,
          ),
          SizedBox(height: 24),
          Text(
            'كيف نعينك اليوم؟',
            style: TextStyle(
              color: Colors.white,
              fontSize: 28,
              fontWeight: FontWeight.w700,
            ),
          ),
          SizedBox(height: 8),
          Text(
            'اختر الخدمة المطلوبة في بريدة، القصيم واحجز في دقائق.',
            style: TextStyle(
              color: Color(0xFFD7F2EF),
              fontSize: 16,
              height: 1.6,
            ),
          ),
        ],
      ),
    );
  }
}

class _ServiceCard extends StatelessWidget {
  const _ServiceCard({required this.service});

  final ServiceOption service;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.white,
      borderRadius: BorderRadius.circular(18),
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => BookingPage(service: service),
          ),
        ),
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            border: Border.all(color: const Color(0xFFDCE8E5)),
            borderRadius: BorderRadius.circular(18),
          ),
          child: Row(
            children: [
              Container(
                width: 52,
                height: 52,
                decoration: BoxDecoration(
                  color: const Color(0xFFE5F3F1),
                  borderRadius: BorderRadius.circular(16),
                ),
                child: Icon(service.icon, color: const Color(0xFF0B6E69)),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      service.name,
                      style: const TextStyle(
                        fontSize: 17,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      service.description,
                      style: const TextStyle(
                        color: Color(0xFF66807D),
                        height: 1.4,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              const Icon(
                Icons.arrow_back_ios_new_rounded,
                size: 18,
                color: Color(0xFF0B6E69),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class BookingPage extends StatefulWidget {
  const BookingPage({
    super.key,
    required this.service,
    this.imagePicker,
    this.sessionManager,
    this.httpClient,
    this.apiConfig,
  });

  final ServiceOption service;
  final RequestImagePicker? imagePicker;

  /// Test seam: overrides the global customer session manager.
  final CustomerSessionManager? sessionManager;

  /// Test seam: overrides the HTTP client used to create service requests.
  final http.Client? httpClient;

  /// Test seam: overrides the API origin configuration.
  final MoeenApiConfig? apiConfig;

  @override
  State<BookingPage> createState() => _BookingPageState();
}

class _BookingPageState extends State<BookingPage> {
  final _formKey = GlobalKey<FormState>();
  final _addressController = TextEditingController();
  final _detailsController = TextEditingController();
  String _timing = 'في أقرب وقت';
  bool _isSubmitting = false;
  bool _pickingImages = false;
  String? _imageError;
  List<SelectedRequestImage> _selectedImages = [];

  /// One Idempotency-Key per booking payload. Reused verbatim on every
  /// retry of the unchanged payload and invalidated when the payload
  /// changes, so a retry after a lost response replays the committed
  /// request instead of creating a duplicate.
  final _submissionIdentity = BookingSubmissionIdentity();

  RequestImagePicker get _imagePicker =>
      widget.imagePicker ?? ImagePickerRequestImagePicker();

  CustomerSessionManager get _sessionManager =>
      widget.sessionManager ?? customerSessionManager;

  http.Client get _httpClient => widget.httpClient ?? http.Client();

  MoeenApiConfig get _apiConfig => widget.apiConfig ?? moeenApi;

  @override
  void dispose() {
    _addressController.dispose();
    _detailsController.dispose();
    super.dispose();
  }

  Future<void> _pickImages() async {
    if (_selectedImages.length >= maxRequestImages) {
      setState(() => _imageError = 'الحد الأقصى $maxRequestImages صور لكل طلب');
      return;
    }
    setState(() {
      _pickingImages = true;
      _imageError = null;
    });
    try {
      final picked = await _imagePicker.pickImages();
      if (!mounted) return;
      final candidates = <SelectedRequestImage>[
        ..._selectedImages,
        ...picked.map(
          (file) => SelectedRequestImage(
            fileName: file.fileName,
            mimeType: file.mimeType,
            size: file.size,
            bytes: file.bytes,
          ),
        ),
      ];
      final error =
          validateRequestImageSelection(candidates) ??
          duplicateRequestImageError(candidates);
      setState(() {
        if (error == null) {
          _selectedImages = candidates;
        } else {
          _imageError = error;
        }
      });
    } catch (_) {
      if (mounted) {
        setState(() => _imageError = 'تعذر اختيار الصور. حاول مرة أخرى.');
      }
    } finally {
      if (mounted) setState(() => _pickingImages = false);
    }
  }

  Future<void> _replaceImage(int index) async {
    setState(() {
      _pickingImages = true;
      _imageError = null;
    });
    try {
      final picked = await _imagePicker.pickImages();
      if (!mounted) return;
      if (picked.isEmpty) return;
      final replacement = picked.first;
      final candidates = [..._selectedImages];
      candidates[index] = SelectedRequestImage(
        fileName: replacement.fileName,
        mimeType: replacement.mimeType,
        size: replacement.size,
        bytes: replacement.bytes,
      );
      final error =
          validateRequestImageSelection(candidates) ??
          duplicateRequestImageError(candidates);
      setState(() {
        if (error == null) {
          _selectedImages = candidates;
        } else {
          _imageError = error;
        }
      });
    } catch (_) {
      if (mounted) {
        setState(() => _imageError = 'تعذر اختيار الصورة. حاول مرة أخرى.');
      }
    } finally {
      if (mounted) setState(() => _pickingImages = false);
    }
  }

  void _removeImage(int index) {
    setState(() {
      _selectedImages = List.of(_selectedImages)..removeAt(index);
      _imageError = null;
    });
  }

  Future<void> _continueBooking() async {
    if (_timing == 'تحديد موعد') {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'المواعيد المحددة غير متاحة حالياً. اختر «في أقرب وقت» لإرسال الطلب.',
          ),
        ),
      );
      return;
    }
    if (!_formKey.currentState!.validate()) return;
    final imageError = validateRequestImageSelection(_selectedImages);
    if (imageError != null) {
      setState(() => _imageError = imageError);
      return;
    }

    setState(() => _isSubmitting = true);
    http.Response? response;
    try {
      final session = await _sessionManager.restore();
      if (session == null) throw Exception('Customer session required');
      final address = _addressController.text.trim();
      final details = _detailsController.text.trim();
      final timing = _timing == 'في أقرب وقت'
          ? 'as-soon-as-possible'
          : 'scheduled';
      if (_selectedImages.isEmpty) {
        // Legacy zero-image flow: plain JSON body, no Idempotency-Key.
        // The API's JSON create path has no idempotency contract, so no key
        // is sent here (adding one would invent a backend contract).
        response = await _httpClient.post(
          _apiConfig.endpoint('/service-requests'),
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ${session.token}',
          },
          body: jsonEncode({
            'serviceId': widget.service.id,
            'address': address,
            'details': details,
            'timing': timing,
          }),
        );
      } else {
        // Multipart contract: `images` file parts plus a UUID v4
        // Idempotency-Key. The key is minted once per payload snapshot and
        // reused on every retry of the SAME payload, so a retry after a
        // lost/failed response replays the committed request instead of
        // creating a duplicate.
        final idempotencyKey = _submissionIdentity.keyFor(
          serviceId: widget.service.id,
          address: address,
          details: details.isEmpty ? null : details,
          timing: timing,
          orderedImageBytes: [
            for (final image in _selectedImages) image.bytes,
          ],
        );
        response = await submitServiceRequestWithImages(
          client: _httpClient,
          endpoint: _apiConfig.endpoint('/service-requests'),
          token: session.token,
          serviceId: widget.service.id,
          address: address,
          details: details.isEmpty ? null : details,
          timing: timing,
          images: _selectedImages,
          idempotencyKey: idempotencyKey,
        );
      }

      if (!mounted) return;
      if (response.statusCode != 201) {
        throw _ImageAwareRequestException(response);
      }

      final request = jsonDecode(response.body) as Map<String, dynamic>;
      // The booking is committed: the submission identity is spent. Clearing
      // it guarantees a later new booking starts with a fresh key.
      _submissionIdentity.clear();
      await Navigator.of(context).pushReplacement(
        MaterialPageRoute<void>(
          builder: (_) => RequestConfirmedPage(
            requestId: request['id'] as String,
            serviceName: widget.service.name,
          ),
        ),
      );
    } on _ImageAwareRequestException catch (error) {
      if (!mounted) return;
      if (error.response.statusCode == 409) {
        // The server permanently bound this key to different content; it can
        // never succeed again. Drop it so the next attempt mints a fresh key
        // instead of being stuck in an endless conflict.
        _submissionIdentity.clear();
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(_imageAwareFailureMessage(error.response)),
          backgroundColor: const Color(0xFF9B2C2C),
        ),
      );
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'تعذر إرسال الطلب الآن. تحقق من اتصالك ثم أعد المحاولة. احتفظنا بما أدخلته.',
          ),
          backgroundColor: Color(0xFF9B2C2C),
        ),
      );
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  String _imageAwareFailureMessage(http.Response response) {
    if (response.statusCode == 413) {
      return 'تعذر قبول الصور: إحدى الصور أكبر من الحد المسموح (5 م.ب).';
    }
    if (response.statusCode == 409) {
      return 'حدث تعارض مع محاولة سابقة. أعد المحاولة لإرسال طلبك.';
    }
    if (response.statusCode == 400) {
      final body = response.body.toLowerCase();
      if (body.contains('image') || body.contains('idempotency')) {
        return 'تعذر قبول الصور المرفقة. تحقق من صيغة الصور وحجمها ثم أعد المحاولة.';
      }
    }
    return 'تعذر إرسال الطلب الآن. تحقق من اتصالك ثم أعد المحاولة. احتفظنا بما أدخلته.';
  }

  @override
  Widget build(BuildContext context) {
    final service = widget.service;
    return Scaffold(
      appBar: AppBar(title: const Text('طلب خدمة')),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 680),
            child: Form(
              key: _formKey,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
                children: [
                  _SelectedService(service: service),
                  const SizedBox(height: 28),
                  Text(
                    'أين موقع الخدمة؟',
                    style: Theme.of(context).textTheme.titleLarge?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextFormField(
                    controller: _addressController,
                    textInputAction: TextInputAction.next,
                    decoration: _inputDecoration(
                      'الحي، الشارع، رقم المبنى أو معلم قريب',
                      Icons.location_on_outlined,
                    ),
                    validator: (value) => value == null || value.trim().isEmpty
                        ? 'أدخل عنوان الخدمة'
                        : null,
                  ),
                  const SizedBox(height: 24),
                  Text(
                    'متى تحتاج الخدمة؟',
                    style: Theme.of(context).textTheme.titleLarge?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 10),
                  SegmentedButton<String>(
                    segments: const [
                      ButtonSegment(
                        value: 'في أقرب وقت',
                        label: Text('في أقرب وقت'),
                        icon: Icon(Icons.bolt_outlined),
                      ),
                      ButtonSegment(
                        value: 'تحديد موعد',
                        label: Text('تحديد موعد'),
                        icon: Icon(Icons.calendar_month_outlined),
                      ),
                    ],
                    selected: {_timing},
                    onSelectionChanged: (value) =>
                        setState(() => _timing = value.first),
                  ),
                  if (_timing == 'تحديد موعد') ...[
                    const SizedBox(height: 12),
                    Container(
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
                              'سيصبح حجز الموعد متاحاً عند توفر مواعيد مؤكدة. لا يمكن إرسال طلب بموعد غير محدد.',
                              style: TextStyle(
                                color: MoeenColors.primaryDark,
                                height: 1.45,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                  const SizedBox(height: 24),
                  Text(
                    'تفاصيل الطلب',
                    style: Theme.of(context).textTheme.titleLarge?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextFormField(
                    controller: _detailsController,
                    minLines: 4,
                    maxLines: 5,
                    decoration: _inputDecoration(
                      'اكتب وصفاً للمشكلة أو متطلبات الخدمة',
                      Icons.notes_rounded,
                    ),
                  ),
                  const SizedBox(height: 24),
                  Text(
                    'صور الطلب (اختياري)',
                    style: Theme.of(context).textTheme.titleLarge?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 10),
                  if (_selectedImages.isNotEmpty) ...[
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        for (
                          var index = 0;
                          index < _selectedImages.length;
                          index++
                        )
                          _SelectedImageTile(
                            image: _selectedImages[index],
                            onRemove: () => _removeImage(index),
                            onReplace: _pickingImages || _isSubmitting
                                ? null
                                : () => _replaceImage(index),
                          ),
                      ],
                    ),
                    const SizedBox(height: 10),
                  ],
                  if (_imageError != null) ...[
                    Text(
                      _imageError!,
                      style: const TextStyle(
                        color: Color(0xFF9B2C2C),
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 10),
                  ],
                  OutlinedButton.icon(
                    onPressed: (_isSubmitting || _pickingImages)
                        ? null
                        : _pickImages,
                    icon: _pickingImages
                        ? const SizedBox(
                            height: 18,
                            width: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.add_a_photo_outlined),
                    label: Text(
                      _selectedImages.isEmpty
                          ? 'إضافة صور للخدمة'
                          : 'إضافة صورة أخرى (${_selectedImages.length}/$maxRequestImages)',
                    ),
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size.fromHeight(52),
                    ),
                  ),
                  const SizedBox(height: 6),
                  const Text(
                    'JPEG أو PNG أو WebP · حتى 5 صور · 5 م.ب كحد أقصى للصورة',
                    style: TextStyle(color: Color(0xFF66807D), fontSize: 12),
                  ),
                  const SizedBox(height: 28),
                  FilledButton(
                    onPressed: (_isSubmitting || _timing == 'تحديد موعد')
                        ? null
                        : _continueBooking,
                    style: FilledButton.styleFrom(
                      minimumSize: const Size.fromHeight(56),
                    ),
                    child: _isSubmitting
                        ? const SizedBox(
                            height: 22,
                            width: 22,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          )
                        : const Text(
                            'متابعة الطلب',
                            style: TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  InputDecoration _inputDecoration(String hint, IconData icon) {
    return InputDecoration(
      hintText: hint,
      prefixIcon: Icon(icon),
      filled: true,
      fillColor: Colors.white,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(16),
        borderSide: const BorderSide(color: Color(0xFFDCE8E5)),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(16),
        borderSide: const BorderSide(color: Color(0xFFDCE8E5)),
      ),
    );
  }
}

class _ImageAwareRequestException implements Exception {
  const _ImageAwareRequestException(this.response);

  final http.Response response;
}

class _SelectedImageTile extends StatelessWidget {
  const _SelectedImageTile({
    required this.image,
    required this.onRemove,
    this.onReplace,
  });

  final SelectedRequestImage image;
  final VoidCallback onRemove;
  final VoidCallback? onReplace;

  @override
  Widget build(BuildContext context) {
    return Stack(
      clipBehavior: Clip.none,
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(12),
          child: SizedBox(
            width: 96,
            height: 96,
            child: Image.memory(
              image.bytes,
              fit: BoxFit.cover,
              errorBuilder: (context, error, stackTrace) => const ColoredBox(
                color: Color(0xFFF2F6F5),
                child: Center(
                  child: Icon(
                    Icons.broken_image_outlined,
                    color: Color(0xFF66807D),
                  ),
                ),
              ),
            ),
          ),
        ),
        PositionedDirectional(
          top: -8,
          start: -8,
          child: IconButton.filled(
            onPressed: onRemove,
            icon: const Icon(Icons.close, size: 16),
            tooltip: 'إزالة الصورة',
            visualDensity: VisualDensity.compact,
            style: IconButton.styleFrom(
              backgroundColor: const Color(0xFF9B2C2C),
              foregroundColor: Colors.white,
            ),
          ),
        ),
        PositionedDirectional(
          bottom: -8,
          end: -8,
          child: IconButton.filled(
            onPressed: onReplace,
            icon: const Icon(Icons.swap_horiz, size: 16),
            tooltip: 'استبدال الصورة',
            visualDensity: VisualDensity.compact,
            style: IconButton.styleFrom(
              backgroundColor: const Color(0xFF0B6E69),
              foregroundColor: Colors.white,
            ),
          ),
        ),
      ],
    );
  }
}

class _SelectedService extends StatelessWidget {
  const _SelectedService({required this.service});

  final ServiceOption service;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: const Color(0xFFE5F3F1),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Row(
        children: [
          Icon(service.icon, color: const Color(0xFF0B6E69), size: 30),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              service.name,
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
            ),
          ),
          const Text(
            'تغيير',
            style: TextStyle(
              color: Color(0xFF0B6E69),
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }
}

class RequestConfirmedPage extends StatelessWidget {
  const RequestConfirmedPage({
    super.key,
    required this.requestId,
    required this.serviceName,
  });

  final String requestId;
  final String serviceName;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('تم استلام الطلب')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 520),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Container(
                  width: 88,
                  height: 88,
                  decoration: const BoxDecoration(
                    color: Color(0xFFE5F3F1),
                    shape: BoxShape.circle,
                  ),
                  child: const Icon(
                    Icons.check_circle_rounded,
                    color: Color(0xFF0B6E69),
                    size: 54,
                  ),
                ),
                const SizedBox(height: 24),
                const Text(
                  'تم استلام طلبك بنجاح',
                  style: TextStyle(fontSize: 26, fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 12),
                Text(
                  'طلب $serviceName أصبح الآن بانتظار التوزيع على الفريق المناسب.',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Color(0xFF506764), height: 1.6),
                ),
                const SizedBox(height: 20),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 12,
                  ),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: Text(
                    'رقم الطلب: $requestId',
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                ),
                const SizedBox(height: 32),
                FilledButton(
                  onPressed: () => Navigator.of(context).pushReplacement(
                    MaterialPageRoute<void>(
                      builder: (_) => const CustomerRequestsPage(),
                    ),
                  ),
                  style: FilledButton.styleFrom(
                    minimumSize: const Size.fromHeight(56),
                  ),
                  child: const Text('متابعة حالة الطلب'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

String supportCategoryLabel(String category) =>
    {
      'no_show': 'الفني لم يصل',
      'price': 'السعر مختلف عن المتوقع',
      'quality': 'الخدمة غير مرضية',
      'payment': 'مشكلة في الدفع',
      'other': 'سبب آخر',
    }[category] ??
    'سبب آخر';

class CustomerQuoteProviderSummary {
  const CustomerQuoteProviderSummary({
    required this.name,
    this.averageRating,
    required this.ratingCount,
  });

  final String name;
  final double? averageRating;
  final int ratingCount;

  factory CustomerQuoteProviderSummary.fromJson(Map<String, dynamic> json) =>
      CustomerQuoteProviderSummary(
        name: json['name'] as String? ?? '',
        averageRating: (json['averageRating'] as num?)?.toDouble(),
        ratingCount: json['ratingCount'] as int? ?? 0,
      );
}

class CustomerQuote {
  const CustomerQuote({
    required this.id,
    required this.amountHalalas,
    required this.scope,
    required this.status,
    this.providerSummary,
  });

  final String id;
  final int amountHalalas;
  final String scope;
  final String status;
  final CustomerQuoteProviderSummary? providerSummary;

  factory CustomerQuote.fromJson(Map<String, dynamic> json) => CustomerQuote(
    id: json['id'] as String,
    amountHalalas: json['amountHalalas'] as int,
    scope: json['scope'] as String,
    status: json['status'] as String,
    providerSummary: (json['providerSummary'] as Map<String, dynamic>?) == null
        ? null
        : CustomerQuoteProviderSummary.fromJson(
            json['providerSummary'] as Map<String, dynamic>,
          ),
  );
}

class CustomerPayment {
  const CustomerPayment({
    required this.id,
    required this.amountHalalas,
    required this.currency,
    required this.method,
    required this.status,
    this.refundedAt,
  });

  final String id;
  final int amountHalalas;
  final String currency;
  final String method;
  final String status;
  final String? refundedAt;

  factory CustomerPayment.fromJson(Map<String, dynamic> json) =>
      CustomerPayment(
        id: json['id'] as String,
        amountHalalas: json['amountHalalas'] as int,
        currency: json['currency'] as String,
        method: json['method'] as String,
        status: json['status'] as String,
        refundedAt: json['refundedAt'] as String?,
      );
}

class CustomerRequest {
  const CustomerRequest({
    required this.id,
    required this.serviceId,
    required this.status,
    this.providerName,
    this.quote,
    this.quotes = const [],
    this.payment,
    this.rating,
    this.ratingComment,
    this.images = const [],
  });

  final String id;
  final String serviceId;
  final String status;
  final String? providerName;
  final CustomerQuote? quote;
  final List<CustomerQuote> quotes;
  final CustomerPayment? payment;
  final int? rating;
  final String? ratingComment;
  final List<RequestImage> images;

  factory CustomerRequest.fromJson(Map<String, dynamic> json) =>
      CustomerRequest(
        id: json['id'] as String,
        serviceId: json['serviceId'] as String,
        status: json['status'] as String,
        providerName:
            (json['assignedProvider'] as Map<String, dynamic>?)?['name']
                as String?,
        quote: (json['quote'] as Map<String, dynamic>?) == null
            ? null
            : CustomerQuote.fromJson(json['quote'] as Map<String, dynamic>),
        quotes:
            (json['quotes'] as List<dynamic>?)
                ?.map((q) => CustomerQuote.fromJson(q as Map<String, dynamic>))
                .toList() ??
            const [],
        payment: (json['payment'] as Map<String, dynamic>?) == null
            ? null
            : CustomerPayment.fromJson(json['payment'] as Map<String, dynamic>),
        rating: json['rating'] as int?,
        ratingComment: json['ratingComment'] as String?,
        images: RequestImage.listFromJson(json['images']),
      );
}

Future<bool> ratingWasPersistedAfterAmbiguousFailure({
  required String requestId,
  required Future<List<CustomerRequest>> Function() loadRequests,
}) async {
  try {
    return (await loadRequests()).any(
      (request) => request.id == requestId && request.rating != null,
    );
  } catch (_) {
    return false;
  }
}

String _formatSaudiRiyals(int amountHalalas) =>
    '${(amountHalalas / 100).toStringAsFixed(2)} ر.س';

String customerPaymentLabel(CustomerPayment payment) {
  if (payment.method == 'cash_on_completion') {
    if (payment.status == 'cash_collected') return 'تم استلام المبلغ نقدًا';
    if (payment.status == 'refunded') return 'تمت إعادة المبلغ نقدًا';
    return 'الدفع نقدًا عند إتمام الخدمة';
  }
  return payment.status == 'paid'
      ? 'تم الدفع إلكترونيًا'
      : 'بانتظار إتمام الدفع';
}

Future<bool> quoteDecisionWasPersistedAfterAmbiguousFailure({
  required String requestId,
  required String quoteId,
  required String decision,
  required Future<List<CustomerRequest>> Function() loadRequests,
}) async {
  try {
    return (await loadRequests()).any((request) {
      if (request.id != requestId) return false;
      if (request.quotes.isNotEmpty) {
        return request.quotes.any(
          (quote) => quote.id == quoteId && quote.status == decision,
        );
      }
      return request.quote?.id == quoteId && request.quote?.status == decision;
    });
  } catch (_) {
    return false;
  }
}

bool isSuccessfulHttpStatus(int statusCode) =>
    statusCode >= 200 && statusCode < 300;

class CustomerRequestDetailsPage extends StatelessWidget {
  const CustomerRequestDetailsPage({
    super.key,
    required this.request,
    required this.statusLabel,
    required this.onReviewQuote,
    required this.onRate,
    required this.onSupport,
  });

  final CustomerRequest request;
  final String statusLabel;
  final VoidCallback onReviewQuote;
  final VoidCallback onRate;
  final VoidCallback onSupport;

  String get _serviceName {
    for (final service in MoeenApp.launchServices) {
      if (service.id == request.serviceId) return service.name;
    }
    return 'خدمة معين';
  }

  MoeenStatusTone get _statusTone => switch (request.status) {
    'completed' => MoeenStatusTone.success,
    'cancelled' || 'rejected' => MoeenStatusTone.danger,
    'on_the_way' || 'in_progress' || 'assigned' => MoeenStatusTone.info,
    'pending' || 'created' => MoeenStatusTone.warning,
    _ => MoeenStatusTone.neutral,
  };

  @override
  Widget build(BuildContext context) {
    final quote = request.quote;
    final payment = request.payment;
    final showRating = request.status == 'completed' && request.rating == null;
    return MoeenPageScaffold(
      title: 'تفاصيل الطلب',
      body: ListView(
        children: [
          Semantics(
            liveRegion: true,
            child: Align(
              alignment: AlignmentDirectional.centerStart,
              child: MoeenStatusChip(label: statusLabel, tone: _statusTone),
            ),
          ),
          const SizedBox(height: MoeenSpacing.md),
          MoeenSectionCard(
            title: _serviceName,
            subtitle: 'رقم الطلب: ${request.id}',
            child: Column(
              children: [
                _CustomerDetailRow(
                  icon: Icons.receipt_long_outlined,
                  label: 'الحالة الحالية',
                  value: statusLabel,
                ),
                if (request.providerName?.trim().isNotEmpty ?? false) ...[
                  const Divider(height: MoeenSpacing.lg),
                  _CustomerDetailRow(
                    icon: Icons.verified_user_outlined,
                    label: 'الفني المعيّن',
                    value: request.providerName!,
                  ),
                ],
              ],
            ),
          ),
          if (quote != null) ...[
            const SizedBox(height: MoeenSpacing.md),
            MoeenSectionCard(
              title: 'عرض السعر',
              subtitle: quote.status == 'proposed'
                  ? 'راجع العرض قبل اتخاذ القرار.'
                  : 'حالة العرض: ${_quoteStatusLabel(quote.status)}',
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    _formatSaudiRiyals(quote.amountHalalas),
                    style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                      color: MoeenColors.primaryDark,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: MoeenSpacing.xs),
                  Text(quote.scope),
                  if (quote.providerSummary != null) ...[
                    const SizedBox(height: MoeenSpacing.sm),
                    Text(
                      quote.providerSummary!.averageRating == null
                          ? quote.providerSummary!.name
                          : ' ·  ★',
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: MoeenColors.mutedText,
                      ),
                    ),
                  ],
                  if (quote.status == 'proposed') ...[
                    const SizedBox(height: MoeenSpacing.md),
                    SizedBox(
                      width: double.infinity,
                      child: OutlinedButton.icon(
                        onPressed: onReviewQuote,
                        icon: const Icon(Icons.visibility_outlined),
                        label: const Text('مراجعة العرض واتخاذ قرار'),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
          if (payment != null) ...[
            const SizedBox(height: MoeenSpacing.md),
            MoeenSectionCard(
              title: 'الدفع',
              child: Column(
                children: [
                  _CustomerDetailRow(
                    icon: Icons.payments_outlined,
                    label: 'المبلغ',
                    value: _formatSaudiRiyals(payment.amountHalalas),
                  ),
                  const Divider(height: MoeenSpacing.lg),
                  _CustomerDetailRow(
                    icon: Icons.credit_card_outlined,
                    label: 'طريقة الدفع',
                    value: payment.method,
                  ),
                  const Divider(height: MoeenSpacing.lg),
                  _CustomerDetailRow(
                    icon: Icons.info_outline_rounded,
                    label: 'حالة الدفع',
                    value: _paymentStatusLabel(payment.status),
                  ),
                ],
              ),
            ),
          ],
          if (request.images.isNotEmpty) ...[
            const SizedBox(height: MoeenSpacing.md),
            MoeenSectionCard(
              title: 'صور الطلب',
              subtitle: 'اضغط على أي صورة لمشاهدتها بالحجم الكامل.',
              child: RequestImageThumbnails(images: request.images),
            ),
          ],
          const SizedBox(height: MoeenSpacing.md),
          MoeenSectionCard(
            title: 'المساعدة وما بعد الخدمة',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (showRating)
                  FilledButton.icon(
                    onPressed: onRate,
                    icon: const Icon(Icons.star_outline_rounded),
                    label: const Text('تقييم الخدمة'),
                  ),
                if (showRating) const SizedBox(height: MoeenSpacing.sm),
                OutlinedButton.icon(
                  onPressed: onSupport,
                  icon: const Icon(Icons.support_agent_outlined),
                  label: const Text('طلب المساعدة'),
                ),
              ],
            ),
          ),
          const SizedBox(height: MoeenSpacing.xl),
        ],
      ),
    );
  }
}

class _CustomerDetailRow extends StatelessWidget {
  const _CustomerDetailRow({
    required this.icon,
    required this.label,
    required this.value,
  });

  final IconData icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 20, color: MoeenColors.mutedText),
        const SizedBox(width: MoeenSpacing.sm),
        Expanded(
          child: Text(
            label,
            style: Theme.of(
              context,
            ).textTheme.bodyMedium?.copyWith(color: MoeenColors.mutedText),
          ),
        ),
        const SizedBox(width: MoeenSpacing.sm),
        Flexible(
          child: Text(
            value,
            textAlign: TextAlign.end,
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: MoeenColors.primaryDark,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
      ],
    );
  }
}

String _quoteStatusLabel(String status) => switch (status) {
  'approved' => 'تم قبول العرض',
  'rejected' => 'تم رفض العرض',
  'withdrawn' => 'تم سحب العرض',
  'proposed' => 'بانتظار قرارك',
  _ => status,
};

String _paymentStatusLabel(String status) => switch (status) {
  'cash_collected' => 'تم التحصيل',
  'refunded' => 'تم رد المبلغ',
  'pending' => 'بانتظار الإجراء',
  _ => status,
};

class CustomerRequestCard extends StatelessWidget {
  const CustomerRequestCard({
    super.key,
    required this.request,
    required this.statusLabel,
    required this.onReviewQuote,
    this.onReviewSpecificQuote,
    required this.onRate,
    required this.onSupport,
  });

  final CustomerRequest request;
  final String statusLabel;
  final VoidCallback onReviewQuote;
  final void Function(CustomerQuote)? onReviewSpecificQuote;
  final VoidCallback onRate;
  final VoidCallback onSupport;

  @override
  Widget build(BuildContext context) {
    final payment = request.payment;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    request.id,
                    style: const TextStyle(
                      color: Color(0xFF17312E),
                      fontSize: 18,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 6,
                  ),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(999),
                    color: const Color(0xFFE5F3F1),
                  ),
                  child: Text(
                    statusLabel,
                    style: const TextStyle(
                      color: Color(0xFF0B6E69),
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              request.rating == null
                  ? (request.providerName ?? 'سنعيّن الفني المناسب قريباً')
                  : 'تقييمك: ${request.rating}/5${request.ratingComment == null ? '' : ' — ${request.ratingComment}'}',
            ),
            if (request.quotes.isNotEmpty)
              ...request.quotes.map(
                (quote) => Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (quote.providerSummary != null &&
                          quote.providerSummary!.name.isNotEmpty) ...[
                        Text(
                          quote.providerSummary!.name,
                          style: const TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w700,
                            color: Color(0xFF17312E),
                          ),
                        ),
                        if (quote.providerSummary!.averageRating != null)
                          Text(
                            '${quote.providerSummary!.averageRating!.toStringAsFixed(1)} ★ (${quote.providerSummary!.ratingCount})',
                            style: const TextStyle(
                              fontSize: 12,
                              color: Color(0xFF506764),
                            ),
                          ),
                        const SizedBox(height: 2),
                      ],
                      Text(
                        'عرض السعر: ${_formatSaudiRiyals(quote.amountHalalas)} — ${quote.scope}',
                        style: TextStyle(
                          color: quote.status == 'proposed'
                              ? const Color(0xFF0B6E69)
                              : quote.status == 'rejected'
                              ? const Color(0xFFB33A3A)
                              : const Color(0xFF506764),
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      if (quote.status == 'proposed')
                        Text(
                          'الحالة: بإمكانك قبول العرض',
                          style: const TextStyle(fontSize: 12),
                        )
                      else if (quote.status == 'rejected')
                        Text(
                          'الحالة: تم رفض العرض',
                          style: const TextStyle(
                            fontSize: 12,
                            color: Color(0xFFB33A3A),
                          ),
                        )
                      else if (quote.status == 'approved')
                        Text(
                          'الحالة: تم قبول العرض',
                          style: const TextStyle(
                            fontSize: 12,
                            color: Color(0xFF0B6E69),
                          ),
                        ),
                      if (quote.status == 'proposed')
                        Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: Wrap(
                            spacing: 4,
                            children: [
                              TextButton(
                                onPressed: onReviewSpecificQuote != null
                                    ? () => onReviewSpecificQuote!(quote)
                                    : null,
                                child: const Text('مراجعة العرض'),
                              ),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
              )
            else if (request.quote != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  'عرض السعر: ${_formatSaudiRiyals(request.quote!.amountHalalas)} — ${request.quote!.scope}',
                  style: TextStyle(
                    color: request.quote!.status == 'proposed'
                        ? const Color(0xFF0B6E69)
                        : const Color(0xFF506764),
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            if (payment != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  '${customerPaymentLabel(payment)}: ${_formatSaudiRiyals(payment.amountHalalas)}',
                  style: TextStyle(
                    color: payment.status == 'cash_collected'
                        ? const Color(0xFF0B6E69)
                        : payment.status == 'refunded'
                        ? const Color(0xFF506764)
                        : const Color(0xFF9A6700),
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            if (request.images.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: RequestImageThumbnails(images: request.images),
              ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 4,
              runSpacing: 4,
              children: [
                if (request.quotes.isEmpty &&
                    request.quote?.status == 'proposed')
                  TextButton(
                    onPressed: onReviewQuote,
                    child: const Text('مراجعة العرض'),
                  ),
                if (request.status == 'completed' && request.rating == null)
                  TextButton(
                    onPressed: onRate,
                    child: const Text('قيّم الخدمة'),
                  ),
                TextButton(
                  onPressed: onSupport,
                  child: const Text('تحتاج مساعدة؟'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class CustomerRequestsPage extends StatefulWidget {
  const CustomerRequestsPage({super.key});

  @override
  State<CustomerRequestsPage> createState() => _CustomerRequestsPageState();
}

class _CustomerRequestsPageState extends State<CustomerRequestsPage> {
  late Future<List<CustomerRequest>> _requests = _load();

  Future<List<CustomerRequest>> _load() async {
    final session = await customerSessionManager.restore();
    if (session == null) throw Exception('Customer session required');
    final response = await http.get(
      moeenApi.endpoint('/my/service-requests'),
      headers: {'Authorization': 'Bearer ${session.token}'},
    );
    if (response.statusCode != 200) throw Exception('Request list failed');
    return (jsonDecode(response.body) as List<dynamic>)
        .map((item) => CustomerRequest.fromJson(item as Map<String, dynamic>))
        .toList();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('طلباتي')),
    body: FutureBuilder<List<CustomerRequest>>(
      future: _requests,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snapshot.hasError) {
          return Center(
            child: FilledButton(
              onPressed: () => setState(() {
                _requests = _load();
              }),
              child: const Text('إعادة المحاولة'),
            ),
          );
        }
        final items = snapshot.data ?? [];
        if (items.isEmpty) {
          return const Center(child: Text('لا توجد طلبات بعد'));
        }
        return ListView(
          padding: const EdgeInsets.all(20),
          children: items
              .map(
                (item) => Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      CustomerRequestCard(
                        request: item,
                        statusLabel: _status(item.status),
                        onReviewQuote: () => _showQuoteDecisionDialog(item),
                        onReviewSpecificQuote: (quote) =>
                            _showQuoteDecisionDialogForQuote(item, quote),
                        onRate: () => _showRatingDialog(item),
                        onSupport: () => _showSupportDialog(item),
                      ),
                      Align(
                        alignment: AlignmentDirectional.centerStart,
                        child: TextButton.icon(
                          onPressed: () => _openRequestDetails(item),
                          icon: const Icon(Icons.arrow_back_rounded),
                          label: const Text('عرض تفاصيل الطلب'),
                        ),
                      ),
                    ],
                  ),
                ),
              )
              .toList(),
        );
      },
    ),
  );

  void _openRequestDetails(CustomerRequest request) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => CustomerRequestDetailsPage(
          request: request,
          statusLabel: _status(request.status),
          onReviewQuote: () => _showQuoteDecisionDialog(request),
          onRate: () => _showRatingDialog(request),
          onSupport: () => _showSupportDialog(request),
        ),
      ),
    );
  }

  Future<void> _showQuoteDecisionDialogForQuote(
    CustomerRequest request,
    CustomerQuote quote,
  ) async {
    final decision = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('مراجعة عرض السعر'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(quote.scope),
            const SizedBox(height: 12),
            Text(
              _formatSaudiRiyals(quote.amountHalalas),
              style: const TextStyle(
                color: Color(0xFF0B6E69),
                fontSize: 22,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 8),
            const Text('لن يبدأ الفني العمل قبل موافقتك على العرض.'),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, 'rejected'),
            child: const Text('رفض العرض'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, 'approved'),
            child: const Text('موافقة'),
          ),
        ],
      ),
    );
    if (decision != null) await _submitQuoteDecision(request, quote, decision);
  }

  Future<void> _showQuoteDecisionDialog(CustomerRequest request) async {
    final quote = request.quote;
    if (quote == null || quote.status != 'proposed') return;
    final decision = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('مراجعة عرض السعر'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(quote.scope),
            const SizedBox(height: 12),
            Text(
              _formatSaudiRiyals(quote.amountHalalas),
              style: const TextStyle(
                color: Color(0xFF0B6E69),
                fontSize: 22,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 8),
            const Text('لن يبدأ الفني العمل قبل موافقتك على العرض.'),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, 'rejected'),
            child: const Text('رفض العرض'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, 'approved'),
            child: const Text('موافقة'),
          ),
        ],
      ),
    );
    if (decision != null) await _submitQuoteDecision(request, quote, decision);
  }

  Future<void> _submitQuoteDecision(
    CustomerRequest request,
    CustomerQuote quote,
    String decision,
  ) async {
    try {
      final session = await customerSessionManager.restore();
      if (session == null) throw Exception('Customer session required');
      final response = await http.post(
        moeenApi.endpoint(
          '/my/service-requests/${request.id}/quotes/${quote.id}/decision',
        ),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ${session.token}',
        },
        body: jsonEncode({'decision': decision}),
      );
      if (!isSuccessfulHttpStatus(response.statusCode)) {
        throw Exception('Quote decision failed');
      }
      if (!mounted) return;
      setState(() {
        _requests = _load();
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            decision == 'approved'
                ? 'تمت الموافقة على عرض السعر'
                : 'تم رفض عرض السعر',
          ),
        ),
      );
    } catch (_) {
      final decisionWasPersisted =
          await quoteDecisionWasPersistedAfterAmbiguousFailure(
            requestId: request.id,
            quoteId: quote.id,
            decision: decision,
            loadRequests: _load,
          );
      if (!mounted) return;
      if (decisionWasPersisted) {
        setState(() {
          _requests = _load();
        });
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              decision == 'approved'
                  ? 'تمت الموافقة على عرض السعر'
                  : 'تم رفض عرض السعر',
            ),
          ),
        );
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('تعذر حفظ القرار، حاول مجددًا')),
      );
    }
  }

  Future<void> _showSupportDialog(CustomerRequest request) async {
    var category = 'quality';
    final comment = TextEditingController();
    final submit = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('كيف يمكننا مساعدتك؟'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              DropdownButtonFormField<String>(
                initialValue: category,
                decoration: const InputDecoration(labelText: 'نوع المشكلة'),
                items: const ['no_show', 'price', 'quality', 'payment', 'other']
                    .map(
                      (value) => DropdownMenuItem(
                        value: value,
                        child: Text(supportCategoryLabel(value)),
                      ),
                    )
                    .toList(),
                onChanged: (value) =>
                    setDialogState(() => category = value ?? category),
              ),
              TextField(
                controller: comment,
                maxLines: 4,
                decoration: const InputDecoration(
                  labelText: 'اكتب تفاصيل المشكلة',
                ),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('إلغاء'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('إرسال للدعم'),
            ),
          ],
        ),
      ),
    );
    if (submit == true) {
      await _submitSupportTicket(request.id, category, comment.text);
    }
    comment.dispose();
  }

  Future<void> _submitSupportTicket(
    String requestId,
    String category,
    String comment,
  ) async {
    if (comment.trim().length < 3) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('يرجى كتابة تفاصيل المشكلة')),
      );
      return;
    }
    try {
      final session = await customerSessionManager.restore();
      if (session == null) throw Exception('Customer session required');
      final response = await http.post(
        moeenApi.endpoint('/my/service-requests/$requestId/support'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ${session.token}',
        },
        body: jsonEncode({'category': category, 'comment': comment.trim()}),
      );
      if (response.statusCode != 201) throw Exception('Support ticket failed');
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('تم إرسال طلب الدعم، سنتواصل معك قريباً')),
      );
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('تعذر إرسال طلب الدعم، حاول مجددًا')),
        );
      }
    }
  }

  Future<void> _showRatingDialog(CustomerRequest request) async {
    var rating = 5;
    final comment = TextEditingController();
    final submit = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('قيّم الخدمة'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Wrap(
                children: List.generate(
                  5,
                  (index) => IconButton(
                    onPressed: () => setDialogState(() => rating = index + 1),
                    icon: Icon(
                      index < rating
                          ? Icons.star_rounded
                          : Icons.star_outline_rounded,
                    ),
                    color: const Color(0xFFE5A000),
                  ),
                ),
              ),
              TextField(
                controller: comment,
                maxLines: 3,
                decoration: const InputDecoration(labelText: 'تعليق اختياري'),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('إلغاء'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('إرسال التقييم'),
            ),
          ],
        ),
      ),
    );
    if (submit == true) await _submitRating(request.id, rating, comment.text);
    comment.dispose();
  }

  Future<void> _submitRating(
    String requestId,
    int rating,
    String comment,
  ) async {
    try {
      final session = await customerSessionManager.restore();
      if (session == null) throw Exception('Customer session required');
      final response = await http.post(
        moeenApi.endpoint('/my/service-requests/$requestId/rating'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ${session.token}',
        },
        body: jsonEncode({'rating': rating, 'comment': comment}),
      );
      if (response.statusCode != 201) throw Exception('Rating failed');
      if (!mounted) return;
      setState(() {
        _requests = _load();
      });
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('شكرًا لتقييمك')));
    } catch (_) {
      final ratingWasPersisted = await ratingWasPersistedAfterAmbiguousFailure(
        requestId: requestId,
        loadRequests: _load,
      );
      if (!mounted) return;
      if (ratingWasPersisted) {
        setState(() {
          _requests = _load();
        });
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('شكرًا لتقييمك')));
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('تعذر إرسال التقييم، حاول مجددًا')),
      );
    }
  }

  String _status(String status) =>
      {
        'pending_dispatch': 'بانتظار التوزيع',
        'assigned': 'تم التعيين',
        'on_the_way': 'الفني في الطريق',
        'in_progress': 'قيد التنفيذ',
        'completed': 'مكتمل',
        'cancelled': 'ملغي',
      }[status] ??
      status;
}

class FlutterSecureSessionStore implements SessionKeyValueStore {
  const FlutterSecureSessionStore();
  static const _storage = FlutterSecureStorage();
  @override
  Future<void> deleteAll() => _storage.deleteAll();
  @override
  Future<String?> read(String key) => _storage.read(key: key);
  @override
  Future<void> write(String key, String value) =>
      _storage.write(key: key, value: value);
}

final customerSessionManager = CustomerSessionManager(
  const FlutterSecureSessionStore(),
);

class CustomerLoginPage extends StatefulWidget {
  const CustomerLoginPage({super.key});

  @override
  State<CustomerLoginPage> createState() => _CustomerLoginPageState();
}

class _CustomerLoginPageState extends State<CustomerLoginPage> {
  final phone = TextEditingController();
  bool loading = false;

  Future<void> submit() async {
    final local = phone.text.trim();
    final normalized = local.startsWith('+966')
        ? local
        : '+966${local.startsWith('0') ? local.substring(1) : local}';

    if (!RegExp(r'^\+9665\d{8}$').hasMatch(normalized)) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('أدخل رقم جوال سعودي صحيح')));
      return;
    }

    setState(() => loading = true);
    try {
      final response = await http
          .post(
            moeenApi.endpoint('/auth/request-otp'),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode({'phone': normalized}),
          )
          .timeout(const Duration(seconds: 15));
      if (response.statusCode != 201) {
        throw Exception('OTP request failed: ${response.statusCode}');
      }

      final body = jsonDecode(response.body) as Map<String, dynamic>;
      final challengeId = body['challengeId'];
      if (challengeId is! String || challengeId.isEmpty) {
        throw const FormatException('Missing OTP challenge id');
      }

      if (!mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => OtpPage(challengeId: challengeId, phone: normalized),
        ),
      );
    } on MoeenApiConfigurationException {
      _showError('لم يتم إعداد رابط خادم معين لهذا التطبيق.');
    } on TimeoutException {
      _showError('تعذر الوصول إلى خادم معين. حاول مرة أخرى.');
    } on http.ClientException {
      _showError(
        'تعذر الوصول إلى الخادم. تأكد أن الهاتف والحاسوب على الشبكة نفسها.',
      );
    } catch (_) {
      _showError('تعذر طلب رمز التحقق. حاول مرة أخرى.');
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  void _showError(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  void dispose() {
    phone.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('تسجيل الدخول')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 480),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Icon(
                  Icons.phone_android_rounded,
                  size: 64,
                  color: Color(0xFF0B6E69),
                ),
                const SizedBox(height: 24),
                const Text(
                  'أهلاً بك في معين',
                  style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 24),
                TextField(
                  controller: phone,
                  keyboardType: TextInputType.phone,
                  textInputAction: TextInputAction.done,
                  onSubmitted: (_) => loading ? null : submit(),
                  decoration: const InputDecoration(
                    labelText: 'رقم الجوال',
                    hintText: '05xxxxxxxx',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: loading ? null : submit,
                  child: Text(loading ? 'جارٍ الإرسال...' : 'إرسال رمز التحقق'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class OtpPage extends StatefulWidget {
  const OtpPage({super.key, required this.challengeId, required this.phone});
  final String challengeId;
  final String phone;
  @override
  State<OtpPage> createState() => _OtpPageState();
}

class _OtpPageState extends State<OtpPage> {
  final otp = TextEditingController();
  bool loading = false;
  Future<void> verify() async {
    setState(() => loading = true);
    try {
      final r = await http.post(
        moeenApi.endpoint('/auth/verify-otp'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'challengeId': widget.challengeId,
          'otp': otp.text.trim(),
        }),
      );
      if (r.statusCode != 201) throw Exception();
      final body = jsonDecode(r.body) as Map<String, dynamic>;
      await customerSessionManager.save(
        token: body['token'] as String,
        customerId: (body['customer'] as Map<String, dynamic>)['id'] as String,
      );
      if (!mounted) return;
      Navigator.of(context).pushAndRemoveUntil(
        MaterialPageRoute<void>(builder: (_) => const MoeenHomePage()),
        (route) => false,
      );
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('رمز التحقق غير صحيح')));
      }
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  @override
  void dispose() {
    otp.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext c) => Scaffold(
    appBar: AppBar(title: const Text('تأكيد الجوال')),
    body: Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 480),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text('أدخل الرمز المرسل إلى ${widget.phone}'),
              const SizedBox(height: 20),
              TextField(
                controller: otp,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                  labelText: 'رمز التحقق',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 16),
              FilledButton(
                onPressed: loading ? null : verify,
                child: const Text('تحقق ودخول'),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}
