"use client";

import dynamic from "next/dynamic";

// SSR off — App content depends on browser-only modules (WalletConnect, WebAuthn, etc.).
const AppContent = dynamic(() => import("@/components/AppContent"), { ssr: false });

export default function Page() {
  return <AppContent />;
}
