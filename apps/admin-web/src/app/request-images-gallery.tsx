'use client';

import { useState } from 'react';
import type { ApiRequestImage } from './requests';
import styles from './page.module.css';

type RequestImagesGalleryProps = {
  images: ApiRequestImage[];
};

/**
 * Authorized request images for operations staff. Renders only the public
 * signed URLs the API authorized for this staff session; storage keys,
 * bucket details, credentials, and internal URLs are never part of the
 * image DTO. The server sort order is preserved by the parent.
 *
 * Plain <img> is intentional: the image URLs are short-lived signed
 * storage URLs whose host varies by environment, so the Next image
 * optimizer (which needs static remotePatterns) cannot be used, and the
 * signed query string must be fetched as-is.
 */
export default function RequestImagesGallery({
  images,
}: RequestImagesGalleryProps) {
  return (
    <div className={styles.imageGallery}>
      <strong>صور الطلب</strong>
      <div className={styles.imageGrid}>
        {images.map((image) => (
          <GalleryImage key={image.id} image={image} />
        ))}
      </div>
    </div>
  );
}

function GalleryImage({ image }: { image: ApiRequestImage }) {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>(
    'loading',
  );

  return (
    <a
      className={styles.imageThumbLink}
      href={image.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`فتح صورة الطلب رقم ${image.id} في نافذة جديدة`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- signed storage
          URLs vary by host and must be fetched as-is; see RequestImagesGallery. */}
      <img
        className={styles.imageThumb}
        src={image.url}
        alt={`صورة طلب ${image.id}`}
        loading="lazy"
        onLoad={() => setState('loaded')}
        onError={() => setState('failed')}
      />
      {state === 'loading' && (
        <span className={styles.imageThumbOverlay}>جارٍ التحميل…</span>
      )}
      {state === 'failed' && (
        <span className={styles.imageThumbOverlay} role="alert">
          تعذر تحميل الصورة
        </span>
      )}
    </a>
  );
}
