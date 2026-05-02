"use client";

import dynamic from "next/dynamic";

const AgentsContent = dynamic(() => import("@/components/AgentsContent"), {
  ssr: false,
});

export default function Page() {
  return <AgentsContent />;
}
