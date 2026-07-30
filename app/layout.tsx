import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CGV 구로 경품 안내",
  description: "영화 경품과 재고 현황을 관리하고 전시하는 로컬 안내 화면",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
