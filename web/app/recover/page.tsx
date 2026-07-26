"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";

const RecoverContent = dynamic(() => import("@/components/RecoverContent"), {
  ssr: false,
});

export default function Page() {
  // useSearchParams needs a Suspense boundary in the app router.
  return (
    <Suspense fallback={null}>
      <RecoverContent />
    </Suspense>
  );
}
