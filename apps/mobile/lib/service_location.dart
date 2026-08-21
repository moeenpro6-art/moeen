import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:geolocator/geolocator.dart' as geolocator;
import 'package:latlong2/latlong.dart';

/// A compile-time UX flag aligned with the API's service-location mode.
///
/// The API remains authoritative for its Pilot bounds and validation. The app
/// uses this only to decide whether to show/require the customer picker:
///
///   flutter run --dart-define=MOEEN_SERVICE_LOCATION_MODE=optional
///
/// Unconfigured builds remain safely on the legacy address-only flow.
abstract final class CustomerServiceLocationConfig {
  static final ServiceLocationMode mode = serviceLocationModeFromRaw(
    const String.fromEnvironment(
      'MOEEN_SERVICE_LOCATION_MODE',
      defaultValue: 'off',
    ),
  );
}

enum ServiceLocationMode { off, optional, required }

ServiceLocationMode serviceLocationModeFromRaw(String value) =>
    switch (value) {
      'optional' => ServiceLocationMode.optional,
      'required' => ServiceLocationMode.required,
      _ => ServiceLocationMode.off,
    };

enum ServiceLocationSource { currentLocation, mapPin }

extension on ServiceLocationSource {
  String get wireValue => switch (this) {
    ServiceLocationSource.currentLocation => 'current_location',
    ServiceLocationSource.mapPin => 'map_pin',
  };
}

/// A WGS-84 point used for one customer-selected service location only.
class ServiceLocationPoint {
  const ServiceLocationPoint({required this.latitude, required this.longitude});

  final double latitude;
  final double longitude;

  bool get isValid =>
      latitude.isFinite &&
      longitude.isFinite &&
      latitude >= -90 &&
      latitude <= 90 &&
      longitude >= -180 &&
      longitude <= 180;

  LatLng get latLng => LatLng(latitude, longitude);
}

/// Exact frontend representation of the Phase 1 ServiceLocationInput contract.
/// It deliberately has no client-controlled `confirmedAt` value.
class ServiceLocationInput {
  const ServiceLocationInput({
    required this.point,
    required this.displayAddress,
    required this.source,
    required this.confirmed,
  });

  final ServiceLocationPoint point;
  final String displayAddress;
  final ServiceLocationSource source;
  final bool confirmed;

  bool get isValid =>
      point.isValid &&
      displayAddress.trim().length >= 3 &&
      displayAddress.trim().length <= 240 &&
      confirmed;

  Map<String, dynamic> toJson() => {
    'point': {'latitude': point.latitude, 'longitude': point.longitude},
    'displayAddress': displayAddress.trim(),
    'source': source.wireValue,
    'confirmed': confirmed,
  };

  /// Stable, local-only request fingerprint input. It is never logged,
  /// persisted, sent to analytics, or retained beyond this booking draft.
  String get fingerprint => jsonEncode(toJson());

  ServiceLocationInput copyWith({
    ServiceLocationPoint? point,
    String? displayAddress,
    ServiceLocationSource? source,
    bool? confirmed,
  }) => ServiceLocationInput(
    point: point ?? this.point,
    displayAddress: displayAddress ?? this.displayAddress,
    source: source ?? this.source,
    confirmed: confirmed ?? this.confirmed,
  );
}

enum ServiceLocationPickerStatus {
  noSelection,
  locating,
  permissionDenied,
  permissionPermanentlyDenied,
  gpsUnavailable,
  selected,
  confirmed,
}

enum CustomerLocationPermission { granted, denied, permanentlyDenied, unavailable }

/// Isolates foreground location platform APIs from picker state and tests.
abstract class CustomerLocationPlatform {
  Future<CustomerLocationPermission> requestForegroundPermission();
  Future<ServiceLocationPoint> getCurrentPosition();
  Future<bool> openAppSettings();
}

class GeolocatorCustomerLocationPlatform implements CustomerLocationPlatform {
  const GeolocatorCustomerLocationPlatform();

  @override
  Future<CustomerLocationPermission> requestForegroundPermission() async {
    if (!await geolocator.Geolocator.isLocationServiceEnabled()) {
      return CustomerLocationPermission.unavailable;
    }
    var permission = await geolocator.Geolocator.checkPermission();
    if (permission == geolocator.LocationPermission.denied) {
      permission = await geolocator.Geolocator.requestPermission();
    }
    return switch (permission) {
      geolocator.LocationPermission.always ||
      geolocator.LocationPermission.whileInUse => CustomerLocationPermission.granted,
      geolocator.LocationPermission.deniedForever =>
        CustomerLocationPermission.permanentlyDenied,
      geolocator.LocationPermission.denied => CustomerLocationPermission.denied,
      _ => CustomerLocationPermission.unavailable,
    };
  }

  @override
  Future<ServiceLocationPoint> getCurrentPosition() async {
    final position = await geolocator.Geolocator.getCurrentPosition(
      locationSettings: const geolocator.LocationSettings(
        accuracy: geolocator.LocationAccuracy.medium,
        timeLimit: Duration(seconds: 12),
      ),
    );
    return ServiceLocationPoint(
      latitude: position.latitude,
      longitude: position.longitude,
    );
  }

  @override
  Future<bool> openAppSettings() => geolocator.Geolocator.openAppSettings();
}

/// Local picker state. It holds at most the one draft location being edited;
/// no movement history, background tracking, storage, logging, or analytics.
class ServiceLocationController extends ChangeNotifier {
  // The public `platform` argument is intentionally retained as a test seam.
  // ignore: prefer_initializing_formals
  ServiceLocationController({CustomerLocationPlatform? platform}) : _platform = platform;

  final CustomerLocationPlatform? _platform;
  ServiceLocationPickerStatus _status = ServiceLocationPickerStatus.noSelection;
  ServiceLocationInput? _selection;

  ServiceLocationPickerStatus get status => _status;
  ServiceLocationInput? get selection => _selection;
  bool get hasSelection => _selection != null;

  Future<void> useCurrentLocation() async {
    final platform = _platform;
    if (platform == null) {
      _setStatus(ServiceLocationPickerStatus.gpsUnavailable);
      return;
    }
    _setStatus(ServiceLocationPickerStatus.locating);
    try {
      switch (await platform.requestForegroundPermission()) {
        case CustomerLocationPermission.granted:
          final point = await platform.getCurrentPosition();
          if (!point.isValid) {
            _setStatus(ServiceLocationPickerStatus.gpsUnavailable);
            return;
          }
          seedCurrentLocation(point);
        case CustomerLocationPermission.denied:
          _setStatus(ServiceLocationPickerStatus.permissionDenied);
        case CustomerLocationPermission.permanentlyDenied:
          _setStatus(ServiceLocationPickerStatus.permissionPermanentlyDenied);
        case CustomerLocationPermission.unavailable:
          _setStatus(ServiceLocationPickerStatus.gpsUnavailable);
      }
    } on TimeoutException {
      _setStatus(ServiceLocationPickerStatus.gpsUnavailable);
    } catch (_) {
      // The manual map-pin route remains available for all GPS errors.
      _setStatus(ServiceLocationPickerStatus.gpsUnavailable);
    }
  }

  Future<void> openLocationSettings() async {
    final platform = _platform;
    if (platform == null) return;
    try {
      await platform.openAppSettings();
    } catch (_) {
      // Opening settings is optional assistance, never a blocker to manual pinning.
    }
  }

  void seedCurrentLocation(ServiceLocationPoint point) {
    if (!point.isValid) {
      _setStatus(ServiceLocationPickerStatus.gpsUnavailable);
      return;
    }
    _selection = ServiceLocationInput(
      point: point,
      displayAddress: _selection?.displayAddress ?? '',
      source: ServiceLocationSource.currentLocation,
      confirmed: false,
    );
    _setStatus(ServiceLocationPickerStatus.selected);
  }

  void selectMapPin(ServiceLocationPoint point) {
    if (!point.isValid) return;
    _selection = ServiceLocationInput(
      point: point,
      displayAddress: _selection?.displayAddress ?? '',
      source: ServiceLocationSource.mapPin,
      confirmed: false,
    );
    _setStatus(ServiceLocationPickerStatus.selected);
  }

  void updateDisplayAddress(String value) {
    final current = _selection;
    if (current == null) return;
    final normalized = value.trim();
    if (normalized == current.displayAddress.trim()) return;
    _selection = current.copyWith(displayAddress: value, confirmed: false);
    _setStatus(ServiceLocationPickerStatus.selected);
  }

  bool confirm() {
    final current = _selection;
    if (current == null || !current.point.isValid) return false;
    final address = current.displayAddress.trim();
    if (address.length < 3 || address.length > 240) return false;
    _selection = current.copyWith(displayAddress: address, confirmed: true);
    _setStatus(ServiceLocationPickerStatus.confirmed);
    return true;
  }

  void clear() {
    _selection = null;
    _setStatus(ServiceLocationPickerStatus.noSelection);
  }

  void _setStatus(ServiceLocationPickerStatus value) {
    _status = value;
    notifyListeners();
  }
}

String? validateLocationForSubmission({
  required ServiceLocationMode mode,
  required ServiceLocationInput? selection,
}) {
  if (mode == ServiceLocationMode.off || selection == null) {
    return mode == ServiceLocationMode.required
        ? 'حدد موقع الخدمة ثم أكد اختياره قبل إرسال الطلب.'
        : null;
  }
  if (!selection.isValid) {
    return 'أكد موقع الخدمة والعنوان أو أزل اختيار الموقع للمتابعة.';
  }
  return null;
}

ServiceLocationInput? locationForSubmission({
  required ServiceLocationMode mode,
  required ServiceLocationInput? selection,
}) => mode == ServiceLocationMode.off || !((selection?.isValid) ?? false)
    ? null
    : selection;

/// Builds the shared JSON contract used by the zero-image request path. The
/// same [location] is JSON encoded in multipart form by request_images.dart.
Map<String, dynamic> buildServiceRequestPayload({
  required String serviceId,
  required String address,
  required String details,
  required String timing,
  ServiceLocationInput? location,
}) => {
  'serviceId': serviceId,
  'address': address,
  'details': details,
  'timing': timing,
  if (location != null) 'location': location.toJson(),
};

/// Map renderer with an intentionally provider-neutral contract. It uses the
/// public OpenStreetMap raster tiles through flutter_map; no API key, geocoder,
/// place search, routing, or navigation SDK is configured. Production traffic
/// must remain within the OpenStreetMap tile-usage policy; this pilot does not
/// embed a map-provider credential or introduce any geocoding dependency.
class ServiceLocationPicker extends StatefulWidget {
  const ServiceLocationPicker({
    super.key,
    required this.controller,
    required this.mode,
    required this.addressController,
    required this.onConfirmWithoutAddress,
  });

  final ServiceLocationController controller;
  final ServiceLocationMode mode;
  final TextEditingController addressController;
  final VoidCallback onConfirmWithoutAddress;

  @override
  State<ServiceLocationPicker> createState() => _ServiceLocationPickerState();
}

class _ServiceLocationPickerState extends State<ServiceLocationPicker> {
  static const _buraidah = LatLng(26.359123, 43.981988);
  final MapController _mapController = MapController();
  ServiceLocationPoint? _lastCenteredPoint;

  @override
  void dispose() {
    _mapController.dispose();
    super.dispose();
  }

  void _moveMapToSelectedPin() {
    final point = widget.controller.selection?.point;
    if (point == null || _lastCenteredPoint == point) return;
    _lastCenteredPoint = point;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _mapController.move(point.latLng, 16);
    });
  }

  Future<void> _useCurrentLocation() async {
    await widget.controller.useCurrentLocation();
    if (!mounted || widget.controller.selection == null) return;
    widget.controller.updateDisplayAddress(widget.addressController.text);
  }

  void _selectMapPin(LatLng center) {
    widget.controller.selectMapPin(
      ServiceLocationPoint(
        latitude: center.latitude,
        longitude: center.longitude,
      ),
    );
    widget.controller.updateDisplayAddress(widget.addressController.text);
  }

  @override
  Widget build(BuildContext context) {
    if (widget.mode == ServiceLocationMode.off) return const SizedBox.shrink();
    return AnimatedBuilder(
      animation: widget.controller,
      builder: (context, _) {
        _moveMapToSelectedPin();
        final controller = widget.controller;
        final selection = controller.selection;
        final status = controller.status;
        return Semantics(
          container: true,
          label: 'اختيار موقع الخدمة',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 16),
              Text(
                'حدد موقع الخدمة على الخريطة',
                style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 6),
              const Text(
                'حرّك الخريطة لتغيير موضع الدبوس، ثم أكّد الموقع بعد إدخال العنوان أو المعلم القريب.',
                style: TextStyle(color: Color(0xFF66807D), height: 1.4),
              ),
              const SizedBox(height: 12),
              OutlinedButton.icon(
                onPressed: status == ServiceLocationPickerStatus.locating
                    ? null
                    : _useCurrentLocation,
                icon: status == ServiceLocationPickerStatus.locating
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.my_location_rounded),
                label: const Text('استخدام موقعي الحالي'),
                style: OutlinedButton.styleFrom(
                  minimumSize: const Size.fromHeight(48),
                ),
              ),
              if (status == ServiceLocationPickerStatus.permissionDenied) ...[
                const SizedBox(height: 8),
                const _LocationHelpMessage(
                  icon: Icons.location_off_outlined,
                  message: 'لم نتمكن من استخدام موقعك. يمكنك تحديد الدبوس يدوياً على الخريطة.',
                ),
              ],
              if (status == ServiceLocationPickerStatus.permissionPermanentlyDenied) ...[
                const SizedBox(height: 8),
                const _LocationHelpMessage(
                  icon: Icons.settings_outlined,
                  message: 'تم إيقاف إذن الموقع. يمكنك فتح إعدادات التطبيق أو تحديد الدبوس يدوياً.',
                ),
                TextButton.icon(
                  onPressed: controller.openLocationSettings,
                  icon: const Icon(Icons.open_in_new_rounded),
                  label: const Text('فتح إعدادات التطبيق'),
                ),
              ],
              if (status == ServiceLocationPickerStatus.gpsUnavailable) ...[
                const SizedBox(height: 8),
                const _LocationHelpMessage(
                  icon: Icons.gps_off_rounded,
                  message: 'تعذر الحصول على موقعك الحالي. يمكنك تحديد الدبوس يدوياً على الخريطة.',
                ),
              ],
              const SizedBox(height: 12),
              ClipRRect(
                borderRadius: BorderRadius.circular(16),
                child: SizedBox(
                  height: 250,
                  child: Stack(
                    alignment: Alignment.center,
                    children: [
                      FlutterMap(
                        mapController: _mapController,
                        options: MapOptions(
                          initialCenter: selection?.point.latLng ?? _buraidah,
                          initialZoom: selection == null ? 12 : 16,
                          onPositionChanged: (camera, hasGesture) {
                            if (!hasGesture) return;
                            _selectMapPin(camera.center);
                          },
                        ),
                        children: [
                          TileLayer(
                            urlTemplate:
                                'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                            userAgentPackageName: 'com.moeen.moeen_mobile',
                          ),
                          RichAttributionWidget(
                            attributions: [
                              TextSourceAttribution(
                                'OpenStreetMap contributors',
                              ),
                            ],
                          ),
                        ],
                      ),
                      IgnorePointer(
                        child: Icon(
                          Icons.location_on_rounded,
                          size: 46,
                          color: Theme.of(context).colorScheme.primary,
                          shadows: const [Shadow(blurRadius: 4, color: Colors.black38)],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 8),
              const Text(
                'الدبوس في وسط الخريطة. حرّك الخريطة لوضعه على موقع الخدمة.',
                style: TextStyle(color: Color(0xFF66807D), fontSize: 12),
              ),
              const SizedBox(height: 12),
              if (selection == null)
                const _LocationHelpMessage(
                  icon: Icons.info_outline_rounded,
                  message: 'اختر موقعاً من الخريطة أو استخدم موقعك الحالي.',
                )
              else if (status == ServiceLocationPickerStatus.confirmed)
                const _LocationHelpMessage(
                  icon: Icons.verified_rounded,
                  message: 'تم تأكيد موقع الخدمة. يمكنك تعديل الخريطة أو العنوان عند الحاجة.',
                  color: Color(0xFF0B6E69),
                )
              else
                const _LocationHelpMessage(
                  icon: Icons.info_outline_rounded,
                  message: 'أدخل العنوان أو المعلم القريب أعلاه ثم أكّد موقع الخدمة.',
                ),
              const SizedBox(height: 10),
              FilledButton.icon(
                onPressed: selection == null
                    ? null
                    : () {
                        if (!controller.confirm()) {
                          widget.onConfirmWithoutAddress();
                        }
                      },
                icon: const Icon(Icons.check_circle_outline_rounded),
                label: const Text('تأكيد موقع الخدمة'),
                style: FilledButton.styleFrom(
                  minimumSize: const Size.fromHeight(50),
                ),
              ),
              if (widget.mode == ServiceLocationMode.optional &&
                  selection != null) ...[
                Align(
                  alignment: AlignmentDirectional.centerStart,
                  child: TextButton.icon(
                    onPressed: controller.clear,
                    icon: const Icon(Icons.clear_rounded),
                    label: const Text('متابعة الطلب بدون موقع محدد'),
                  ),
                ),
              ],
            ],
          ),
        );
      },
    );
  }
}

class _LocationHelpMessage extends StatelessWidget {
  const _LocationHelpMessage({
    required this.icon,
    required this.message,
    this.color = const Color(0xFF66807D),
  });

  final IconData icon;
  final String message;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(10),
    decoration: BoxDecoration(
      color: color.withValues(alpha: 0.08),
      borderRadius: BorderRadius.circular(12),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: color, size: 20),
        const SizedBox(width: 8),
        Expanded(child: Text(message, style: TextStyle(color: color, height: 1.35))),
      ],
    ),
  );
}
