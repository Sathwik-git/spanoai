import { source } from "@/lib/source";
import { createFromSource } from "fumadocs-core/search/server";

// Powers the built-in ⌘K search dialog; index is built from the same source.
export const { GET } = createFromSource(source, {
  language: "english",
});
