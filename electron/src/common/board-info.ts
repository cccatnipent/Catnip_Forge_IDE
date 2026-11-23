import type { BoardDocumentationLink } from './board-documentation';
export interface BoardInfoSummary {
  id: string;
  boardId: string;
  name: string;
  version: string;
  archiveName: string;
  archiveSha256: string;
  chip: string;
  display: string | null;
  documents: string[];
  documentationLinks?: BoardDocumentationLink[];
}

export type BoardInfoPickResult =
  | { ok: true; canceled?: boolean; package?: BoardInfoSummary }
  | { ok: false; error: string };
