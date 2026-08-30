import 'dart:async';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:mapbox_maps_flutter/mapbox_maps_flutter.dart' as mapbox;

import 'api_config.dart';
import 'customer_session.dart';
import 'provider_location.dart';
import 'service_location.dart';
import 'service_location_picker_page.dart';

const providerLocationFreshThreshold = Duration(seconds: 45);
const providerLocationOfflineThreshold = Duration(seconds: 120);
const providerLocationPollInterval = Duration(seconds: 15);

final RouteObserver<ModalRoute<dynamic>> customerProviderTrackingRouteObserver =
    RouteObserver<ModalRoute<dynamic>>();

enum ProviderLocationFreshness { fresh, stale, offline }

bool customerProviderTrackingAllowedForStatus(String status) =>
    status == 'on_the_way' || status == 'in_progress';

Duration providerLocationRetryDelay(int consecutiveFailures) {
  if (consecutiveFailures <= 0) return providerLocationPollInterval;
  final exponent = consecutiveFailures > 2 ? 2 : consecutiveFailures;
  final seconds = providerLocationPollInterval.inSeconds * (1 << exponent);
  return Duration(seconds: seconds > 60 ? 60 : seconds);
}

ProviderLocationFreshness providerLocationFreshness({
  required String receivedAt,
  required DateTime now,
}) {
  final received = DateTime.tryParse(receivedAt);
  if (received == null) return ProviderLocationFreshness.offline;
  final age = now.difference(received);
  if (age < providerLocationFreshThreshold) {
    return ProviderLocationFreshness.fresh;
  }
  if (age < providerLocationOfflineThreshold) {
    return ProviderLocationFreshness.stale;
  }
  return ProviderLocationFreshness.offline;
}

typedef CustomerProviderTrackingMapSurfaceBuilder =
    Widget Function(
      BuildContext context, {
      required ServiceLocationPoint providerLocation,
      required ServiceLocationPoint? serviceLocation,
      required bool interactive,
      required bool cameraFollowsProvider,
      required int recenterGeneration,
      required VoidCallback onManualCameraMove,
    });

/// Shared, request-scoped polling brain for a single service request.
///
/// Both the request-details preview and the full-screen tracking route attach
/// to the same controller, so exactly one poller exists per request regardless
/// of how the tracking UI is entered or exited. The provider point remains in
/// memory only while at least one panel is visible; it is never stored or
/// logged.
class CustomerProviderTrackingController extends ChangeNotifier
    with WidgetsBindingObserver {
  CustomerProviderTrackingController({
    required this.requestId,
    required this.serviceLocation,
    required this.sessionManager,
    required this.apiConfig,
    this.httpClient,
    this.now = DateTime.now,
    this.pollInterval = providerLocationPollInterval,
  }) {
    WidgetsBinding.instance.addObserver(this);
  }

  final String requestId;
  final ServiceLocationPoint? serviceLocation;
  final CustomerSessionManager sessionManager;
  final http.Client? httpClient;
  final MoeenApiConfig apiConfig;
  final DateTime Function() now;
  final Duration pollInterval;

  http.Client? _ownedClient;
  http.Client get _client => httpClient ?? (_ownedClient ??= http.Client());

  bool _foreground = true;
  bool _stopped = false;
  bool _loading = true;
  bool _lastPollFailed = false;
  ProviderCurrentPosition? _position;
  int _consecutiveFailures = 0;
  int _pollGeneration = 0;
  int _visiblePanels = 0;
  bool _disposed = false;
  Timer? _pollTimer;
  Timer? _freshnessTimer;

  ProviderCurrentPosition? get position => _position;
  bool get loading => _loading;
  bool get stopped => _stopped;
  bool get lastPollFailed => _lastPollFailed;

  bool get _mayPoll =>
      !_stopped && !_disposed && _foreground && _visiblePanels > 0;

  void setPanelVisible(bool visible) {
    if (_disposed) return;
    if (visible) {
      _visiblePanels += 1;
      _onBecameVisible();
    } else {
      if (_visiblePanels > 0) _visiblePanels -= 1;
      if (_visiblePanels == 0) _onBecameHidden();
    }
  }

  void _onBecameVisible() {
    // RouteObserver reports the uncovered route before the popped route becomes
    // inactive. Treat every activation as an ownership handoff so the newly
    // visible panel receives one immediate poll without retaining the old
    // route's timer or allowing its response to commit.
    _invalidateActivePoll();
    _cancelPolling();
    _reclassifyRetainedPosition(notify: false);
    _poll();
  }

  void _onBecameHidden() {
    _invalidateActivePoll();
    _cancelPolling();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (_disposed) return;
    final foreground = state == AppLifecycleState.resumed;
    if (_foreground == foreground) return;
    _foreground = foreground;
    _invalidateActivePoll();
    _cancelPolling();
    if (foreground) {
      _reclassifyRetainedPosition();
      _poll();
    }
  }

  void _scheduleNextPoll({required bool failed}) {
    _consecutiveFailures = failed ? _consecutiveFailures + 1 : 0;
    _pollTimer?.cancel();
    _pollTimer = Timer(
      failed ? providerLocationRetryDelay(_consecutiveFailures) : pollInterval,
      _poll,
    );
  }

  void _cancelPolling() {
    _pollTimer?.cancel();
    _pollTimer = null;
    _freshnessTimer?.cancel();
    _freshnessTimer = null;
  }

  void _invalidateActivePoll() {
    _pollGeneration += 1;
  }

  bool _mayCommitPoll(int generation) =>
      !_disposed && generation == _pollGeneration && !_stopped;

  void _reclassifyRetainedPosition({bool notify = true}) {
    if (_position == null) return;
    if (notify) notifyListeners();
    _startFreshnessClock();
  }

  void _startFreshnessClock() {
    _freshnessTimer?.cancel();
    _freshnessTimer = null;
    final position = _position;
    if (position == null || !_foreground || _visiblePanels == 0) return;
    final receivedAt = DateTime.tryParse(position.receivedAt);
    if (receivedAt == null) return;
    final freshness = providerLocationFreshness(
      receivedAt: position.receivedAt,
      now: now(),
    );
    final nextBoundary = switch (freshness) {
      ProviderLocationFreshness.fresh => receivedAt.add(
        providerLocationFreshThreshold,
      ),
      ProviderLocationFreshness.stale => receivedAt.add(
        providerLocationOfflineThreshold,
      ),
      ProviderLocationFreshness.offline => null,
    };
    if (nextBoundary == null) return;
    final delay = nextBoundary.difference(now());
    _freshnessTimer = Timer(delay.isNegative ? Duration.zero : delay, () {
      if (_disposed ||
          _position == null ||
          !_foreground ||
          _visiblePanels == 0) {
        return;
      }
      notifyListeners();
      _startFreshnessClock();
    });
  }

  void _stopAndClear() {
    _stopped = true;
    _cancelPolling();
    _position = null;
    _loading = false;
    _lastPollFailed = false;
    notifyListeners();
  }

  void _showOfflineAndContinue() {
    _loading = false;
    _lastPollFailed = true;
    notifyListeners();
    _scheduleNextPoll(failed: true);
  }

  Future<void> _poll() async {
    if (!_mayPoll) return;
    final generation = ++_pollGeneration;
    await _doPoll(generation);
  }

  Future<void> _doPoll(int generation) async {
    final session = await sessionManager.restore();
    if (!_mayCommitPoll(generation)) return;
    if (session == null) {
      _stopAndClear();
      return;
    }

    ProviderLocationPoll poll;
    try {
      poll = await fetchProviderLocation(
        requestId: requestId,
        token: session.token,
        client: _client,
        endpoint: apiConfig.endpoint(
          '/my/service-requests/$requestId/provider-location',
        ),
      );
    } on MoeenApiConfigurationException {
      poll = const ProviderLocationPoll.error();
    }
    if (!_mayCommitPoll(generation)) return;

    switch (poll.result) {
      case ProviderLocationPollResult.position:
        _position = poll.position;
        _loading = false;
        _lastPollFailed = false;
        notifyListeners();
        _startFreshnessClock();
        _scheduleNextPoll(failed: false);
      case ProviderLocationPollResult.unavailable:
      case ProviderLocationPollResult.unauthorized:
        _stopAndClear();
      case ProviderLocationPollResult.error:
        // A transient network error is offline, never live. Keep polling only
        // while a visible panel remains eligible.
        _showOfflineAndContinue();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    WidgetsBinding.instance.removeObserver(this);
    _invalidateActivePoll();
    _cancelPolling();
    _ownedClient?.close();
    super.dispose();
  }
}

/// Customer-only position view. The current point remains in memory solely
/// while a visible tracking panel is active; it is never stored or logged.
class CustomerProviderTrackingPanel extends StatefulWidget {
  const CustomerProviderTrackingPanel({
    super.key,
    required this.requestId,
    required this.serviceLocation,
    required this.sessionManager,
    this.httpClient,
    required this.apiConfig,
    this.now = DateTime.now,
    this.pollInterval = providerLocationPollInterval,
    this.mapSurfaceBuilder,
    this.fullScreen = false,
    this.controller,
  });

  final String requestId;
  final ServiceLocationPoint? serviceLocation;
  final CustomerSessionManager sessionManager;
  final http.Client? httpClient;
  final MoeenApiConfig apiConfig;
  final DateTime Function() now;
  final Duration pollInterval;
  final CustomerProviderTrackingMapSurfaceBuilder? mapSurfaceBuilder;
  final bool fullScreen;
  final CustomerProviderTrackingController? controller;

  @override
  State<CustomerProviderTrackingPanel> createState() =>
      _CustomerProviderTrackingPanelState();
}

class _CustomerProviderTrackingPanelState
    extends State<CustomerProviderTrackingPanel>
    with RouteAware {
  ModalRoute<dynamic>? _route;
  CustomerProviderTrackingController? _ownedController;
  bool _active = false;
  bool _cameraFollowsProvider = true;
  int _recenterGeneration = 0;

  CustomerProviderTrackingController get _controller =>
      widget.controller ?? _ownedController!;

  CustomerProviderTrackingController _createController() =>
      CustomerProviderTrackingController(
        requestId: widget.requestId,
        serviceLocation: widget.serviceLocation,
        sessionManager: widget.sessionManager,
        httpClient: widget.httpClient,
        apiConfig: widget.apiConfig,
        now: widget.now,
        pollInterval: widget.pollInterval,
      );

  @override
  void initState() {
    super.initState();
    if (widget.controller == null) {
      _ownedController = _createController();
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final route = ModalRoute.of(context);
    if (identical(route, _route)) return;
    if (_route != null) {
      customerProviderTrackingRouteObserver.unsubscribe(this);
    }
    _route = route;
    if (route != null) {
      customerProviderTrackingRouteObserver.subscribe(this, route);
      _setActive(route.isCurrent);
    }
  }

  void _setActive(bool active) {
    if (_active == active) return;
    _active = active;
    _controller.setPanelVisible(active);
  }

  @override
  void didPush() => _setActive(true);

  @override
  void didPushNext() => _setActive(false);

  @override
  void didPopNext() => _setActive(true);

  @override
  void didPop() => _setActive(false);

  @override
  void dispose() {
    customerProviderTrackingRouteObserver.unsubscribe(this);
    if (_active) _controller.setPanelVisible(false);
    _ownedController?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _controller,
      builder: (context, _) {
        final position = _controller.position;
        if (_controller.loading) {
          return widget.fullScreen
              ? const Center(child: CircularProgressIndicator())
              : const _TrackingCard.loading();
        }
        if (position == null) {
          return widget.fullScreen
              ? const Center(
                  child: _TrackingStatus(
                    icon: Icons.portable_wifi_off_rounded,
                    text: 'تتبع موقع الفني غير متاح الآن.',
                    color: Color(0xFF64748B),
                  ),
                )
              : const _TrackingCard.unavailable();
        }

        final providerPoint = ServiceLocationPoint(
          latitude: position.latitude,
          longitude: position.longitude,
        );
        final freshness = _controller.lastPollFailed
            ? ProviderLocationFreshness.offline
            : providerLocationFreshness(
                receivedAt: position.receivedAt,
                now: widget.now(),
              );
        final map =
            widget.mapSurfaceBuilder?.call(
              context,
              providerLocation: providerPoint,
              serviceLocation: widget.serviceLocation,
              interactive: widget.fullScreen,
              cameraFollowsProvider: _cameraFollowsProvider,
              recenterGeneration: _recenterGeneration,
              onManualCameraMove: _markManualCameraMove,
            ) ??
            CustomerProviderTrackingMap(
              providerLocation: providerPoint,
              serviceLocation: widget.serviceLocation,
              interactive: widget.fullScreen,
              cameraFollowsProvider: _cameraFollowsProvider,
              recenterGeneration: _recenterGeneration,
              onManualCameraMove: _markManualCameraMove,
            );
        if (widget.fullScreen) {
          return Stack(
            key: const Key('customer_provider_tracking_fullscreen_map_area'),
            fit: StackFit.expand,
            children: [
              map,
              PositionedDirectional(
                start: 16,
                end: 16,
                top: 12,
                child: SafeArea(
                  bottom: false,
                  child: _TrackingOverlay(
                    position: position,
                    freshness: freshness,
                    now: widget.now(),
                  ),
                ),
              ),
              PositionedDirectional(
                start: 16,
                bottom: 20,
                child: SafeArea(
                  top: false,
                  child: FloatingActionButton.extended(
                    heroTag: 'customer-provider-tracking-recenter',
                    onPressed: _recenterMap,
                    icon: const Icon(Icons.center_focus_strong_rounded),
                    label: const Text('إعادة التوسيط'),
                  ),
                ),
              ),
            ],
          );
        }

        return _TrackingCard(
          position: position,
          freshness: freshness,
          now: widget.now(),
          map: map,
          onOpenMap: _openFullScreenTracking,
        );
      },
    );
  }

  void _markManualCameraMove() {
    if (!widget.fullScreen || !_cameraFollowsProvider) return;
    setState(() => _cameraFollowsProvider = false);
  }

  void _recenterMap() {
    if (!widget.fullScreen) return;
    setState(() {
      _cameraFollowsProvider = true;
      _recenterGeneration += 1;
    });
  }

  void _openFullScreenTracking() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => CustomerProviderTrackingPage(
          requestId: widget.requestId,
          serviceLocation: widget.serviceLocation,
          sessionManager: widget.sessionManager,
          httpClient: widget.httpClient,
          apiConfig: widget.apiConfig,
          now: widget.now,
          pollInterval: widget.pollInterval,
          mapSurfaceBuilder: widget.mapSurfaceBuilder,
          controller: _controller,
        ),
      ),
    );
  }
}

class CustomerProviderTrackingPage extends StatelessWidget {
  const CustomerProviderTrackingPage({
    super.key,
    required this.requestId,
    required this.serviceLocation,
    required this.sessionManager,
    required this.controller,
    this.httpClient,
    required this.apiConfig,
    this.now = DateTime.now,
    this.pollInterval = providerLocationPollInterval,
    this.mapSurfaceBuilder,
  });

  final String requestId;
  final ServiceLocationPoint? serviceLocation;
  final CustomerSessionManager sessionManager;
  final CustomerProviderTrackingController controller;
  final http.Client? httpClient;
  final MoeenApiConfig apiConfig;
  final DateTime Function() now;
  final Duration pollInterval;
  final CustomerProviderTrackingMapSurfaceBuilder? mapSurfaceBuilder;

  @override
  Widget build(BuildContext context) => Directionality(
    textDirection: TextDirection.rtl,
    child: Scaffold(
      key: const Key('customer_provider_tracking_fullscreen_page'),
      appBar: AppBar(
        leading: IconButton(
          tooltip: 'رجوع',
          onPressed: () => Navigator.of(context).pop(),
          icon: const Icon(Icons.arrow_forward_rounded),
        ),
        title: const Text('تتبع الفني'),
      ),
      body: CustomerProviderTrackingPanel(
        requestId: requestId,
        serviceLocation: serviceLocation,
        sessionManager: sessionManager,
        httpClient: httpClient,
        apiConfig: apiConfig,
        now: now,
        pollInterval: pollInterval,
        mapSurfaceBuilder: mapSurfaceBuilder,
        controller: controller,
        fullScreen: true,
      ),
    ),
  );
}

enum _TrackingCardState { loading, unavailable, position }

class _TrackingCard extends StatelessWidget {
  const _TrackingCard({
    required this.position,
    required this.freshness,
    required this.now,
    required this.map,
    required this.onOpenMap,
  }) : state = _TrackingCardState.position;

  const _TrackingCard.loading()
    : state = _TrackingCardState.loading,
      position = null,
      freshness = ProviderLocationFreshness.offline,
      now = null,
      map = null,
      onOpenMap = null;

  const _TrackingCard.unavailable()
    : state = _TrackingCardState.unavailable,
      position = null,
      freshness = ProviderLocationFreshness.offline,
      now = null,
      map = null,
      onOpenMap = null;

  final _TrackingCardState state;
  final ProviderCurrentPosition? position;
  final ProviderLocationFreshness freshness;
  final DateTime? now;
  final Widget? map;
  final VoidCallback? onOpenMap;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'تتبع الفني',
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                color: const Color(0xFF17312E),
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 12),
            if (state == _TrackingCardState.loading)
              const Center(child: CircularProgressIndicator())
            else if (state == _TrackingCardState.unavailable)
              const _TrackingStatus(
                icon: Icons.portable_wifi_off_rounded,
                text: 'تتبع موقع الفني غير متاح الآن.',
                color: Color(0xFF64748B),
              )
            else ...[
              Semantics(
                button: true,
                label: 'فتح الخريطة',
                child: InkWell(
                  key: const Key('customer_provider_tracking_preview_map'),
                  onTap: onOpenMap,
                  borderRadius: BorderRadius.circular(16),
                  child: ClipRRect(
                    key: const Key('customer_provider_tracking_preview_clip'),
                    borderRadius: BorderRadius.circular(16),
                    child: SizedBox(
                      height: 190,
                      child: Stack(
                        fit: StackFit.expand,
                        children: [
                          IgnorePointer(child: map),
                          const DecoratedBox(
                            decoration: BoxDecoration(
                              gradient: LinearGradient(
                                begin: Alignment.topCenter,
                                end: Alignment.bottomCenter,
                                colors: [Colors.transparent, Color(0x33000000)],
                              ),
                            ),
                          ),
                          PositionedDirectional(
                            end: 10,
                            bottom: 10,
                            child: Material(
                              color: Colors.white,
                              borderRadius: BorderRadius.circular(12),
                              child: InkWell(
                                onTap: onOpenMap,
                                borderRadius: BorderRadius.circular(12),
                                child: const Padding(
                                  padding: EdgeInsets.symmetric(
                                    horizontal: 12,
                                    vertical: 9,
                                  ),
                                  child: Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Icon(
                                        Icons.open_in_full_rounded,
                                        size: 18,
                                        color: Color(0xFF0B6E69),
                                      ),
                                      SizedBox(width: 6),
                                      Text(
                                        'فتح الخريطة',
                                        style: TextStyle(
                                          color: Color(0xFF0B6E69),
                                          fontWeight: FontWeight.w700,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 12),
              _TrackingDetails(
                position: position!,
                freshness: freshness,
                now: now!,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _TrackingOverlay extends StatelessWidget {
  const _TrackingOverlay({
    required this.position,
    required this.freshness,
    required this.now,
  });

  final ProviderCurrentPosition position;
  final ProviderLocationFreshness freshness;
  final DateTime now;

  @override
  Widget build(BuildContext context) => Material(
    elevation: 3,
    color: const Color(0xF2FFFFFF),
    borderRadius: BorderRadius.circular(14),
    child: Padding(
      padding: const EdgeInsets.all(12),
      child: _TrackingDetails(
        position: position,
        freshness: freshness,
        now: now,
      ),
    ),
  );
}

class _TrackingDetails extends StatelessWidget {
  const _TrackingDetails({
    required this.position,
    required this.freshness,
    required this.now,
  });

  final ProviderCurrentPosition position;
  final ProviderLocationFreshness freshness;
  final DateTime now;

  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      _TrackingStatus(
        icon: _freshnessIcon(freshness),
        text: _freshnessLabel(freshness),
        color: _freshnessColor(freshness),
      ),
      const SizedBox(height: 6),
      Text(
        'آخر تحديث: ${_formatLastUpdated(position.receivedAt, now)}',
        key: const Key('customer_provider_tracking_last_updated'),
        style: Theme.of(
          context,
        ).textTheme.bodySmall?.copyWith(color: const Color(0xFF64748B)),
      ),
      if (position.arrivalObserved) ...[
        const SizedBox(height: 10),
        const _TrackingStatus(
          icon: Icons.check_circle_rounded,
          text: 'وصل الفني إلى موقع الخدمة',
          color: Color(0xFF08735F),
        ),
      ],
    ],
  );
}

class _TrackingStatus extends StatelessWidget {
  const _TrackingStatus({
    required this.icon,
    required this.text,
    required this.color,
  });

  final IconData icon;
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Icon(icon, size: 20, color: color),
      const SizedBox(width: 8),
      Expanded(
        child: Text(
          text,
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
            color: color,
            fontWeight: FontWeight.w700,
          ),
        ),
      ),
    ],
  );
}

String _freshnessLabel(ProviderLocationFreshness value) => switch (value) {
  ProviderLocationFreshness.fresh => 'موقع الفني محدّث الآن',
  ProviderLocationFreshness.stale => 'آخر موقع للفني قديم قليلاً',
  ProviderLocationFreshness.offline => 'موقع الفني غير متصل حالياً',
};

IconData _freshnessIcon(ProviderLocationFreshness value) => switch (value) {
  ProviderLocationFreshness.fresh => Icons.location_on_rounded,
  ProviderLocationFreshness.stale => Icons.schedule_rounded,
  ProviderLocationFreshness.offline => Icons.portable_wifi_off_rounded,
};

Color _freshnessColor(ProviderLocationFreshness value) => switch (value) {
  ProviderLocationFreshness.fresh => const Color(0xFF08735F),
  ProviderLocationFreshness.stale => const Color(0xFF9A6700),
  ProviderLocationFreshness.offline => const Color(0xFF64748B),
};

String _formatLastUpdated(String receivedAt, DateTime now) {
  final received = DateTime.tryParse(receivedAt);
  if (received == null) return 'غير معروف';
  final seconds = now.difference(received).inSeconds;
  if (seconds < 5) return 'الآن';
  if (seconds < 60) return 'منذ $seconds ثانية';
  return 'منذ ${(seconds / 60).floor()} دقيقة';
}

/// Mapbox map with blue provider and teal service-location markers. It uses
/// native annotations and disables the device location component: no customer
/// GPS is read for tracking.
class CustomerProviderTrackingMap extends StatefulWidget {
  const CustomerProviderTrackingMap({
    super.key,
    required this.providerLocation,
    required this.serviceLocation,
    this.interactive = false,
    this.cameraFollowsProvider = true,
    this.recenterGeneration = 0,
    this.onManualCameraMove,
  });

  final ServiceLocationPoint providerLocation;
  final ServiceLocationPoint? serviceLocation;
  final bool interactive;
  final bool cameraFollowsProvider;
  final int recenterGeneration;
  final VoidCallback? onManualCameraMove;

  @override
  State<CustomerProviderTrackingMap> createState() =>
      _CustomerProviderTrackingMapState();
}

class _CustomerProviderTrackingMapState
    extends State<CustomerProviderTrackingMap> {
  mapbox.MapboxMap? _map;
  mapbox.CircleAnnotationManager? _markers;
  int _cameraOperationGeneration = 0;

  @override
  void initState() {
    super.initState();
    final token = CustomerMapboxConfig.accessToken;
    if (token.isNotEmpty) mapbox.MapboxOptions.setAccessToken(token);
  }

  @override
  void didUpdateWidget(covariant CustomerProviderTrackingMap oldWidget) {
    super.didUpdateWidget(oldWidget);
    final pointsChanged =
        oldWidget.providerLocation.latitude !=
            widget.providerLocation.latitude ||
        oldWidget.providerLocation.longitude !=
            widget.providerLocation.longitude ||
        oldWidget.serviceLocation?.latitude !=
            widget.serviceLocation?.latitude ||
        oldWidget.serviceLocation?.longitude !=
            widget.serviceLocation?.longitude;
    if (oldWidget.recenterGeneration != widget.recenterGeneration) {
      _fitCamera(animated: true);
    } else if (pointsChanged) {
      _renderMarkers(fitCamera: widget.cameraFollowsProvider);
    }
    if (oldWidget.interactive != widget.interactive) {
      _configureGestures();
    }
  }

  @override
  void dispose() {
    _cameraOperationGeneration += 1;
    final map = _map;
    final markers = _markers;
    if (map != null && markers != null) {
      unawaited(map.annotations.removeAnnotationManager(markers));
    }
    super.dispose();
  }

  Future<void> _onMapCreated(mapbox.MapboxMap map) async {
    _map = map;
    await Future.wait([
      map.location.updateSettings(
        mapbox.LocationComponentSettings(enabled: false),
      ),
      _configureGestures(map),
    ]);
    if (!mounted) return;
    _markers = await map.annotations.createCircleAnnotationManager();
    await _renderMarkers(fitCamera: true);
  }

  Future<void> _configureGestures([mapbox.MapboxMap? createdMap]) {
    final map = createdMap ?? _map;
    if (map == null) return Future.value();
    return map.gestures.updateSettings(
      mapbox.GesturesSettings(
        scrollEnabled: widget.interactive,
        pinchToZoomEnabled: widget.interactive,
        doubleTapToZoomInEnabled: widget.interactive,
        doubleTouchToZoomOutEnabled: widget.interactive,
        quickZoomEnabled: widget.interactive,
        rotateEnabled: false,
        pitchEnabled: false,
      ),
    );
  }

  Future<void> _renderMarkers({required bool fitCamera}) async {
    final markers = _markers;
    if (!mounted || markers == null) return;
    final generation = _cameraOperationGeneration;
    await markers.deleteAll();
    if (!mounted) return;
    final service = widget.serviceLocation;
    await markers.createMulti([
      mapbox.CircleAnnotationOptions(
        geometry: _point(widget.providerLocation),
        circleColor: const Color(0xFF2563EB).toARGB32(),
        circleRadius: 10,
        circleStrokeColor: Colors.white.toARGB32(),
        circleStrokeWidth: 3,
      ),
      if (service != null)
        mapbox.CircleAnnotationOptions(
          geometry: _point(service),
          circleColor: const Color(0xFF0B6E69).toARGB32(),
          circleRadius: 10,
          circleStrokeColor: Colors.white.toARGB32(),
          circleStrokeWidth: 3,
        ),
    ]);
    if (fitCamera &&
        widget.cameraFollowsProvider &&
        generation == _cameraOperationGeneration) {
      await _fitCamera(animated: false);
    }
  }

  Future<void> _fitCamera({required bool animated}) async {
    final map = _map;
    if (!mounted || map == null) return;
    final generation = ++_cameraOperationGeneration;
    final service = widget.serviceLocation;
    final camera = service == null
        ? mapbox.CameraOptions(
            center: _point(widget.providerLocation),
            zoom: 15,
          )
        : await map.cameraForCoordinateBounds(
            mapbox.CoordinateBounds(
              southwest: _point(
                ServiceLocationPoint(
                  latitude: service.latitude < widget.providerLocation.latitude
                      ? service.latitude
                      : widget.providerLocation.latitude,
                  longitude:
                      service.longitude < widget.providerLocation.longitude
                      ? service.longitude
                      : widget.providerLocation.longitude,
                ),
              ),
              northeast: _point(
                ServiceLocationPoint(
                  latitude: service.latitude > widget.providerLocation.latitude
                      ? service.latitude
                      : widget.providerLocation.latitude,
                  longitude:
                      service.longitude > widget.providerLocation.longitude
                      ? service.longitude
                      : widget.providerLocation.longitude,
                ),
              ),
              infiniteBounds: false,
            ),
            mapbox.MbxEdgeInsets(
              top: widget.interactive ? 170 : 28,
              left: 28,
              bottom: widget.interactive ? 100 : 28,
              right: 28,
            ),
            0,
            0,
            16,
            null,
          );
    if (!mounted || generation != _cameraOperationGeneration) return;
    if (animated) {
      await map.easeTo(camera, mapbox.MapAnimationOptions(duration: 350));
    } else {
      await map.setCamera(camera);
    }
  }

  void _onMapGesture(mapbox.MapContentGestureContext gesture) {
    if (widget.interactive &&
        gesture.gestureState == mapbox.GestureState.started) {
      _cameraOperationGeneration += 1;
      widget.onManualCameraMove?.call();
    }
  }

  mapbox.Point _point(ServiceLocationPoint point) => mapbox.Point(
    coordinates: mapbox.Position(point.longitude, point.latitude),
  );

  @override
  Widget build(BuildContext context) => Stack(
    children: [
      mapbox.MapWidget(
        key: Key(
          widget.interactive
              ? 'customer_provider_tracking_fullscreen_map'
              : 'customer_provider_tracking_map',
        ),
        styleUri: mapbox.MapboxStyles.MAPBOX_STREETS,
        viewport: mapbox.CameraViewportState(
          center: _point(widget.providerLocation),
          zoom: 15,
        ),
        onMapCreated: _onMapCreated,
        onScrollListener: _onMapGesture,
        onZoomListener: _onMapGesture,
      ),
      PositionedDirectional(
        top: 8,
        start: 8,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(8),
          ),
          child: const Text('الأزرق: الفني · الأخضر: موقع الخدمة'),
        ),
      ),
    ],
  );
}
