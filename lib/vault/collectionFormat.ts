// A collection is one Markdown file; each record reuses the existing document format.
// YAML fences are visible in Obsidian, and record headings sit one level below the book.
export type CollectionKind = 'vocab' | 'sentence';
export const COLLECTION_FILES = { vocab: '生词本.md', sentence: '句子.md' } as const;

export interface CollectionDocument {
  prefix: string;
  documents: string[];
}

export function parseCollection(text: string, kind: CollectionKind): CollectionDocument {
  const parts = text.replace(/\r\n?/g, '\n').split(new RegExp(`^<!-- peak-distance:${kind} -->[ \\t]*$`, 'm'));
  const prefix = parts.shift()!;
  if (!prefix.startsWith(`<!-- peak-distance:collection ${kind} -->`)) throw new Error(`format: ${COLLECTION_FILES[kind]}`);
  const checkOrphanRecords = (body: string) => {
    for (const match of body.matchAll(/^```yaml\n([\s\S]*?)\n```/gm)) {
      if (/^id:/m.test(match[1]!) && /^language:/m.test(match[1]!)) throw new Error(`format: missing record separator in ${COLLECTION_FILES[kind]}`);
    }
  };
  checkOrphanRecords(prefix);
  const documents = parts.map(part => {
    const match = part.match(/^\s*```yaml\n([\s\S]*?)\n```\n([\s\S]*)$/);
    if (!match) throw new Error(`format: ${COLLECTION_FILES[kind]}`);
    checkOrphanRecords(match[2]!);
    const body = match[2]!.replace(/^(#{2,}) /gm, (_line, hashes: string) => `${hashes.slice(1)} `);
    return `---\n${match[1]}\n---\n${body}`;
  });
  return { prefix, documents };
}

export function serializeCollection(collection: CollectionDocument, kind: CollectionKind): string {
  const parts = collection.documents.map(document => {
    const match = document.replace(/\r\n?/g, '\n').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) throw new Error(`format: ${COLLECTION_FILES[kind]}`);
    const body = match[2]!.replace(/^(#+) /gm, (_line, hashes: string) => `#${hashes} `);
    return `<!-- peak-distance:${kind} -->\n\`\`\`yaml\n${match[1]}\n\`\`\`\n${body.trim()}\n`;
  });
  return [collection.prefix.trimEnd(), ...parts].join('\n\n') + '\n';
}

export function emptyCollection(kind: CollectionKind): CollectionDocument {
  return { prefix: `<!-- peak-distance:collection ${kind} -->\n# ${kind === 'vocab' ? '生词本' : '句子'}\n`, documents: [] };
}
