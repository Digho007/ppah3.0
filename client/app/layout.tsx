import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PPAH - Privacy-Preserving Adaptive Hashing",
  description: "Passwordless, Deepfake-Proof Verification System for Remote Sessions developed by Jeremiah Dighomanor",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
