import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'معين | لوحة التشغيل',
  description: 'لوحة تشغيل معين لخدمات المنزل في القصيم',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
