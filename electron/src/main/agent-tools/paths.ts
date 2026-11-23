import fs from 'node:fs';
import path from 'node:path';

const BLOCKED = /^(?:\.git|\.catnip|\.env(?:\..*)?|node_modules|build|dist(?:-.*)?|managed_components|apikey\.txt|qwen-apikey\.txt|wifi_secrets\.h|.*\.(?:pem|key|p12|pfx))$/i;
const PRIVATE = /(?:secret|credential|token|password)s?[_-]?(?:store|config|key)?\.(?:json|txt|ya?ml)$/i;

/** Resolve every existing ancestor; a link/junction is never followed, even within the root. */
export function toolPath(root: string, requested: string, allowRoot = false): string {
  const realRoot = fs.realpathSync.native(root);
  const resolved = path.resolve(realRoot, requested);
  const relative = path.relative(realRoot, resolved);
  if (relative === '' && allowRoot) return realRoot;
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('TOOL_PATH_OUTSIDE_PROJECT');
  }
  const segments = relative.split(path.sep);
  let cursor = realRoot;
  for (const segment of segments) {
    if (BLOCKED.test(segment) || PRIVATE.test(segment) || segment.includes(':') || /[. ]$/.test(segment)) {
      throw new Error('TOOL_PATH_PRIVATE_OR_GENERATED');
    }
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor)) {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error('TOOL_PATH_LINK_REFUSED');
      const real = fs.realpathSync.native(cursor);
      const inside = path.relative(realRoot, real);
      if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('TOOL_PATH_OUTSIDE_PROJECT');
    }
  }
  return resolved;
}

export function isVisibleName(name: string): boolean { return !BLOCKED.test(name) && !PRIVATE.test(name); }
export function readToolText(file: string, maxBytes = 128 * 1024): string {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('TOOL_FILE_TOO_LARGE_OR_NOT_TEXT');
  const bytes = fs.readFileSync(file);
  if (bytes.includes(0)) throw new Error('TOOL_BINARY_FILE_REFUSED');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
