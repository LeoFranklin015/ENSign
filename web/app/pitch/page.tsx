"use client";

import dynamic from "next/dynamic";

const PitchDeck = dynamic(() => import("@/components/PitchDeck"), {
  ssr: false,
});

export default function Page() {
  return <PitchDeck />;
}
