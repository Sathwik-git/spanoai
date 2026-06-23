"use client";

import * as React from "react";
import Link from "next/link";
import { Plus, RefreshCw, ArrowRight } from "lucide-react";
import { toast } from "sonner";

import { Api, type Session } from "@/lib/api";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function timeAgo(ms: number) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function SessionsPage() {
  const [sessions, setSessions] = React.useState<Session[] | null>(null);
  const [creating, setCreating] = React.useState(false);

  const load = React.useCallback(() => {
    setSessions(null);
    Api.sessions.list().then(setSessions).catch((e) => {
      toast.error(e.message ?? "Failed to load sessions");
      setSessions([]);
    });
  }, []);

  React.useEffect(load, [load]);

  async function createSession() {
    setCreating(true);
    try {
      const s = await Api.sessions.create();
      toast.success(`Created ${s.sessionId}`);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <SiteHeader title="Sessions" />
      <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {sessions ? `${sessions.length} active session(s)` : "Loading…"}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={load}>
              <RefreshCw className="size-4" /> Refresh
            </Button>
            <Button size="sm" onClick={createSession} disabled={creating}>
              <Plus className="size-4" /> New session
            </Button>
          </div>
        </div>

        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Session</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Agents</TableHead>
                <TableHead>Created by</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">{""}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions === null ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={6}>
                      <Skeleton className="h-6 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              ) : sessions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                    No sessions yet. Click <span className="font-medium">New session</span> or create one with the SDK.
                  </TableCell>
                </TableRow>
              ) : (
                sessions.map((s) => (
                  <TableRow key={s.sessionId}>
                    <TableCell className="font-medium">{s.sessionId}</TableCell>
                    <TableCell>
                      <Badge variant={s.aborted ? "destructive" : "secondary"}>
                        {s.aborted ? "aborted" : s.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{s.members.length}</TableCell>
                    <TableCell className="text-muted-foreground">{s.createdBy}</TableCell>
                    <TableCell className="text-muted-foreground">{timeAgo(s.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/dashboard/sessions/${s.sessionId}`}>
                          View <ArrowRight className="size-4" />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>
      </div>
    </>
  );
}
