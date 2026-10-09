import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "المعلّم العربي الذكي",
  description: "معلّم لغة عربية صوتي يعتمد على الكتب المدرسية المعتمدة للصفوف ٧–١٣.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body className="min-h-screen bg-bg antialiased">{children}</body>
    </html>
  );
}
