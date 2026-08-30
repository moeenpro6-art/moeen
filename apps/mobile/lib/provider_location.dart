import 'dart:convert';

import 'package:http/http.dart' as http;

/// Frozen client-side representation of the API's ProviderCurrentPosition DTO.
/// Coordinates are kept only in memory for rendering; this module never stores
/// or logs them.
class ProviderCurrentPosition {
  const ProviderCurrentPosition({
    required this.requestId,
    required this.latitude,
    required this.longitude,
    required this.accuracyMeters,
    required this.capturedAt,
    required this.receivedAt,
    required this.arrivalObserved,
  });

  final String requestId;
  final double latitude;
  final double longitude;
  final double accuracyMeters;
  final String capturedAt;
  final String receivedAt;
  final bool arrivalObserved;

  bool get isValid =>
      latitude.isFinite &&
      longitude.isFinite &&
      latitude >= -90 &&
      latitude <= 90 &&
      longitude >= -180 &&
      longitude <= 180 &&
      accuracyMeters.isFinite &&
      accuracyMeters >= 0;

  factory ProviderCurrentPosition.fromJson(Map<String, dynamic> json) =>
      ProviderCurrentPosition(
        requestId: json['requestId'] as String,
        latitude: (json['latitude'] as num).toDouble(),
        longitude: (json['longitude'] as num).toDouble(),
        accuracyMeters: (json['accuracyMeters'] as num).toDouble(),
        capturedAt: json['capturedAt'] as String,
        receivedAt: json['receivedAt'] as String,
        arrivalObserved: json['arrivalObserved'] as bool,
      );
}

enum ProviderLocationPollResult { position, unavailable, unauthorized, error }

class ProviderLocationPoll {
  const ProviderLocationPoll._({required this.result, this.position});
  const ProviderLocationPoll.position(ProviderCurrentPosition position)
    : this._(result: ProviderLocationPollResult.position, position: position);
  const ProviderLocationPoll.unavailable()
    : this._(result: ProviderLocationPollResult.unavailable);
  const ProviderLocationPoll.unauthorized()
    : this._(result: ProviderLocationPollResult.unauthorized);
  const ProviderLocationPoll.error()
    : this._(result: ProviderLocationPollResult.error);

  final ProviderLocationPollResult result;
  final ProviderCurrentPosition? position;
}

/// Reads one current position using the existing customer bearer session.
/// 401 and 404 are explicit terminal outcomes for polling. Other errors are
/// reported as error so callers can stop before an old point is mislabeled live.
Future<ProviderLocationPoll> fetchProviderLocation({
  required String requestId,
  required String token,
  required http.Client client,
  required Uri endpoint,
}) async {
  final http.Response response;
  try {
    response = await client.get(
      endpoint,
      headers: {'Authorization': 'Bearer $token'},
    );
  } catch (_) {
    return const ProviderLocationPoll.error();
  }

  if (response.statusCode == 404) {
    return const ProviderLocationPoll.unavailable();
  }
  if (response.statusCode == 401) {
    return const ProviderLocationPoll.unauthorized();
  }
  if (response.statusCode != 200) return const ProviderLocationPoll.error();

  try {
    final position = ProviderCurrentPosition.fromJson(
      jsonDecode(response.body) as Map<String, dynamic>,
    );
    return position.isValid
        ? ProviderLocationPoll.position(position)
        : const ProviderLocationPoll.error();
  } catch (_) {
    return const ProviderLocationPoll.error();
  }
}
