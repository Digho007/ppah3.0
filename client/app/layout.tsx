import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PPAH - Proof of Authentic Human",
  description: "Passwordless, Deepfake-Proof Verification System",
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
