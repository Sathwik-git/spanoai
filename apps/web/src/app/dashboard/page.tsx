"use client";

import * as React from "react";
import Link from "next/link";
import { Activity, Network, Users, KeyRound, ArrowRight } from "lucide-react";

import { Api, auth, type Session } from "@/lib/api";
import { SiteHeader } from "@/components/site-header";
import { MetricCard } from "@/components/metric-card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function OverviewPage() {
  const [sessions, setSessions] = React.useState<Session[] | null>(null);
  const apiUrl = auth.getUrl();

  React.useEffect(() => {
    Api.sessions.list().then(setSessions).catch(() => setSessions([]));
  }, []);

  const totalAgents = sessions?.reduce((n, s) => n + s.members.length, 0) ?? 0;
  const aborted = sessions?.filter((s) => s.aborted).length ?? 0;

  const quickstart = `import { SpanoAIClient } from "@spanoai/sdk";

const spano = new SpanoAIClient({
  baseUrl: "${apiUrl}",
  apiKey: process.env.SPANOAI_API_KEY!, // create one under "API Keys"
  agent: "researcher",
});

await spano.context.write("run-1", "researcher", "findings", { revenue: "$4.2M" });
const data = await spano.context.read("run-1", "researcher", "findings");`;

  return (
    <>
      <SiteHeader title="Overview" />
      <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sessions === null ? (
            Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28" />)
          ) : (
            <>
              <MetricCard label="Active sessions" value={sessions.length} icon={Network} hint="Live coordination runs" />
              <MetricCard label="Agents" value={totalAgents} icon={Users} hint="Across all sessions" />
              <MetricCard label="Aborted" value={aborted} icon={Activity} hint="Sessions signalled to cancel" />
            </>
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="size-4" /> API keys
            </CardTitle>
            <CardDescription>
              Mint scoped keys for the SDK and MCP server. The full key is shown once, at
              creation.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/dashboard/api-keys">
                Manage API keys <ArrowRight className="size-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Quickstart</CardTitle>
            <CardDescription>Write from one agent, read from another — in three lines.</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-md bg-muted p-4 text-xs leading-relaxed">
              <code>{quickstart}</code>
            </pre>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent sessions</CardTitle>
            <CardDescription>Most recent coordination runs for your tenant.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {sessions === null ? (
              <Skeleton className="h-20" />
            ) : sessions.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No sessions yet. Create one with the SDK, then it appears here.
              </p>
            ) : (
              sessions.slice(0, 5).map((s) => (
                <Link
                  key={s.sessionId}
                  href={`/dashboard/sessions/${s.sessionId}`}
                  className="flex items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors hover:bg-accent"
                >
                  <span className="font-medium">{s.sessionId}</span>
                  <span className="flex items-center gap-3 text-muted-foreground">
                    <span>{s.members.length} agents</span>
                    <Badge variant={s.aborted ? "destructive" : "secondary"}>
                      {s.aborted ? "aborted" : s.status}
                    </Badge>
                  </span>
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
