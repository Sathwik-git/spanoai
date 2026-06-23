"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { auth } from "@/lib/api";
import { AppSidebar } from "@/components/app-sidebar";
import { BrandLoader } from "@/components/brand-loader";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    if (!auth.hasToken()) {
      router.replace("/login");
    } else {
      setReady(true);
    }
  }, [router]);

  if (!ready) return <BrandLoader label="Loading…" />;

  return (
    <SidebarProvider>
      <AppSidebar variant="inset" />
      <SidebarInset>{children}</SidebarInset>
    </SidebarProvider>
  );
}
