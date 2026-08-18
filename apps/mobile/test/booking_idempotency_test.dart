import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:moeen_mobile/api_config.dart';
import 'package:moeen_mobile/customer_session.dart';
import 'package:moeen_mobile/main.dart';
import 'package:moeen_mobile/request_images.dart';

/// Behavior-level tests for the booking Idempotency-Key lifecycle.
///
/// The customer app must send the SAME UUID v4 Idempotency-Key on every
/// retry of an unchanged multipart booking, so a retry after a lost or
/// failed HTTP response replays the committed request server-side instead
/// of creating a duplicate. Any change to a request-defining input must
/// mint a NEW key, a confirmed 201 must clear the stored key, and the
/// zero-image JSON path must stay keyless (the API has no idempotency
/// contract there).
void main() {
  testWidgets(
    'retry after a lost response reuses the same Idempotency-Key',
    (tester) async {
      _useTallViewport(tester);

      final keys = <String?>[];
      var calls = 0;
      final client = MockClient((request) async {
        keys.add(_idempotencyKeyOf(request));
        calls++;
        if (calls == 1) {
          throw http.ClientException('connection reset by peer');
        }
        return _created('MOE-100');
      });

      await _pumpBookingPage(
        tester,
        client: client,
        picker: _QueuePicker([
          [_pickedImage(1)],
        ]),
      );

      await tester.enterText(
        find.byType(TextFormField).first,
        'حي الصفراء، بريدة',
      );
      await tester.tap(find.text('إضافة صور للخدمة'));
      await tester.pump();

      await tester.tap(find.text('متابعة الطلب'));
      await _settle(tester);

      expect(keys, hasLength(1));
      expect(_uuidV4.hasMatch(keys.first!), isTrue,
          reason: 'first attempt sent "${keys.first}"');
      expect(find.text(_genericFailureMessage), findsOneWidget);

      // Same unchanged booking, retried after the lost response.
      await tester.tap(find.text('متابعة الطلب'));
      await _settle(tester);

      expect(keys, hasLength(2));
      expect(keys[1], keys[0],
          reason: 'retry of the unchanged payload must reuse the key');
      expect(find.text('تم استلام طلبك بنجاح'), findsOneWidget);
    },
  );

  testWidgets(
    'retryable server failures (5xx) keep the same Idempotency-Key',
    (tester) async {
      _useTallViewport(tester);

      final keys = <String?>[];
      var calls = 0;
      final client = MockClient((request) async {
        keys.add(_idempotencyKeyOf(request));
        calls++;
        if (calls < 3) return http.Response('', 503);
        return _created('MOE-101');
      });

      await _pumpBookingPage(
        tester,
        client: client,
        picker: _QueuePicker([
          [_pickedImage(1)],
        ]),
      );

      await tester.enterText(
        find.byType(TextFormField).first,
        'حي الصفراء، بريدة',
      );
      await tester.tap(find.text('إضافة صور للخدمة'));
      await tester.pump();

      for (var attempt = 0; attempt < 3; attempt++) {
        await tester.tap(find.text('متابعة الطلب'));
        await _settle(tester);
      }

      expect(keys, hasLength(3));
      expect(keys[1], keys[0]);
      expect(keys[2], keys[0],
          reason: '503 failures must not mint a new key');
      expect(find.text('تم استلام طلبك بنجاح'), findsOneWidget);
    },
  );

  testWidgets(
    'editing a request-defining field after a failure mints a new key',
    (tester) async {
      _useTallViewport(tester);

      final keys = <String?>[];
      var calls = 0;
      final client = MockClient((request) async {
        keys.add(_idempotencyKeyOf(request));
        calls++;
        if (calls == 1) return http.Response('', 503);
        return _created('MOE-102');
      });

      await _pumpBookingPage(
        tester,
        client: client,
        picker: _QueuePicker([
          [_pickedImage(1)],
        ]),
      );

      await tester.enterText(
        find.byType(TextFormField).first,
        'حي الصفراء، بريدة',
      );
      await tester.tap(find.text('إضافة صور للخدمة'));
      await tester.pump();

      await tester.tap(find.text('متابعة الطلب'));
      await _settle(tester);
      expect(keys, hasLength(1));

      // The address is part of the create-request fingerprint: changing it
      // must invalidate the stored key.
      await tester.enterText(
        find.byType(TextFormField).first,
        'حي الريان، بريدة',
      );
      await tester.pump();

      await tester.tap(find.text('متابعة الطلب'));
      await _settle(tester);

      expect(keys, hasLength(2));
      expect(keys[1], isNot(keys[0]),
          reason: 'a changed payload must not reuse the previous key');
      expect(find.text('تم استلام طلبك بنجاح'), findsOneWidget);
    },
  );

  testWidgets(
    'adding, replacing or removing an image after a failure mints new keys',
    (tester) async {
      _useTallViewport(tester);

      final keys = <String?>[];
      var calls = 0;
      final client = MockClient((request) async {
        keys.add(_idempotencyKeyOf(request));
        calls++;
        if (calls < 4) return http.Response('', 503);
        return _created('MOE-103');
      });

      await _pumpBookingPage(
        tester,
        client: client,
        picker: _QueuePicker([
          [_pickedImage(1)], // initial add
          [_pickedImage(2)], // add a second image
          [_pickedImage(3)], // replace the first image
        ]),
      );

      await tester.enterText(
        find.byType(TextFormField).first,
        'حي الصفراء، بريدة',
      );
      await tester.tap(find.text('إضافة صور للخدمة'));
      await tester.pump();

      await tester.tap(find.text('متابعة الطلب'));
      await _settle(tester);
      final keyOneImage = keys.single;

      // Add: a second image changes the ordered content.
      await tester.tap(find.text('إضافة صورة أخرى (1/5)'));
      await tester.pump();
      await tester.tap(find.text('متابعة الطلب'));
      await _settle(tester);
      final keyTwoImages = keys.last;
      expect(keyTwoImages, isNot(keyOneImage));

      // Replace: the first image gets different bytes.
      await tester.tap(find.byTooltip('استبدال الصورة').first);
      await tester.pump();
      await tester.tap(find.text('متابعة الطلب'));
      await _settle(tester);
      final keyReplaced = keys.last;
      expect(keyReplaced, isNot(keyTwoImages));

      // Remove: back down to a single (replaced) image.
      await tester.tap(find.byTooltip('إزالة الصورة').first);
      await tester.pump();
      await tester.tap(find.text('متابعة الطلب'));
      await _settle(tester);
      final keyRemoved = keys.last;
      expect(keyRemoved, isNot(keyReplaced));

      expect(find.text('تم استلام طلبك بنجاح'), findsOneWidget);
    },
  );

  testWidgets(
    'a 409 conflict clears the poisoned key so the retry mints a fresh one',
    (tester) async {
      _useTallViewport(tester);

      final keys = <String?>[];
      var calls = 0;
      final client = MockClient((request) async {
        keys.add(_idempotencyKeyOf(request));
        calls++;
        if (calls == 1) {
          return http.Response(
            jsonEncode({
              'message':
                  'Idempotency-Key was already used with different content',
            }),
            409,
            headers: {'content-type': 'application/json; charset=utf-8'},
          );
        }
        return _created('MOE-104');
      });

      await _pumpBookingPage(
        tester,
        client: client,
        picker: _QueuePicker([
          [_pickedImage(1)],
        ]),
      );

      await tester.enterText(
        find.byType(TextFormField).first,
        'حي الصفراء، بريدة',
      );
      await tester.tap(find.text('إضافة صور للخدمة'));
      await tester.pump();

      await tester.tap(find.text('متابعة الطلب'));
      await _settle(tester);
      expect(find.text(_conflictMessage), findsOneWidget);

      await tester.tap(find.text('متابعة الطلب'));
      await _settle(tester);

      expect(keys, hasLength(2));
      expect(keys[1], isNot(keys[0]),
          reason: 'the 409-poisoned key must not be reused');
      expect(find.text('تم استلام طلبك بنجاح'), findsOneWidget);
    },
  );

  testWidgets(
    'the zero-image JSON path never sends an Idempotency-Key',
    (tester) async {
      _useTallViewport(tester);

      final keys = <String?>[];
      final client = MockClient((request) async {
        keys.add(_idempotencyKeyOf(request));
        return _created('MOE-105');
      });

      await _pumpBookingPage(
        tester,
        client: client,
        picker: _QueuePicker([]),
      );

      await tester.enterText(
        find.byType(TextFormField).first,
        'حي الصفراء، بريدة',
      );
      await tester.tap(find.text('متابعة الطلب'));
      await _settle(tester);

      expect(keys, hasLength(1));
      expect(keys.single, isNull,
          reason: 'the API JSON create path has no idempotency contract; '
              'the client must not invent one');
      expect(find.text('تم استلام طلبك بنجاح'), findsOneWidget);
    },
  );
}

const _genericFailureMessage =
    'تعذر إرسال الطلب الآن. تحقق من اتصالك ثم أعد المحاولة. احتفظنا بما أدخلته.';

const _conflictMessage = 'حدث تعارض مع محاولة سابقة. أعد المحاولة لإرسال طلبك.';

final _uuidV4 = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
);

http.Response _created(String id) => http.Response(
  jsonEncode({'id': id}),
  201,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

void _useTallViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(800, 2000);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

/// Pumps a BookingPage wired to a fake session store, a MockClient, and a
/// queued image picker so the widget test never touches platform channels
/// or the network.
Future<void> _pumpBookingPage(
  WidgetTester tester, {
  required MockClient client,
  required RequestImagePicker picker,
}) async {
  final store = _MemorySessionStore();
  final sessionManager = CustomerSessionManager(store);
  await sessionManager.save(token: 'token-1', customerId: 'cus-1');
  await tester.pumpWidget(
    MaterialApp(
      home: BookingPage(
        service: MoeenApp.launchServices.first,
        imagePicker: picker,
        sessionManager: sessionManager,
        httpClient: client,
        apiConfig: const MoeenApiConfig('https://api.example.test'),
      ),
    ),
  );
}

/// Pumps enough frames for the async submit chain (session restore, mock
/// request, snackbar/navigation) to settle.
Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

String? _idempotencyKeyOf(http.Request request) {
  for (final entry in request.headers.entries) {
    if (entry.key.toLowerCase() == 'idempotency-key') return entry.value;
  }
  return null;
}

/// JPEG magic bytes plus a salt. Not a decodable JPEG; the booking tiles
/// render their errorBuilder for these, which is irrelevant to the
/// idempotency assertions.
Uint8List _jpegBytes(int salt) => Uint8List.fromList([
  0xFF,
  0xD8,
  0xFF,
  0xE0,
  salt,
  0x00,
  0x10,
  0x4A,
  0x46,
  0x49,
  0x46,
  0x00,
  0x01,
]);

PickedImageFile _pickedImage(int salt) => PickedImageFile(
  fileName: 'photo-$salt.jpg',
  mimeType: 'image/jpeg',
  size: 12,
  bytes: _jpegBytes(salt),
);

class _MemorySessionStore implements SessionKeyValueStore {
  final Map<String, String> values = {};

  @override
  Future<void> write(String key, String value) async => values[key] = value;

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> deleteAll() async => values.clear();
}

class _QueuePicker implements RequestImagePicker {
  _QueuePicker(this.batches);

  final List<List<PickedImageFile>> batches;
  int _index = 0;

  @override
  Future<List<PickedImageFile>> pickImages() async {
    if (_index >= batches.length) return const [];
    return batches[_index++];
  }
}
