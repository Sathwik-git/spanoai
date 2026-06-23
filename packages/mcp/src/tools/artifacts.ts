/**
 * Artifact MCP tools: store/retrieve file bytes. MCP is text-first, so bytes
 * travel as base64 and are size-capped — larger files should use the REST
 * presigned upload/download flow directly.
 */
import { z } from "zod";
import type { ToolContext } from "../config";
import {
  type SpanoTool,
  ok,
  fail,
  guard,
  resolveSession,
  resolveAgent,
  sessionArg,
  agentArg,
} from "./shared";

export function artifactTools(): SpanoTool[] {
  return [
    {
      name: "spano_upload",
      title: "Upload an artifact",
      description:
        "Upload file bytes (base64-encoded) as a content-addressed artifact, returning its id and sha256. Other agents reference it by id. Inline base64 is size-capped (see SPANOAI_MCP_MAX_INLINE_BYTES); use the REST presigned-upload flow for large files.",
      inputSchema: {
        name: z.string().describe("File name."),
        mimeType: z.string().describe("MIME type, e.g. 'application/pdf'."),
        base64: z.string().describe("File contents, base64-encoded."),
        session: sessionArg,
        agent: agentArg,
      },
      annotations: { title: "Upload an artifact", readOnlyHint: false, openWorldHint: true },
      handler: (args, ctx: ToolContext) =>
        guard(async () => {
          const session = resolveSession(args, ctx);
          const client = ctx.clientFor(resolveAgent(args, ctx));
          let bytes: Uint8Array;
          try {
            bytes = new Uint8Array(Buffer.from(args.base64 as string, "base64"));
          } catch {
            return fail("Invalid base64 in `base64`.");
          }
          if (bytes.length > ctx.config.maxInlineBytes) {
            return fail(
              `File is ${bytes.length} bytes, over the inline cap of ${ctx.config.maxInlineBytes}. Use the REST presigned-upload flow for large files.`,
            );
          }
          const artifact = await client.artifacts.upload(session, {
            name: args.name as string,
            mimeType: args.mimeType as string,
            bytes,
          });
          return ok(`Uploaded "${artifact.name}" → ${artifact.id} (${artifact.sizeBytes} bytes, sha256 ${artifact.sha256}).`, {
            artifactId: artifact.id,
            sha256: artifact.sha256,
            sizeBytes: artifact.sizeBytes,
          });
        }),
    },
    {
      name: "spano_download",
      title: "Download an artifact",
      description:
        "Download an artifact's bytes by id, returned base64-encoded along with its name and MIME type. Size-capped for inline transport; larger files should use the REST presigned-download flow.",
      inputSchema: {
        artifactId: z.string().describe("Artifact id (from spano_upload or a message payload)."),
        session: sessionArg,
        agent: agentArg,
      },
      annotations: { title: "Download an artifact", readOnlyHint: true, openWorldHint: true },
      handler: (args, ctx: ToolContext) =>
        guard(async () => {
          const session = resolveSession(args, ctx);
          const client = ctx.clientFor(resolveAgent(args, ctx));
          const meta = await client.artifacts.getMetadata(session, args.artifactId as string);
          if (meta.sizeBytes > ctx.config.maxInlineBytes) {
            return fail(
              `Artifact is ${meta.sizeBytes} bytes, over the inline cap of ${ctx.config.maxInlineBytes}. Use the REST presigned-download flow for large files.`,
            );
          }
          const bytes = await client.artifacts.download(session, args.artifactId as string);
          const base64 = Buffer.from(bytes).toString("base64");
          return ok(`Downloaded "${meta.name}" (${meta.mimeType}, ${bytes.length} bytes).`, {
            artifactId: meta.id,
            name: meta.name,
            mimeType: meta.mimeType,
            sizeBytes: bytes.length,
            base64,
          });
        }),
    },
  ];
}
