import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart' as geolocator;

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

ServiceLocationMode serviceLocationModeFromRaw(String value) => switch (value) {
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

enum CustomerLocationPermission {
  granted,
  denied,
  permanentlyDenied,
  unavailable,
}

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
      geolocator.LocationPermission.whileInUse =>
        CustomerLocationPermission.granted,
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

/// Confirmed booking-form state for one selected service location.
///
/// Draft camera movement belongs to the full-screen picker and never enters
/// this controller. This module performs no geocoding, place search, movement
/// history, storage, logging, or analytics.
class ServiceLocationController extends ChangeNotifier {
  ServiceLocationPickerStatus _status = ServiceLocationPickerStatus.noSelection;
  ServiceLocationInput? _selection;

  ServiceLocationPickerStatus get status => _status;
  ServiceLocationInput? get selection => _selection;
  bool get hasSelection => _selection != null;

  /// Applies the result of an explicit full-screen picker confirmation.
  ///
  /// Address validity is intentionally independent from point confirmation:
  /// the customer can confirm the point first, then enter or edit the existing
  /// manual address field without being forced to confirm the point again.
  bool applyConfirmedPoint(
    ServiceLocationPoint point,
    ServiceLocationSource source,
  ) {
    if (!point.isValid) return false;
    _selection = ServiceLocationInput(
      point: point,
      displayAddress: _selection?.displayAddress ?? '',
      source: source,
      confirmed: true,
    );
    _setStatus(ServiceLocationPickerStatus.confirmed);
    return true;
  }

  void updateDisplayAddress(String value) {
    final current = _selection;
    if (current == null || value == current.displayAddress) return;
    _selection = current.copyWith(displayAddress: value);
    notifyListeners();
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
