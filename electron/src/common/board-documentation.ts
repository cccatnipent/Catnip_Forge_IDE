export interface BoardDocumentationLink {
  source: string;
  pointer: string;
  documents: string[];
}

// Package-root paths only. Documentation is reference data, never an instruction
// to fetch a URL or operate a device. Legacy packages may omit the field.
export function collectBoardDocumentationLinks(
  source: string,
  value: unknown,
  declaredDocuments: ReadonlySet<string>,
): BoardDocumentationLink[] {
  const links: BoardDocumentationLink[] = [];
  function visit(node: unknown, pointer: string, depth: number): void {
    if (depth > 16 || pointer.length > 240) throw new Error('BOARD_INFO_DOCUMENTATION_INVALID');
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${pointer}/${index}`, depth + 1));
      return;
    }
    const record = node as Record<string, unknown>;
    if ('documentation' in record) {
      const documents = record.documentation;
      if (!Array.isArray(documents) || documents.length < 1 || documents.length > 16 || new Set(documents).size !== documents.length) throw new Error('BOARD_INFO_DOCUMENTATION_INVALID');
      for (const document of documents) {
        if (typeof document !== 'string' || document.length > 240 || !/\.(?:md|txt)$/i.test(document)
          || document.split('/').some(part => !part || part === '.' || part === '..' || /[\x00-\x1f\x7f<>:"\\|?*]|[. ]$/.test(part))
          || !declaredDocuments.has(document)) throw new Error('BOARD_INFO_DOCUMENTATION_INVALID');
      }
      links.push({ source, pointer: pointer || '/', documents: documents as string[] });
      if (links.length > 64) throw new Error('BOARD_INFO_DOCUMENTATION_INVALID');
    }
    for (const [key, child] of Object.entries(record)) {
      if (key !== 'documentation') visit(child, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, depth + 1);
    }
  }
  visit(value, '', 0);
  return links;
}

// Compare associations independently of JSON key/enumeration order. Python and
// JavaScript enumerate numeric object keys differently; the files remain intact.
export function boardDocumentationSignature(value: unknown): string {
  if (!Array.isArray(value) || value.length > 64) throw new Error('BOARD_INFO_DOCUMENTATION_INVALID');
  const rows = value.map(link => {
    if (!link || typeof link !== 'object' || typeof link.source !== 'string' || typeof link.pointer !== 'string'
      || !Array.isArray(link.documents) || link.documents.some((document: unknown) => typeof document !== 'string')) throw new Error('BOARD_INFO_DOCUMENTATION_INVALID');
    return JSON.stringify([link.source, link.pointer, link.documents]);
  });
  return JSON.stringify(rows.sort());
}
