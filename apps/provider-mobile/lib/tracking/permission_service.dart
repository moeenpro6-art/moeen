import 'package:geolocator/geolocator.dart' as geolocator;

/// Location-permission states needed by provider-tracking UX.
enum LocationPermissionStatus { granted, denied, permanentlyDenied }

/// Platform boundary that lets this service be tested without touching GPS.
///
/// It exposes permission/service state only. No method obtains a coordinate.
abstract interface class LocationPermissionPlatform {
  Future<geolocator.LocationPermission> checkPermission();
  Future<bool> isLocationServiceEnabled();
  Future<geolocator.LocationPermission> requestPermission();
}

class GeolocatorLocationPermissionPlatform
    implements LocationPermissionPlatform {
  const GeolocatorLocationPermissionPlatform();

  @override
  Future<geolocator.LocationPermission> checkPermission() =>
      geolocator.Geolocator.checkPermission();

  @override
  Future<bool> isLocationServiceEnabled() =>
      geolocator.Geolocator.isLocationServiceEnabled();

  @override
  Future<geolocator.LocationPermission> requestPermission() =>
      geolocator.Geolocator.requestPermission();
}

/// Checks and requests location access without ever acquiring a location.
///
/// The application must call [requestPermission] only from an explicit tracking
/// or navigation action. Constructing this service and calling its check methods
/// never causes a system prompt.
class PermissionService {
  PermissionService({LocationPermissionPlatform? platform})
    : _platform = platform ?? const GeolocatorLocationPermissionPlatform();

  final LocationPermissionPlatform _platform;

  Future<LocationPermissionStatus> checkLocationPermission() async =>
      _toStatus(await _platform.checkPermission());

  Future<bool> isLocationServiceEnabled() =>
      _platform.isLocationServiceEnabled();

  /// Shows the native permission prompt when an explicit user flow requests it.
  /// This does not read or retain a device position.
  Future<LocationPermissionStatus> requestPermission() async =>
      _toStatus(await _platform.requestPermission());

  LocationPermissionStatus _toStatus(
    geolocator.LocationPermission permission,
  ) => switch (permission) {
    geolocator.LocationPermission.always ||
    geolocator.LocationPermission.whileInUse =>
      LocationPermissionStatus.granted,
    geolocator.LocationPermission.deniedForever =>
      LocationPermissionStatus.permanentlyDenied,
    geolocator.LocationPermission.denied ||
    geolocator.LocationPermission.unableToDetermine =>
      LocationPermissionStatus.denied,
  };
}
