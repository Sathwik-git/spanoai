"use client";

import * as React from "react";
import { Copy, KeyRound, Loader2, Plus, Trash2, Check } from "lucide-react";
import { toast } from "sonner";

import { Api, ApiError, ALL_SCOPES, type ApiKeySummary, type CreatedApiKey } from "@/lib/api";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

export default function ApiKeysPage() {
  const [keys, setKeys] = React.useState<ApiKeySummary[] | null>(null);
  const [name, setName] = React.useState("");
  const [scopes, setScopes] = React.useState<string[]>([...ALL_SCOPES]);
  const [creating, setCreating] = React.useState(false);
  const [created, setCreated] = React.useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = React.useState(false);

  const load = React.useCallback(() => {
    Api.keys
      .list()
      .then(setKeys)
      .catch(() => setKeys([]));
  }, []);

  React.useEffect(() => load(), [load]);

  function toggleScope(scope: string) {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (scopes.length === 0) {
      toast.error("Select at least one scope.");
      return;
    }
    setCreating(true);
    setCreated(null);
    try {
      const result = await Api.keys.create(name.trim() || "default", scopes);
      setCreated(result);
      setName("");
      toast.success("API key created");
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not create the key.");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    try {
      await Api.keys.revoke(id);
      toast.success("Key revoked");
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not revoke the key.");
    }
  }

  function copyKey() {
    if (!created) return;
    navigator.clipboard.writeText(created.key);
    setCopied(true);
    toast.success("API key copied");
    setTimeout(() => setCopied(false), 1500);
  }

  const active = keys?.filter((k) => k.isActive) ?? [];

  return (
    <>
      <SiteHeader title="API Keys" />
      <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
        {/* Newly created key — shown ONCE */}
        {created && (
          <Card className="border-primary/40 bg-primary/5">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <KeyRound className="size-4" /> Copy your new API key now
              </CardTitle>
              <CardDescription>
                This is the only time the full key is shown. Store it somewhere safe — it
                can&apos;t be recovered later.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-md bg-background px-3 py-2 font-mono text-sm">
                {created.key}
              </code>
              <Button variant="outline" size="icon" aria-label="Copy key" onClick={copyKey}>
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </CardContent>
            <CardFooter>
              <Button variant="ghost" size="sm" onClick={() => setCreated(null)}>
                Dismiss
              </Button>
            </CardFooter>
          </Card>
        )}

        {/* Create a key */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Create a key</CardTitle>
            <CardDescription>
              Name it and pick the scopes it should grant. Use it in the SDK / MCP via
              <code className="mx-1 text-xs">X-SpanoAI-Key</code>.
            </CardDescription>
          </CardHeader>
          <form onSubmit={create}>
            <CardContent className="flex flex-col gap-4">
              <div className="grid gap-2 sm:max-w-sm">
                <Label htmlFor="name">Key name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. production-mcp"
                />
              </div>
              <div className="grid gap-2">
                <Label>Scopes</Label>
                <div className="flex flex-wrap gap-2">
                  {ALL_SCOPES.map((scope) => {
                    const on = scopes.includes(scope);
                    return (
                      <button
                        key={scope}
                        type="button"
                        onClick={() => toggleScope(scope)}
                        className={`rounded-md border px-2.5 py-1 font-mono text-xs transition-colors ${
                          on
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border text-muted-foreground hover:bg-accent"
                        }`}
                        aria-pressed={on}
                      >
                        {scope}
                      </button>
                    );
                  })}
                </div>
              </div>
            </CardContent>
            <CardFooter className="mt-2">
              <Button type="submit" disabled={creating}>
                {creating ? <Loader2 className="animate-spin" /> : <Plus className="size-4" />}
                Create key
              </Button>
            </CardFooter>
          </form>
        </Card>

        {/* Existing keys */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your keys</CardTitle>
            <CardDescription>
              {active.length} active {active.length === 1 ? "key" : "keys"} for your tenant.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {keys === null ? (
              <Skeleton className="h-24" />
            ) : keys.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No keys yet. Create one above to use the SDK or MCP server.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Key id</TableHead>
                    <TableHead>Scopes</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Last used</TableHead>
                    <TableHead className="text-right">Status</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.map((k) => (
                    <TableRow key={k.id}>
                      <TableCell className="font-medium">{k.name}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {k.id}
                      </TableCell>
                      <TableCell className="max-w-[18rem]">
                        <span className="flex flex-wrap gap-1">
                          {k.scopes.map((s) => (
                            <Badge key={s} variant="secondary" className="font-mono text-[10px]">
                              {s}
                            </Badge>
                          ))}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {fmtDate(k.createdAt)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {fmtDate(k.lastUsedAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge variant={k.isActive ? "secondary" : "destructive"}>
                          {k.isActive ? "active" : "revoked"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {k.isActive && (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Revoke key"
                            onClick={() => revoke(k.id)}
                          >
                            <Trash2 className="size-4 text-destructive" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
