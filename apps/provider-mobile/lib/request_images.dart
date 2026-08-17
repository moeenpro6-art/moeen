import 'package:flutter/material.dart';

/// Public projection of a committed request image as returned by the API
/// (`RequestImageDto`). Only the safe public fields are kept; storage keys
/// and internal data are never part of this shape.
class ProviderRequestImage {
  const ProviderRequestImage({
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

  factory ProviderRequestImage.fromJson(Map<String, dynamic> json) =>
      ProviderRequestImage(
        id: json['id'] as String,
        mimeType: json['mimeType'] as String? ?? 'image/jpeg',
        byteSize: (json['byteSize'] as num?)?.toInt() ?? 0,
        sortOrder: (json['sortOrder'] as num?)?.toInt() ?? 0,
        url: json['url'] as String,
        urlExpiresAt: json['urlExpiresAt'] as String?,
      );

  /// Preserves the server sort order (the array order from the API). The
  /// backend returns images ordered by `sortOrder`.
  static List<ProviderRequestImage> listFromJson(dynamic value) {
    if (value is! List) return const [];
    return value
        .whereType<Map<dynamic, dynamic>>()
        .map(
          (item) => ProviderRequestImage.fromJson(
            Map<String, dynamic>.from(item),
          ),
        )
        .toList();
  }
}

/// Responsive, order-preserving thumbnails for authorized request images
/// with loading and failure states. Tapping a tile opens a full-screen
/// viewer. Signed URL expiry/fetch failures render a neutral failure tile
/// without exposing storage internals.
class ProviderRequestImageThumbnails extends StatelessWidget {
  const ProviderRequestImageThumbnails({
    super.key,
    required this.images,
    this.thumbnailSize = 92,
    this.backgroundColor = const Color(0xFFF2F6F5),
  });

  final List<ProviderRequestImage> images;
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
        itemBuilder: (context, index) => _RemoteImageTile(
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
        builder: (_) =>
            _RequestImageViewer(images: images, initialIndex: index),
      ),
    );
  }
}

class _RemoteImageTile extends StatelessWidget {
  const _RemoteImageTile({
    required this.image,
    required this.size,
    required this.backgroundColor,
    required this.onTap,
  });

  final ProviderRequestImage image;
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

  final List<ProviderRequestImage> images;
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
