"use client";

import dynamic from "next/dynamic";

const SendContent = dynamic(() => import("@/components/SendContent"), {
  ssr: false,
});

export default function Page() {
  return <SendContent />;
}
