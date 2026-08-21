import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:moeen_mobile/request_images.dart';
import 'package:moeen_mobile/service_location.dart';

void main() {
  const location = ServiceLocationInput(
    point: ServiceLocationPoint(
      latitude: 26.3591234,
      longitude: 43.9819876,
    ),
    displayAddress: 'حي الصفراء، بريدة',
    source: ServiceLocationSource.mapPin,
    confirmed: true,
  );

  test('JSON request payload uses the canonical confirmed location contract', () {
    expect(
      buildServiceRequestPayload(
        serviceId: 'ac-cleaning',
        address: location.displayAddress,
        details: 'مكيف لا يبرد',
        timing: 'as-soon-as-possible',
        location: location,
      ),
      {
        'serviceId': 'ac-cleaning',
        'address': 'حي الصفراء، بريدة',
        'details': 'مكيف لا يبرد',
        'timing': 'as-soon-as-possible',
        'location': location.toJson(),
      },
    );
  });

  test('changed confirmed location invalidates the multipart idempotency key', () {
    final identity = BookingSubmissionIdentity();
    final first = identity.keyFor(
      serviceId: 'ac-cleaning',
      address: location.displayAddress,
      details: null,
      timing: 'as-soon-as-possible',
      serviceLocationFingerprint: location.fingerprint,
      orderedImageBytes: const [],
    );
    final retry = identity.keyFor(
      serviceId: 'ac-cleaning',
      address: location.displayAddress,
      details: null,
      timing: 'as-soon-as-possible',
      serviceLocationFingerprint: location.fingerprint,
      orderedImageBytes: const [],
    );
    const movedLocation = ServiceLocationInput(
      point: ServiceLocationPoint(
        latitude: 26.360001,
        longitude: 43.980001,
      ),
      displayAddress: 'حي الصفراء، بريدة',
      source: ServiceLocationSource.mapPin,
      confirmed: true,
    );
    final moved = identity.keyFor(
      serviceId: 'ac-cleaning',
      address: movedLocation.displayAddress,
      details: null,
      timing: 'as-soon-as-possible',
      serviceLocationFingerprint: movedLocation.fingerprint,
      orderedImageBytes: const [],
    );

    expect(retry, first);
    expect(moved, isNot(first));
  });

  test('multipart request encodes the equivalent location JSON field', () async {
    http.Request? captured;
    final client = MockClient((request) async {
      captured = request;
      return http.Response('{}', 201);
    });

    await submitServiceRequestWithImages(
      client: client,
      endpoint: Uri.parse('https://api.example.test/service-requests'),
      token: 'token-1',
      serviceId: 'ac-cleaning',
      address: location.displayAddress,
      timing: 'as-soon-as-possible',
      images: [
        SelectedRequestImage(
          fileName: 'photo.jpg',
          mimeType: 'image/jpeg',
          size: 5,
          bytes: Uint8List.fromList([0xFF, 0xD8, 0xFF, 0xE0, 0x00]),
        ),
      ],
      location: location,
    );

    final body = utf8.decode(captured!.bodyBytes, allowMalformed: true);
    expect(body, contains('name="location"'));
    expect(body, contains(jsonEncode(location.toJson())));
    expect(body, contains('name="images"'));
  });
}
