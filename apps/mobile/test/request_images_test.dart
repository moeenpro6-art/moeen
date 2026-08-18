import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:moeen_mobile/request_images.dart';

Uint8List _jpegBytes() => Uint8List.fromList([0xFF, 0xD8, 0xFF, 0xE0, 0x00]);

Uint8List _pngBytes() => Uint8List.fromList(
  [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00],
);

Uint8List _webpBytes() => Uint8List.fromList([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

SelectedRequestImage _image({
  String fileName = 'photo.jpg',
  String mimeType = 'image/jpeg',
  int size = 1024,
  Uint8List? bytes,
}) => SelectedRequestImage(
  fileName: fileName,
  mimeType: mimeType,
  size: size,
  bytes: bytes ?? Uint8List(size),
);

void main() {
  group('validateRequestImageSelection', () {
    test('accepts a valid selection of supported images', () {
      final selection = [
        _image(fileName: 'a.jpg', mimeType: 'image/jpeg'),
        _image(fileName: 'b.png', mimeType: 'image/png'),
        _image(fileName: 'c.webp', mimeType: 'image/webp'),
      ];
      expect(validateRequestImageSelection(selection), isNull);
    });

    test('accepts an empty selection (zero-image flow)', () {
      expect(validateRequestImageSelection(const []), isNull);
    });

    test('rejects more than 5 images', () {
      final selection = List.generate(
        maxRequestImages + 1,
        (_) => _image(),
      );
      expect(
        validateRequestImageSelection(selection),
        contains('الحد الأقصى'),
      );
    });

    test('rejects an unsupported MIME type', () {
      final selection = [
        _image(fileName: 'a.jpg', mimeType: 'image/jpeg'),
        _image(fileName: 'b.gif', mimeType: 'image/gif'),
      ];
      expect(
        validateRequestImageSelection(selection),
        contains('صيغة غير مدعومة'),
      );
    });

    test('rejects a single image larger than 5 MiB', () {
      final selection = [
        _image(size: maxRequestImageBytes + 1),
      ];
      expect(
        validateRequestImageSelection(selection),
        contains('5 م.ب'),
      );
    });

    test('rejects a zero-byte image', () {
      final selection = [
        _image(size: 0),
      ];
      expect(validateRequestImageSelection(selection), isNotNull);
    });

    test('rejects a selection exceeding the 20 MiB aggregate limit', () {
      final selection = List.generate(
        maxRequestImages,
        (_) => _image(size: 4 * 1024 * 1024 + 1),
      );
      expect(
        validateRequestImageSelection(selection),
        contains('الحجم الإجمالي'),
      );
    });
  });

  group('duplicateRequestImageError', () {
    test('detects the same bytes selected twice', () {
      final bytes = _jpegBytes();
      final selection = [
        _image(fileName: 'a.jpg', bytes: bytes),
        _image(fileName: 'b.jpg', bytes: bytes),
      ];
      expect(
        duplicateRequestImageError(selection),
        contains('نفسها أكثر من مرة'),
      );
    });

    test('accepts distinct content', () {
      final selection = [
        _image(fileName: 'a.jpg', bytes: _jpegBytes()),
        _image(fileName: 'b.jpg', bytes: _pngBytes()),
      ];
      expect(duplicateRequestImageError(selection), isNull);
    });
  });

  group('sniffImageMimeType', () {
    test('detects JPEG', () {
      expect(sniffImageMimeType(_jpegBytes()), 'image/jpeg');
    });

    test('detects PNG', () {
      expect(sniffImageMimeType(_pngBytes()), 'image/png');
    });

    test('detects WebP', () {
      expect(sniffImageMimeType(_webpBytes()), 'image/webp');
    });

    test('returns null for unknown content', () {
      expect(
        sniffImageMimeType(Uint8List.fromList([0x00, 0x01, 0x02])),
        isNull,
      );
    });
  });

  group('imageMimeTypeFromFileName', () {
    test('maps jpg/jpeg/png/webp extensions', () {
      expect(imageMimeTypeFromFileName('a.jpg'), 'image/jpeg');
      expect(imageMimeTypeFromFileName('A.JPEG'), 'image/jpeg');
      expect(imageMimeTypeFromFileName('b.png'), 'image/png');
      expect(imageMimeTypeFromFileName('c.webp'), 'image/webp');
    });

    test('returns null for unknown extensions', () {
      expect(imageMimeTypeFromFileName('d.gif'), isNull);
      expect(imageMimeTypeFromFileName('noext'), isNull);
    });
  });

  group('generateUuidV4', () {
    test('produces a valid v4 UUID', () {
      final uuid = generateUuidV4();
      expect(
        RegExp(
          r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-'
          r'[0-9a-f]{12}$',
        ).hasMatch(uuid),
        isTrue,
        reason: 'generated "$uuid" is not a UUID v4',
      );
    });

    test('produces unique values', () {
      final first = generateUuidV4();
      final second = generateUuidV4();
      expect(first, isNot(second));
    });
  });

  group('RequestImage.fromJson', () {
    test('parses the public API projection', () {
      final image = RequestImage.fromJson({
        'id': 'img-1',
        'mimeType': 'image/jpeg',
        'byteSize': 2048,
        'sortOrder': 2,
        'url': 'https://signed.example.test/img-1?sig=x',
        'urlExpiresAt': '2026-08-17T12:00:00.000Z',
      });
      expect(image.id, 'img-1');
      expect(image.byteSize, 2048);
      expect(image.sortOrder, 2);
      expect(image.url, 'https://signed.example.test/img-1?sig=x');
      expect(image.urlExpiresAt, '2026-08-17T12:00:00.000Z');
    });

    test('listFromJson preserves server order and drops malformed entries', () {
      final images = RequestImage.listFromJson([
        {
          'id': 'img-2',
          'mimeType': 'image/jpeg',
          'byteSize': 10,
          'sortOrder': 1,
          'url': 'https://signed.example.test/img-2',
        },
        {
          'id': 'img-1',
          'mimeType': 'image/jpeg',
          'byteSize': 20,
          'sortOrder': 0,
          'url': 'https://signed.example.test/img-1',
        },
        'not-an-object',
      ]);
      expect(images.map((image) => image.id), ['img-2', 'img-1']);
    });

    test('listFromJson returns empty for missing or non-list values', () {
      expect(RequestImage.listFromJson(null), isEmpty);
      expect(RequestImage.listFromJson('nope'), isEmpty);
    });
  });

  group('submitServiceRequestWithImages', () {
    test('sends the multipart contract with fields, files and idempotency', () async {
      http.Request? captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({
            'id': 'MOE-200',
            'status': 'pending_dispatch',
            'images': [
              {
                'id': 'img-1',
                'mimeType': 'image/jpeg',
                'byteSize': 1024,
                'sortOrder': 0,
                'url': 'https://signed.example.test/img-1',
              },
            ],
          }),
          201,
        );
      });

      final response = await submitServiceRequestWithImages(
        client: client,
        endpoint: Uri.parse('https://api.example.test/service-requests'),
        token: 'token-1',
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        timing: 'scheduled',
        details: 'مكيف لا يبرد',
        images: [
          _image(fileName: 'a.jpg', bytes: _jpegBytes()),
          _image(fileName: 'b.png', mimeType: 'image/png', bytes: _pngBytes()),
        ],
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
      );

      expect(response.statusCode, 201);
      final multipart = captured!;
      expect(multipart.method, 'POST');
      expect(multipart.url.path, '/service-requests');
      expect(multipart.headers['Authorization'], 'Bearer token-1');
      expect(
        multipart.headers['Idempotency-Key'],
        '11111111-1111-4111-8111-111111111111',
      );
      final body = latin1.decode(multipart.bodyBytes, allowInvalid: true);
      expect(body, contains('name="serviceId"'));
      expect(body, contains('ac-cleaning'));
      expect(body, contains('name="address"'));
      expect(body, contains('name="timing"'));
      expect(body, contains('scheduled'));
      expect(body, contains('name="details"'));
      expect(body, contains('name="images"'));
      expect(body, contains('filename="a.jpg"'));
      expect(body, contains('content-type: image/jpeg'));
      expect(body, contains('filename="b.png"'));
      expect(body, contains('content-type: image/png'));
    });

    test('generates a UUID v4 idempotency key when none is provided', () async {
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
        address: 'عنوان الخدمة',
        timing: 'as-soon-as-possible',
        images: [_image(bytes: _jpegBytes())],
      );

      final key = captured!.headers['Idempotency-Key'];
      expect(
        RegExp(
          r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-'
          r'[0-9a-f]{12}$',
        ).hasMatch(key!),
        isTrue,
        reason: 'generated "$key" is not a UUID v4',
      );
    });

    test('omits the details field when it is empty', () async {
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
        address: 'عنوان الخدمة',
        timing: 'as-soon-as-possible',
        images: const [],
      );

      expect(
        latin1.decode(captured!.bodyBytes, allowInvalid: true),
        isNot(contains('name="details"')),
      );
    });
  });

  group('BookingSubmissionIdentity', () {
    final uuidV4 = RegExp(
      r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-'
      r'[0-9a-f]{12}$',
    );

    String keyFor(
      BookingSubmissionIdentity identity, {
      String serviceId = 'ac-cleaning',
      String address = 'حي الصفراء، بريدة',
      String timing = 'as-soon-as-possible',
      String? details = 'مكيف لا يبرد',
      List<Uint8List>? bytes,
    }) => identity.keyFor(
      serviceId: serviceId,
      address: address,
      timing: timing,
      details: details,
      orderedImageBytes: bytes ?? [_jpegBytes()],
    );

    test('reuses the exact same key while the payload is unchanged', () {
      final identity = BookingSubmissionIdentity();
      final first = keyFor(identity);
      expect(uuidV4.hasMatch(first), isTrue);

      final second = keyFor(identity);
      expect(second, first);
    });

    test('mints a new key when a request-defining field changes', () {
      final identity = BookingSubmissionIdentity();
      final original = keyFor(identity);

      expect(keyFor(identity, serviceId: 'plumbing'), isNot(original));
      expect(keyFor(identity, address: 'حي آخر، بريدة'), isNot(original));
      expect(keyFor(identity, details: 'وصف مختلف'), isNot(original));
      expect(keyFor(identity, timing: 'scheduled'), isNot(original));
    });

    test('mints a new key when images are added, removed, replaced or reordered', () {
      final identity = BookingSubmissionIdentity();
      final original = keyFor(identity);

      // Replace: same count, different bytes.
      final replaced = keyFor(identity, bytes: [_pngBytes()]);
      expect(replaced, isNot(original));

      // Add: one more image.
      final added = keyFor(identity, bytes: [_pngBytes(), _jpegBytes()]);
      expect(added, isNot(replaced));

      // Remove: back to a single image.
      final removed = keyFor(identity, bytes: [_pngBytes()]);
      expect(removed, isNot(added));

      // Reorder: ordering participates in the fingerprint.
      final reordered = keyFor(identity, bytes: [_jpegBytes(), _pngBytes()]);
      expect(reordered, isNot(removed));

      // Unchanged payload after a change still reuses the latest key.
      expect(
        keyFor(identity, bytes: [_jpegBytes(), _pngBytes()]),
        reordered,
      );
    });

    test('does not key off image file names or MIME types', () {
      final identity = BookingSubmissionIdentity();
      // keyFor only receives content bytes: identical bytes always mean the
      // same key, so renaming/retyping a file cannot invalidate the key
      // (matching the server fingerprint, which hashes content only).
      final first = keyFor(identity);
      final second = keyFor(identity);
      expect(second, first);
    });

    test('clear() forgets the key so a new booking gets a fresh key', () {
      final identity = BookingSubmissionIdentity();
      final first = keyFor(identity);
      identity.clear();
      final second = keyFor(identity);
      expect(second, isNot(first));
      expect(uuidV4.hasMatch(second), isTrue);
    });

    test('clear() before any key is safe and the first key is still valid', () {
      final identity = BookingSubmissionIdentity();
      identity.clear();
      final key = keyFor(identity);
      expect(uuidV4.hasMatch(key), isTrue);
    });

    test('a null details value differs from an empty details value', () {
      final identity = BookingSubmissionIdentity();
      final withNull = keyFor(identity, details: null);
      final withEmpty = keyFor(identity, details: '');
      expect(withEmpty, isNot(withNull));
    });
  });
}
