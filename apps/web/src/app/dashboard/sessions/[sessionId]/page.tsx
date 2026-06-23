"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { Radio, RefreshCw, Ban } from "lucide-react";
import { toast } from "sonner";

import {
  Api,
  openStream,
  type AuditEntry,
  type ContextEntry,
  type Session,
  type StreamEvent,
} from "@/lib/api";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function eventVariant(event: string): "default" | "secondary" | "destructive" | "outline" {
  if (event.startsWith("CTX_CONFLICT") || event.includes("DEAD_LETTER")) return "destructive";
  if (event.startsWith("CTX")) return "default";
  if (event.startsWith("MSG")) return "secondary";
  return "outline";
}

function fmtTime(ms?: number) {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString();
}

export default function SessionDetailPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [session, setSession] = React.useState<Session | null>(null);
  const [events, setEvents] = React.useState<StreamEvent[]>([]);
  const [live, setLive] = React.useState<"open" | "closed">("closed");
  const [entries, setEntries] = React.useState<ContextEntry[] | null>(null);
  const [audit, setAudit] = React.useState<AuditEntry[] | null>(null);

  const loadData = React.useCallback(() => {
    Api.sessions.get(sessionId).then(setSession).catch(() => {});
    Api.context.list(sessionId).then(setEntries).catch(() => setEntries([]));
    Api.audit.byRun(sessionId).then(setAudit).catch(() => setAudit([]));
  }, [sessionId]);

  React.useEffect(() => {
    loadData();
    const close = openStream(
      sessionId,
      (e) => {
        if (e.event === "CONNECTED" || e.event === "RESYNC") return;
        setEvents((prev) => [e, ...prev].slice(0, 200));
        // A context/message event means underlying data changed — refresh tabs.
        if (e.event.startsWith("CTX")) Api.context.list(sessionId).then(setEntries).catch(() => {});
      },
      setLive,
    );
    return close;
  }, [sessionId, loadData]);

  async function abort() {
    try {
      await Api.sessions.abort(sessionId);
      toast.success("Abort signalled");
      loadData();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <>
      <SiteHeader title={sessionId} />
      <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={live === "open" ? "default" : "outline"} className="gap-1">
            <Radio className={live === "open" ? "size-3 animate-pulse" : "size-3"} />
            {live === "open" ? "Live" : "Connecting…"}
          </Badge>
          {session && (
            <>
              <span className="text-sm text-muted-foreground">
                {session.members.length} agents · created by {session.createdBy}
              </span>
              {session.aborted && <Badge variant="destructive">aborted</Badge>}
            </>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" onClick={loadData}>
              <RefreshCw className="size-4" /> Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={abort} disabled={session?.aborted}>
              <Ban className="size-4" /> Abort
            </Button>
          </div>
        </div>

        <Tabs defaultValue="live">
          <TabsList>
            <TabsTrigger value="live">Live events</TabsTrigger>
            <TabsTrigger value="context">Context ({entries?.length ?? 0})</TabsTrigger>
            <TabsTrigger value="audit">Audit ({audit?.length ?? 0})</TabsTrigger>
          </TabsList>

          <TabsContent value="live">
            <Card className="py-0">
              <CardContent className="p-0">
                {events.length === 0 ? (
                  <p className="py-12 text-center text-sm text-muted-foreground">
                    Waiting for live events… writes and messages in this session appear here in real time.
                  </p>
                ) : (
                  <div className="max-h-[60vh] overflow-y-auto">
                    {events.map((e, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-3 border-b px-4 py-2 text-sm last:border-0"
                      >
                        <Badge variant={eventVariant(e.event)} className="font-mono">
                          {e.event}
                        </Badge>
                        <span className="flex-1 truncate text-muted-foreground">
                          {(e.fullKey as string) ??
                            (e.messageId as string) ??
                            (e.artifactId as string) ??
                            ""}
                          {e.writtenBy ? ` · by ${e.writtenBy}` : ""}
                          {typeof e.version === "number" ? ` · v${e.version}` : ""}
                        </span>
                        {typeof e.seq === "number" && (
                          <span className="text-xs text-muted-foreground">#{e.seq}</span>
                        )}
                        <span className="text-xs text-muted-foreground">{fmtTime(e.ts)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="context">
            <Card className="py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Key</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Written by</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {!entries || entries.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                        No context entries.
                      </TableCell>
                    </TableRow>
                  ) : (
                    entries.map((e) => (
                      <TableRow key={e.fullKey}>
                        <TableCell className="font-medium">{e.fullKey}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{e.value.type}</Badge>
                        </TableCell>
                        <TableCell>v{e.version}</TableCell>
                        <TableCell className="text-muted-foreground">{e.writtenBy}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>

          <TabsContent value="audit">
            <Card className="py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">Step</TableHead>
                    <TableHead>Event</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>Time</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {!audit || audit.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                        No audit entries.
                      </TableCell>
                    </TableRow>
                  ) : (
                    audit.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell className="tabular-nums text-muted-foreground">{a.step}</TableCell>
                        <TableCell>
                          <Badge variant={eventVariant(a.eventType)} className="font-mono">
                            {a.eventType}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{a.agentId}</TableCell>
                        <TableCell className="text-muted-foreground">{fmtTime(a.ts)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
