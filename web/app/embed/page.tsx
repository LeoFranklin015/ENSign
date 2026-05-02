"use client";

import dynamic from "next/dynamic";

// SSR off — embed depends on browser-only WebAuthn / postMessage APIs.
const EmbedContent = dynamic(() => import("@/components/EmbedContent"), { ssr: false });

export default function Page() {
  return <EmbedContent />;
}
