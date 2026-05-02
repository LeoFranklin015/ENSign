import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ENSign",
  description: "Sign with ENS. Subname is the wallet.",
  icons: { icon: "/vite.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://api.fontshare.com" />
        <link rel="preconnect" href="https://cdn.fontshare.com" crossOrigin="" />
      </head>
      <body>{children}</body>
    </html>
  );
}
