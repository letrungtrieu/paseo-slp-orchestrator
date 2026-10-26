// YAML parsing is isolated from filesystem discovery so malformed documents produce precise project-file errors.
import { parseDocument } from "yaml";
import { z } from "zod";
import { PeerKindSchema, type ProjectRole } from "../../shared/project-prompts";

const FrontMatterSchema = z.object({
  role: z.string().trim().min(1),
  description: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  // Empty YAML fields parse as null; omitted and blank-string settings also inherit the run configuration.
  model: z.string().trim().nullish(),
  thinking: z.string().trim().nullish(),
  // Optional so existing peer files keep loading; a typo is rejected instead of silently becoming a writer.
  kind: PeerKindSchema.nullish(),
}).passthrough();

export function normalizeRoleId(roleName: string): string {
  // Names are case-insensitive, while a stable slug makes tool arguments independent of filenames.
  return roleName.trim().toLowerCase().replace(/[ _]+/g, "-");
}

export function parseRoleMarkdown(markdown: string, sourcePath: string): ProjectRole {
  const documentText = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const frontMatterMatch = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(documentText);
  if (!frontMatterMatch) throw new Error(`${sourcePath}: expected YAML front matter delimited by ---`);
  try {
    // The YAML library catches duplicate keys and supports descriptions written as block scalars.
    const yamlDocument = parseDocument(frontMatterMatch[1], { uniqueKeys: true });
    if (yamlDocument.errors.length) throw yamlDocument.errors[0];
    const metadata = FrontMatterSchema.parse(yamlDocument.toJS({ maxAliasCount: 50 }));
    const workflow = documentText.slice(frontMatterMatch[0].length).trim();
    if (!workflow) throw new Error("workflow after front matter must not be empty");
    const role = normalizeRoleId(metadata.role);
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(role)) throw new Error(`invalid role '${metadata.role}'; use a name such as QA or database-review`);
    return { role, name: metadata.name ?? metadata.role, description: metadata.description,
      model: metadata.model || null, thinking: metadata.thinking || null, kind: metadata.kind ?? null,
      frontMatter: frontMatterMatch[1].trim(), workflow, sourcePath };
  } catch (metadataError) {
    // Include the file path so a user can fix configuration without tracing a plugin stack.
    throw new Error(`${sourcePath}: ${metadataError instanceof Error ? metadataError.message : String(metadataError)}`);
  }
}
