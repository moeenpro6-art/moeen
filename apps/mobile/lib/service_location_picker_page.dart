import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mapbox_maps_flutter/mapbox_maps_flutter.dart' as mapbox;

import 'service_location.dart';

/// Build-time public token used only by the Mapbox native map renderer.
///
/// The customer app performs no geocoding. Inject this public renderer token
/// at build time; never persist it in source or client-side storage.
abstract final class CustomerMapboxConfig {
  static const accessToken = String.fromEnvironment('MAPBOX_ACCESS_TOKEN');
}

class ServiceLocationPickerResult {
  const ServiceLocationPickerResult({
    required this.point,
    required this.source,
  });

  final ServiceLocationPoint point;
  final ServiceLocationSource source;
}

abstract class ServiceLocationMapCamera {
  Future<void> moveTo(ServiceLocationPoint point);

  Future<ServiceLocationPoint> snapshotCurrentCenter();
}

typedef ServiceLocationCameraChanged =
    void Function(ServiceLocationPoint point, int intentGeneration);
typedef ServiceLocationManualCameraIntent = int? Function();

typedef ServiceLocationMapSurfaceBuilder =
    Widget Function(
      BuildContext context, {
      required ServiceLocationPoint initialPoint,
      required ServiceLocationCameraChanged onCameraChanged,
      required ServiceLocationManualCameraIntent onManualCameraMove,
      required ValueChanged<ServiceLocationMapCamera> onCameraReady,
    });

typedef ServiceLocationMapWidgetBuilder =
    Widget Function(mapbox.ViewportState initialViewport);

/// Full-screen manual location picker with route-local draft state.
///
/// The page never receives or mutates [ServiceLocationController]. Camera
/// movement, GPS results, and permission failures stay ephemeral until the
/// customer explicitly confirms and a result is returned to the booking form.
class ServiceLocationPickerPage extends StatefulWidget {
  const ServiceLocationPickerPage({
    super.key,
    this.initialPoint,
    this.initialSource,
    CustomerLocationPlatform? locationPlatform,
    this.mapSurfaceBuilder = buildMapboxServiceLocationSurface,
  }) : locationPlatform =
           locationPlatform ?? const GeolocatorCustomerLocationPlatform();

  final ServiceLocationPoint? initialPoint;
  final ServiceLocationSource? initialSource;
  final CustomerLocationPlatform locationPlatform;
  final ServiceLocationMapSurfaceBuilder mapSurfaceBuilder;

  @override
  State<ServiceLocationPickerPage> createState() =>
      _ServiceLocationPickerPageState();
}

class _ServiceLocationPickerPageState extends State<ServiceLocationPickerPage> {
  static const _buraidah = ServiceLocationPoint(
    latitude: 26.359123,
    longitude: 43.981988,
  );

  late final ServiceLocationPoint _initialMapPoint;
  late ServiceLocationPoint _draftPoint;
  late ServiceLocationSource _draftSource;
  ServiceLocationPickerStatus _status = ServiceLocationPickerStatus.selected;
  ServiceLocationMapCamera? _mapCamera;
  bool _hasFinished = false;
  bool _isConfirming = false;
  int _intentGeneration = 0;

  @override
  void initState() {
    super.initState();
    _initialMapPoint = widget.initialPoint ?? _buraidah;
    _draftPoint = _initialMapPoint;
    _draftSource = widget.initialSource ?? ServiceLocationSource.mapPin;
  }

  void _updateDraftFromCamera(
    ServiceLocationPoint point,
    int intentGeneration,
  ) {
    if (!point.isValid ||
        !mounted ||
        _hasFinished ||
        _isConfirming ||
        _isLocating ||
        intentGeneration != _intentGeneration) {
      return;
    }
    setState(() {
      _draftPoint = point;
      _draftSource = ServiceLocationSource.mapPin;
      _status = ServiceLocationPickerStatus.selected;
    });
  }

  int? _markManualCameraIntent() {
    if (!mounted || _hasFinished || _isConfirming || _isLocating) return null;
    _intentGeneration += 1;
    if (_status != ServiceLocationPickerStatus.selected ||
        _draftSource != ServiceLocationSource.mapPin) {
      setState(() {
        _draftSource = ServiceLocationSource.mapPin;
        _status = ServiceLocationPickerStatus.selected;
      });
    }
    return _intentGeneration;
  }

  Future<void> _useCurrentLocation() async {
    if (_status == ServiceLocationPickerStatus.locating) return;
    final intentGeneration = ++_intentGeneration;
    setState(() => _status = ServiceLocationPickerStatus.locating);
    try {
      final permission = await widget.locationPlatform
          .requestForegroundPermission();
      if (!_ownsIntent(intentGeneration)) return;
      switch (permission) {
        case CustomerLocationPermission.granted:
          final point = await widget.locationPlatform.getCurrentPosition();
          if (!_ownsIntent(intentGeneration)) return;
          if (!point.isValid) {
            setState(
              () => _status = ServiceLocationPickerStatus.gpsUnavailable,
            );
            return;
          }

          final mapCamera = _mapCamera;
          if (mapCamera == null) {
            setState(
              () => _status = ServiceLocationPickerStatus.gpsUnavailable,
            );
            return;
          }

          try {
            await mapCamera.moveTo(point);
            if (!_ownsIntent(intentGeneration)) return;
            final visiblePoint = await mapCamera.snapshotCurrentCenter();
            if (!_ownsIntent(intentGeneration)) return;
            if (!visiblePoint.isValid) {
              setState(
                () => _status = ServiceLocationPickerStatus.gpsUnavailable,
              );
              return;
            }
            if (!_samePoint(visiblePoint, point)) {
              setState(
                () => _status = ServiceLocationPickerStatus.gpsUnavailable,
              );
              return;
            }
            setState(() {
              _draftPoint = visiblePoint;
              _draftSource = ServiceLocationSource.currentLocation;
              _status = ServiceLocationPickerStatus.selected;
            });
          } catch (_) {
            if (_ownsIntent(intentGeneration)) {
              setState(
                () => _status = ServiceLocationPickerStatus.gpsUnavailable,
              );
            }
          }
        case CustomerLocationPermission.denied:
          setState(
            () => _status = ServiceLocationPickerStatus.permissionDenied,
          );
        case CustomerLocationPermission.permanentlyDenied:
          setState(
            () => _status =
                ServiceLocationPickerStatus.permissionPermanentlyDenied,
          );
        case CustomerLocationPermission.unavailable:
          setState(() => _status = ServiceLocationPickerStatus.gpsUnavailable);
      }
    } on TimeoutException {
      if (_ownsIntent(intentGeneration)) {
        setState(() => _status = ServiceLocationPickerStatus.gpsUnavailable);
      }
    } catch (_) {
      if (_ownsIntent(intentGeneration)) {
        setState(() => _status = ServiceLocationPickerStatus.gpsUnavailable);
      }
    }
  }

  bool _ownsIntent(int generation) =>
      mounted &&
      !_hasFinished &&
      !_isConfirming &&
      generation == _intentGeneration;

  bool get _isLocating => _status == ServiceLocationPickerStatus.locating;

  Future<void> _openLocationSettings() async {
    try {
      await widget.locationPlatform.openAppSettings();
    } catch (_) {
      // Settings are optional assistance; manual pinning always remains usable.
    }
  }

  void _cancel() {
    if (_hasFinished) return;
    _intentGeneration += 1;
    _hasFinished = true;
    Navigator.of(context).pop();
  }

  void _handleRoutePop(bool didPop, ServiceLocationPickerResult? result) {
    if (!didPop || _hasFinished) return;
    _intentGeneration += 1;
    _hasFinished = true;
  }

  Future<void> _confirm() async {
    if (_hasFinished || _isConfirming || _isLocating) return;
    _intentGeneration += 1;
    final fallbackPoint = _draftPoint;
    final fallbackSource = _draftSource;
    setState(() => _isConfirming = true);

    var confirmedPoint = fallbackPoint;
    var confirmedSource = fallbackSource;
    try {
      final visiblePoint = await _mapCamera?.snapshotCurrentCenter();
      if (visiblePoint != null && visiblePoint.isValid) {
        confirmedPoint = visiblePoint;
        if (!_samePoint(visiblePoint, fallbackPoint)) {
          confirmedSource = ServiceLocationSource.mapPin;
        }
      }
    } catch (_) {
      // Fall back to the last valid camera draft if the native map is gone.
    }

    if (!mounted || _hasFinished) return;
    _hasFinished = true;
    Navigator.of(context).pop(
      ServiceLocationPickerResult(
        point: confirmedPoint,
        source: confirmedSource,
      ),
    );
  }

  @override
  Widget build(BuildContext context) => PopScope<ServiceLocationPickerResult>(
    onPopInvokedWithResult: _handleRoutePop,
    child: Directionality(
      textDirection: TextDirection.rtl,
      child: Scaffold(
        appBar: AppBar(
          leading: IconButton(
            tooltip: 'رجوع',
            onPressed: _cancel,
            icon: const Icon(Icons.arrow_forward_rounded),
          ),
          title: const Text('تحديد موقع الخدمة'),
          actions: [
            TextButton(onPressed: _cancel, child: const Text('إلغاء')),
            const SizedBox(width: 8),
          ],
        ),
        body: Stack(
          fit: StackFit.expand,
          children: [
            IgnorePointer(
              ignoring: _isLocating,
              child: widget.mapSurfaceBuilder(
                context,
                initialPoint: _initialMapPoint,
                onCameraChanged: _updateDraftFromCamera,
                onManualCameraMove: _markManualCameraIntent,
                onCameraReady: (camera) => _mapCamera = camera,
              ),
            ),
            IgnorePointer(
              child: Center(
                child: Semantics(
                  label: 'دبوس موقع الخدمة في وسط الخريطة',
                  child: const Icon(
                    Icons.location_on_rounded,
                    key: Key('service_location_center_pin'),
                    size: 52,
                    color: Color(0xFF0B6E69),
                    shadows: [Shadow(blurRadius: 5, color: Colors.black45)],
                  ),
                ),
              ),
            ),
            Positioned(
              left: 0,
              right: 0,
              bottom: 20,
              child: SafeArea(
                top: false,
                child: Center(
                  child: FloatingActionButton.extended(
                    heroTag: 'service-location-current',
                    onPressed: _isLocating ? null : _useCurrentLocation,
                    icon: _isLocating
                        ? const SizedBox.square(
                            dimension: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.my_location_rounded),
                    label: const Text('موقعي الحالي'),
                  ),
                ),
              ),
            ),
            if (_helpMessage != null)
              PositionedDirectional(
                start: 16,
                end: 16,
                top: 12,
                child: SafeArea(
                  bottom: false,
                  child: _LocationHelpMessage(
                    message: _helpMessage!,
                    showSettings:
                        _status ==
                        ServiceLocationPickerStatus.permissionPermanentlyDenied,
                    onOpenSettings: _openLocationSettings,
                  ),
                ),
              ),
          ],
        ),
        bottomNavigationBar: SafeArea(
          key: const Key('service_location_confirm_bar'),
          minimum: const EdgeInsets.fromLTRB(16, 12, 16, 16),
          child: FilledButton.icon(
            onPressed: _isConfirming || _isLocating ? null : _confirm,
            icon: _isConfirming
                ? const SizedBox.square(
                    dimension: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.check_circle_outline_rounded),
            label: const Text('تأكيد موقع الخدمة'),
            style: FilledButton.styleFrom(
              minimumSize: const Size.fromHeight(52),
            ),
          ),
        ),
      ),
    ),
  );

  String? get _helpMessage => switch (_status) {
    ServiceLocationPickerStatus.permissionDenied =>
      'لم نتمكن من استخدام موقعك. حرّك الخريطة وحدد الدبوس يدوياً.',
    ServiceLocationPickerStatus.permissionPermanentlyDenied =>
      'إذن الموقع متوقف. يمكنك فتح الإعدادات أو تحديد الدبوس يدوياً.',
    ServiceLocationPickerStatus.gpsUnavailable =>
      'تعذر الحصول على موقعك الحالي. حرّك الخريطة وحدد الدبوس يدوياً.',
    _ => null,
  };
}

class _LocationHelpMessage extends StatelessWidget {
  const _LocationHelpMessage({
    required this.message,
    required this.showSettings,
    required this.onOpenSettings,
  });

  final String message;
  final bool showSettings;
  final VoidCallback onOpenSettings;

  @override
  Widget build(BuildContext context) => Material(
    elevation: 3,
    borderRadius: BorderRadius.circular(14),
    color: const Color(0xFFF5FAF9),
    child: Padding(
      padding: const EdgeInsets.all(12),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.info_outline_rounded, color: Color(0xFF0B6E69)),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  message,
                  style: const TextStyle(color: Color(0xFF294E4A), height: 1.4),
                ),
              ),
            ],
          ),
          if (showSettings)
            TextButton.icon(
              onPressed: onOpenSettings,
              icon: const Icon(Icons.open_in_new_rounded),
              label: const Text('فتح إعدادات التطبيق'),
            ),
        ],
      ),
    ),
  );
}

Widget buildMapboxServiceLocationSurface(
  BuildContext context, {
  required ServiceLocationPoint initialPoint,
  required ServiceLocationCameraChanged onCameraChanged,
  required ServiceLocationManualCameraIntent onManualCameraMove,
  required ValueChanged<ServiceLocationMapCamera> onCameraReady,
}) => _MapboxServiceLocationSurface(
  initialPoint: initialPoint,
  onCameraChanged: onCameraChanged,
  onManualCameraMove: onManualCameraMove,
  onCameraReady: onCameraReady,
);

@visibleForTesting
Widget buildMapboxServiceLocationSurfaceForTesting({
  required ServiceLocationPoint initialPoint,
  required ServiceLocationCameraChanged onCameraChanged,
  required ServiceLocationManualCameraIntent onManualCameraMove,
  required ValueChanged<ServiceLocationMapCamera> onCameraReady,
  required ServiceLocationMapWidgetBuilder mapWidgetBuilder,
}) => _MapboxServiceLocationSurface(
  initialPoint: initialPoint,
  onCameraChanged: onCameraChanged,
  onManualCameraMove: onManualCameraMove,
  onCameraReady: onCameraReady,
  mapWidgetBuilder: mapWidgetBuilder,
);

class _MapboxServiceLocationSurface extends StatefulWidget {
  const _MapboxServiceLocationSurface({
    required this.initialPoint,
    required this.onCameraChanged,
    required this.onManualCameraMove,
    required this.onCameraReady,
    this.mapWidgetBuilder,
  });

  final ServiceLocationPoint initialPoint;
  final ServiceLocationCameraChanged onCameraChanged;
  final ServiceLocationManualCameraIntent onManualCameraMove;
  final ValueChanged<ServiceLocationMapCamera> onCameraReady;
  final ServiceLocationMapWidgetBuilder? mapWidgetBuilder;

  @override
  State<_MapboxServiceLocationSurface> createState() =>
      _MapboxServiceLocationSurfaceState();
}

class _MapboxServiceLocationSurfaceState
    extends State<_MapboxServiceLocationSurface> {
  late final mapbox.CameraViewportState _initialViewport;
  mapbox.MapboxMap? _mapboxMap;

  @override
  void initState() {
    super.initState();
    _initialViewport = mapbox.CameraViewportState(
      center: mapbox.Point(
        coordinates: mapbox.Position(
          widget.initialPoint.longitude,
          widget.initialPoint.latitude,
        ),
      ),
      zoom: 16,
    );
    final accessToken = CustomerMapboxConfig.accessToken;
    if (accessToken.isNotEmpty) {
      mapbox.MapboxOptions.setAccessToken(accessToken);
    }
  }

  Future<void> _onGestureEnded(mapbox.MapContentGestureContext gesture) async {
    final intentGeneration = widget.onManualCameraMove();
    if (intentGeneration == null ||
        gesture.gestureState != mapbox.GestureState.ended) {
      return;
    }
    final mapboxMap = _mapboxMap;
    if (mapboxMap == null) return;
    final camera = await mapboxMap.getCameraState();
    if (!mounted) return;
    widget.onCameraChanged(
      ServiceLocationPoint(
        latitude: camera.center.coordinates.lat.toDouble(),
        longitude: camera.center.coordinates.lng.toDouble(),
      ),
      intentGeneration,
    );
  }

  @override
  Widget build(BuildContext context) =>
      widget.mapWidgetBuilder?.call(_initialViewport) ??
      mapbox.MapWidget(
        key: const Key('customer_service_location_fullscreen_map'),
        styleUri: mapbox.MapboxStyles.MAPBOX_STREETS,
        viewport: _initialViewport,
        onMapCreated: (mapboxMap) async {
          _mapboxMap = mapboxMap;
          widget.onCameraReady(_MapboxServiceLocationCamera(mapboxMap));
          await mapboxMap.location.updateSettings(
            mapbox.LocationComponentSettings(enabled: false),
          );
        },
        onScrollListener: _onGestureEnded,
        onZoomListener: _onGestureEnded,
      );
}

class _MapboxServiceLocationCamera implements ServiceLocationMapCamera {
  const _MapboxServiceLocationCamera(this.mapboxMap);

  final mapbox.MapboxMap mapboxMap;

  @override
  Future<void> moveTo(ServiceLocationPoint point) => mapboxMap.setCamera(
    mapbox.CameraOptions(
      center: mapbox.Point(
        coordinates: mapbox.Position(point.longitude, point.latitude),
      ),
      zoom: 16,
    ),
  );

  @override
  Future<ServiceLocationPoint> snapshotCurrentCenter() async {
    final camera = await mapboxMap.getCameraState();
    return ServiceLocationPoint(
      latitude: camera.center.coordinates.lat.toDouble(),
      longitude: camera.center.coordinates.lng.toDouble(),
    );
  }
}

bool _samePoint(ServiceLocationPoint first, ServiceLocationPoint second) =>
    (first.latitude - second.latitude).abs() <= 0.000001 &&
    (first.longitude - second.longitude).abs() <= 0.000001;
