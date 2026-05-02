"use client";

import dynamic from "next/dynamic";

const InstallContent = dynamic(() => import("@/components/InstallContent"), {
  ssr: false,
});

export default function Page() {
  return <InstallContent />;
}
