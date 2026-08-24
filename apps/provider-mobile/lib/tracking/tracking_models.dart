// Provider-tracking wire models shared by the Phase 4 client foundation.
//
// These types are deliberately passive DTOs. They do not persist samples,
// start device location acquisition, or emit coordinates to logs.

const Set<String> providerTrackingRequestStatuses = {
  'assigned',
  'on_the_way',
  'in_progress',
  'completed',
  'cancelled',
};

/// Exact response body returned by
/// `GET /provider/service-requests/:id/tracking`.
class ProviderTrackingStatusResponseDto {
  const ProviderTrackingStatusResponseDto({required this.tracking});

  final TrackingState tracking;

  factory ProviderTrackingStatusResponseDto.fromJson(
    Map<String, dynamic> json,
  ) {
    final tracking = json['tracking'];
    if (tracking is! Map<dynamic, dynamic>) {
      throw const FormatException('Invalid provider tracking status response');
    }
    return ProviderTrackingStatusResponseDto(
      tracking: TrackingState.fromJson(Map<String, dynamic>.from(tracking)),
    );
  }

  Map<String, dynamic> toJson() => {'tracking': tracking.toJson()};
}

/// The current server-authoritative tracking state for one assigned request.
///
/// `active` is the sole authority for future GPS acquisition. Status and local
/// app state must never be used to infer authorization to collect a location.
class TrackingState {
  const TrackingState({
    required this.requestId,
    required this.status,
    required this.onTheWayCadenceMs,
    required this.inProgressCadenceMs,
    required this.active,
  });

  final String requestId;
  final String status;
  final int onTheWayCadenceMs;
  final int inProgressCadenceMs;
  final bool active;

  factory TrackingState.fromJson(Map<String, dynamic> json) {
    final requestId = json['requestId'];
    final status = json['status'];
    final onTheWayCadenceMs = json['onTheWayCadenceMs'];
    final inProgressCadenceMs = json['inProgressCadenceMs'];
    final active = json['active'];

    if (requestId is! String ||
        requestId.isEmpty ||
        status is! String ||
        !providerTrackingRequestStatuses.contains(status) ||
        onTheWayCadenceMs is! int ||
        onTheWayCadenceMs <= 0 ||
        inProgressCadenceMs is! int ||
        inProgressCadenceMs <= 0 ||
        active is! bool) {
      throw const FormatException('Invalid provider tracking state');
    }

    return TrackingState(
      requestId: requestId,
      status: status,
      onTheWayCadenceMs: onTheWayCadenceMs,
      inProgressCadenceMs: inProgressCadenceMs,
      active: active,
    );
  }

  Map<String, dynamic> toJson() => {
    'active': active,
    'requestId': requestId,
    'status': status,
    'onTheWayCadenceMs': onTheWayCadenceMs,
    'inProgressCadenceMs': inProgressCadenceMs,
  };
}

/// One in-memory provider position sample for the future submission queue.
///
/// Phase 4.1 creates this data shape only. It neither samples a device position
/// nor stores any coordinate locally.
class ProviderLocationSample {
  const ProviderLocationSample({
    required this.latitude,
    required this.longitude,
    required this.accuracyMeters,
    required this.capturedAt,
  });

  final double latitude;
  final double longitude;
  final double accuracyMeters;
  final DateTime capturedAt;

  Map<String, dynamic> toJson() => {
    'latitude': latitude,
    'longitude': longitude,
    'accuracyMeters': accuracyMeters,
    'capturedAt': capturedAt.toUtc().toIso8601String(),
  };
}

/// Associates a future in-memory queue item with the request it belongs to.
///
/// There is intentionally no queue implementation or persistence in Phase 4.1.
class ProviderSample {
  const ProviderSample({required this.requestId, required this.sample});

  final String requestId;
  final ProviderLocationSample sample;

  Map<String, dynamic> toJson() => {'requestId': requestId, ...sample.toJson()};
}
