"use client";

import dynamic from "next/dynamic";

const RecoveryContent = dynamic(() => import("@/components/RecoveryContent"), {
  ssr: false,
});

export default function Page() {
  return <RecoveryContent />;
}
