import 'dart:math';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart' show MediaType;
import 'package:image_picker/image_picker.dart' show ImagePicker;

/// Client-side limits mirror the API contract
/// (`apps/api/src/request-image.service.ts`):
/// at most 5 images, 5 MiB per image, 20 MiB in total.
const int maxRequestImages = 5;
const int maxRequestImageBytes = 5 * 1024 * 1024;
const int maxRequestImageAggregateBytes = 20 * 1024 * 1024;

const Set<String> supportedRequestImageMimeTypes = {
  'image/jpeg',
  'image/png',
  'image/webp',
};

/// Public projection of a committed request image as returned by the API
/// (`RequestImageDto`). Never carries storage keys or internals.
class RequestImage {
  const RequestImage({
    required this.id,
    required this.mimeType,
    required this.byteSize,
    required this.sortOrder,
    required this.url,
    this.urlExpiresAt,
  });

  final String id;
  final String mimeType;
  final int byteSize;
  final int sortOrder;
  final String url;
  final String? urlExpiresAt;

  factory RequestImage.fromJson(Map<String, dynamic> json) => RequestImage(
    id: json['id'] as String,
    mimeType: json['mimeType'] as String? ?? 'image/jpeg',
    byteSize: (json['byteSize'] as num?)?.toInt() ?? 0,
    sortOrder: (json['sortOrder'] as num?)?.toInt() ?? 0,
    url: json['url'] as String,
    urlExpiresAt: json['urlExpiresAt'] as String?,
  );

  static List<RequestImage> listFromJson(dynamic value) {
    if (value is! List) return const [];
    return value
        .whereType<Map<dynamic, dynamic>>()
        .map((item) => RequestImage.fromJson(Map<String, dynamic>.from(item)))
        .toList();
  }
}

/// A locally selected (not yet uploaded) image for a service request.
class SelectedRequestImage {
  SelectedRequestImage({
    required this.fileName,
    required this.mimeType,
    required this.size,
    required this.bytes,
  });

  final String fileName;
  final String mimeType;
  final int size;
  final Uint8List bytes;
}

/// Detects the real image format from magic bytes so the multipart MIME type
/// always matches the content (the API rejects mismatches).
String? sniffImageMimeType(Uint8List bytes) {
  if (bytes.length >= 3 &&
      bytes[0] == 0xFF &&
      bytes[1] == 0xD8 &&
      bytes[2] == 0xFF) {
    return 'image/jpeg';
  }
  if (bytes.length >= 8 &&
      bytes[0] == 0x89 &&
      bytes[1] == 0x50 &&
      bytes[2] == 0x4E &&
      bytes[3] == 0x47 &&
      bytes[4] == 0x0D &&
      bytes[5] == 0x0A &&
      bytes[6] == 0x1A &&
      bytes[7] == 0x0A) {
    return 'image/png';
  }
  if (bytes.length >= 12 &&
      String.fromCharCodes(bytes.sublist(0, 4)) == 'RIFF' &&
      String.fromCharCodes(bytes.sublist(8, 12)) == 'WEBP') {
    return 'image/webp';
  }
  return null;
}

String? imageMimeTypeFromFileName(String fileName) {
  final lower = fileName.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  return null;
}

/// Validates a full selection before submission. Returns an Arabic user
/// message when the selection is invalid, or null when it is acceptable.
/// Frontend validation improves UX only; the API remains authoritative.
String? validateRequestImageSelection(List<SelectedRequestImage> images) {
  if (images.length > maxRequestImages) {
    return 'الحد الأقصى $maxRequestImages صور لكل طلب';
  }
  var aggregateBytes = 0;
  for (final image in images) {
    if (!supportedRequestImageMimeTypes.contains(image.mimeType)) {
      return 'صيغة غير مدعومة (${image.fileName}) — الصيغ المدعومة: JPEG وPNG وWebP';
    }
    if (image.size < 1 || image.size > maxRequestImageBytes) {
      return 'حجم الصورة (${image.fileName}) يتجاوز الحد الأقصى 5 م.ب';
    }
    aggregateBytes += image.size;
  }
  if (aggregateBytes > maxRequestImageAggregateBytes) {
    return 'الحجم الإجمالي للصور يتجاوز 20 م.ب';
  }
  return null;
}

/// Detects the exact same file selected twice (the API rejects duplicate
/// content). Byte-length comparison plus full content equality is enough for
/// a handful of user-picked images.
bool requestImageBytesEqual(Uint8List left, Uint8List right) {
  if (left.length != right.length) return false;
  for (var i = 0; i < left.length; i++) {
    if (left[i] != right[i]) return false;
  }
  return true;
}

String? duplicateRequestImageError(List<SelectedRequestImage> images) {
  for (var i = 0; i < images.length; i++) {
    for (var j = i + 1; j < images.length; j++) {
      if (requestImageBytesEqual(images[i].bytes, images[j].bytes)) {
        return 'تم اختيار الصورة نفسها أكثر من مرة';
      }
    }
  }
  return null;
}

/// UUID v4 for the multipart Idempotency-Key. The API rejects multipart
/// submissions without a valid UUID v4 key.
String generateUuidV4() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 0x0F) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3F) | 0x80; // variant 10xx
  final hex = bytes
      .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
      .join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
      '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

/// Holds the multipart submission Idempotency-Key for the current booking
/// payload together with a snapshot of the payload the key was minted for.
///
/// Lifecycle:
/// - [keyFor] returns the stored key while the payload snapshot is unchanged,
///   and mints a fresh UUID v4 key whenever any request-defining input
///   changed (service id, address, details, timing, or the ORDERED image
///   bytes — the same inputs the API folds into its submission fingerprint).
/// - [clear] drops the stored key. Callers clear after a confirmed 201
///   Created (the booking is committed and the key is spent) and after a 409
///   idempotency conflict (the server permanently bound that key to
///   different content, so the key can never succeed again).
///
/// A transport failure, timeout, dropped response, or retryable server
/// failure must NOT clear the key: a retry of the unchanged payload then
/// reuses the exact same key, and the API replays the committed request
/// instead of creating a duplicate.
class BookingSubmissionIdentity {
  String? _key;
  String? _serviceId;
  String? _address;
  String? _details;
  String? _timing;
  List<Uint8List>? _orderedImageBytes;

  String keyFor({
    required String serviceId,
    required String address,
    required String timing,
    String? details,
    required List<Uint8List> orderedImageBytes,
  }) {
    final storedKey = _key;
    final unchanged =
        storedKey != null &&
        _serviceId == serviceId &&
        _address == address &&
        _details == details &&
        _timing == timing &&
        _imageBytesMatch(_orderedImageBytes!, orderedImageBytes);
    if (!unchanged) {
      _key = generateUuidV4();
      _serviceId = serviceId;
      _address = address;
      _details = details;
      _timing = timing;
      _orderedImageBytes = List.of(orderedImageBytes);
    }
    return _key!;
  }

  /// Forgets the stored key and its payload snapshot. Safe to call when no
  /// key is stored.
  void clear() {
    _key = null;
    _serviceId = null;
    _address = null;
    _details = null;
    _timing = null;
    _orderedImageBytes = null;
  }

  static bool _imageBytesMatch(
    List<Uint8List> stored,
    List<Uint8List> current,
  ) {
    if (stored.length != current.length) return false;
    for (var i = 0; i < stored.length; i++) {
      if (!requestImageBytesEqual(stored[i], current[i])) return false;
    }
    return true;
  }
}

/// A file selected from the device gallery before it is uploaded.
class PickedImageFile {
  const PickedImageFile({
    required this.fileName,
    required this.mimeType,
    required this.size,
    required this.bytes,
  });

  final String fileName;
  final String mimeType;
  final int size;
  final Uint8List bytes;
}

/// Test seam around the platform image picker so widget tests never touch
/// platform channels.
abstract class RequestImagePicker {
  Future<List<PickedImageFile>> pickImages();
}

class ImagePickerRequestImagePicker implements RequestImagePicker {
  ImagePickerRequestImagePicker({this.maxCount = maxRequestImages});

  final int maxCount;

  @override
  Future<List<PickedImageFile>> pickImages() async {
    final picker = ImagePicker();
    final files = await picker.pickMultiImage(
      imageQuality: 90,
      limit: maxCount,
    );
    if (files.isEmpty) return const [];
    final result = <PickedImageFile>[];
    for (final file in files) {
      final bytes = await file.readAsBytes();
      final mimeType =
          sniffImageMimeType(bytes) ??
          imageMimeTypeFromFileName(file.name) ??
          (file.mimeType == null || file.mimeType!.isEmpty
              ? 'application/octet-stream'
              : file.mimeType!);
      result.add(
        PickedImageFile(
          fileName: file.name.isEmpty ? 'صورة' : file.name,
          mimeType: mimeType,
          size: bytes.length,
          bytes: bytes,
        ),
      );
    }
    return result;
  }
}

/// Submits a service request with images using the multipart contract:
/// fields `serviceId`, `address`, `details`, `timing`, files under `images`,
/// and a UUID v4 `Idempotency-Key` header.
Future<http.Response> submitServiceRequestWithImages({
  required http.Client client,
  required Uri endpoint,
  required String token,
  required String serviceId,
  required String address,
  required String timing,
  String? details,
  required List<SelectedRequestImage> images,
  String? idempotencyKey,
}) async {
  final multipart = http.MultipartRequest('POST', endpoint)
    ..headers['Authorization'] = 'Bearer $token'
    ..headers['Idempotency-Key'] = idempotencyKey ?? generateUuidV4()
    ..fields['serviceId'] = serviceId
    ..fields['address'] = address
    ..fields['timing'] = timing;
  final normalizedDetails = details?.trim() ?? '';
  if (normalizedDetails.isNotEmpty) {
    multipart.fields['details'] = normalizedDetails;
  }
  for (final image in images) {
    multipart.files.add(
      http.MultipartFile.fromBytes(
        'images',
        image.bytes,
        filename: image.fileName,
        contentType: MediaType.parse(image.mimeType),
      ),
    );
  }
  final streamed = await client.send(multipart);
  return http.Response.fromStream(streamed);
}

/// Responsive, order-preserving thumbnails for committed request images with
/// loading and failure states. Tapping a tile opens a full-screen viewer.
class RequestImageThumbnails extends StatelessWidget {
  const RequestImageThumbnails({
    super.key,
    required this.images,
    this.thumbnailSize = 92,
    this.backgroundColor = const Color(0xFFF2F6F5),
  });

  final List<RequestImage> images;
  final double thumbnailSize;
  final Color backgroundColor;

  @override
  Widget build(BuildContext context) {
    if (images.isEmpty) return const SizedBox.shrink();
    return SizedBox(
      height: thumbnailSize,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: images.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (context, index) => _RemoteRequestImageTile(
          image: images[index],
          size: thumbnailSize,
          backgroundColor: backgroundColor,
          onTap: () => _openViewer(context, index),
        ),
      ),
    );
  }

  void _openViewer(BuildContext context, int index) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => _RequestImageViewer(images: images, initialIndex: index),
      ),
    );
  }
}

class _RemoteRequestImageTile extends StatelessWidget {
  const _RemoteRequestImageTile({
    required this.image,
    required this.size,
    required this.backgroundColor,
    required this.onTap,
  });

  final RequestImage image;
  final double size;
  final Color backgroundColor;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'صورة الطلب',
      button: true,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(12),
          child: SizedBox(
            width: size,
            height: size,
            child: Image.network(
              image.url,
              fit: BoxFit.cover,
              loadingBuilder: (context, child, progress) {
                if (progress == null) return child;
                return ColoredBox(
                  color: backgroundColor,
                  child: Center(
                    child: SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        value: progress.expectedTotalBytes == null
                            ? null
                            : progress.cumulativeBytesLoaded /
                                  progress.expectedTotalBytes!,
                      ),
                    ),
                  ),
                );
              },
              errorBuilder: (context, error, stackTrace) => ColoredBox(
                color: backgroundColor,
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      Icons.broken_image_outlined,
                      size: 26,
                      color: Colors.grey.shade600,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'تعذر تحميل الصورة',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 10,
                        color: Colors.grey.shade600,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _RequestImageViewer extends StatelessWidget {
  const _RequestImageViewer({
    required this.images,
    required this.initialIndex,
  });

  final List<RequestImage> images;
  final int initialIndex;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: Text('${initialIndex + 1} / ${images.length}'),
      ),
      body: PageView.builder(
        controller: PageController(initialPage: initialIndex),
        itemCount: images.length,
        itemBuilder: (context, index) => Center(
          child: InteractiveViewer(
            maxScale: 5,
            child: Image.network(
              images[index].url,
              fit: BoxFit.contain,
              loadingBuilder: (context, child, progress) {
                if (progress == null) return child;
                return const Center(
                  child: CircularProgressIndicator(color: Colors.white),
                );
              },
              errorBuilder: (context, error, stackTrace) => const Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(
                    Icons.broken_image_outlined,
                    color: Colors.white70,
                    size: 48,
                  ),
                  SizedBox(height: 12),
                  Text(
                    'تعذر تحميل الصورة — قد تكون صلاحية الرابط انتهت',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.white70),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
