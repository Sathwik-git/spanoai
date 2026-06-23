"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { auth } from "@/lib/api";
import { BrandLoader } from "@/components/brand-loader";

export default function RootPage() {
  const router = useRouter();

  React.useEffect(() => {
    router.replace(auth.hasToken() ? "/dashboard" : "/login");
  }, [router]);

  return <BrandLoader label="Loading…" />;
}
