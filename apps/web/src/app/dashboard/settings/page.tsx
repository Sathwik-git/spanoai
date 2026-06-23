"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Api, ApiError, auth, type AuthUser } from "@/lib/api";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function SettingsPage() {
  const router = useRouter();
  const [user, setUser] = React.useState<AuthUser | null>(null);
  const [apiUrl, setApiUrl] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    setUser(auth.getUser());
    setApiUrl(auth.getUrl());
  }, []);

  async function save() {
    setSaving(true);
    auth.setUrl(apiUrl.trim());
    try {
      await Api.auth.me();
      toast.success("Settings saved and verified");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Could not reach the API.";
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  async function signOut() {
    try {
      await Api.auth.logout();
    } catch {
      /* best-effort */
    }
    auth.clear();
    router.replace("/login");
  }

  return (
    <>
      <SiteHeader title="Settings" />
      <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
        <Card className="max-w-2xl">
          <CardHeader>
            <CardTitle className="text-base">Account</CardTitle>
            <CardDescription>The signed-in user and tenant for this dashboard.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label>Email</Label>
              <Input value={user?.email ?? ""} readOnly disabled />
            </div>
            <div className="grid gap-2">
              <Label>Organization</Label>
              <Input value={user?.name ?? ""} readOnly disabled />
            </div>
            <div className="grid gap-2">
              <Label>Tenant id</Label>
              <Input value={user?.tenantId ?? ""} readOnly disabled className="font-mono text-xs" />
            </div>
          </CardContent>
        </Card>

        <Card className="max-w-2xl">
          <CardHeader>
            <CardTitle className="text-base">Connection</CardTitle>
            <CardDescription>
              Which SpanoAI engine this dashboard talks to. Your session token is stored only
              in this browser.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="apiUrl">API URL</Label>
              <Input id="apiUrl" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} />
            </div>
          </CardContent>
          <CardFooter className="mt-2">
            <Button onClick={save} disabled={saving}>
              Save &amp; verify
            </Button>
          </CardFooter>
        </Card>

        <Card className="max-w-2xl border-destructive/30">
          <CardHeader>
            <CardTitle className="text-base">Sign out</CardTitle>
            <CardDescription>End this session and return to the login screen.</CardDescription>
          </CardHeader>
          <CardFooter>
            <Button variant="destructive" onClick={signOut}>
              Sign out
            </Button>
          </CardFooter>
        </Card>
      </div>
    </>
  );
}
