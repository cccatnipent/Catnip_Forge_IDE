"""Import source-free board reference ZIPs. No model, build or device access."""
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import zipfile

# -I excludes the script directory. Add only this bundled, fixed module directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from firmware_package import digest, load_json, no_links, read_file, safe_path

MAX_ZIP = 8 * 1024 * 1024
MAX_TOTAL = 16 * 1024 * 1024
MAX_FILE = 4 * 1024 * 1024
MAX_TEXT = 128 * 1024
MANIFEST = 'PACKAGE_MANIFEST.json'
BOARD = 'BOARD_MANIFEST.json'
ID = r'board-[a-f0-9]{32}'
PRIVATE = re.compile(r'(?:secret|credential|password|token|apikey|qwen-apikey|\.env|\.catnip|\.git)', re.I)
SECRET = re.compile(r'sk-[A-Za-z0-9_-]{20,}|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----')
ASSIGNED_SECRET = re.compile(r'''(?:api[_-]?key|auth[_-]?token|password|secret)\s*["']?\s*[:=]\s*["']([A-Za-z0-9_./+\-=]{16,})["']''', re.I)


def refuse(code):
    raise ValueError('BOARD_INFO_' + code)


def label(value, limit=160):
    if not isinstance(value, str) or not value or len(value) > limit or re.search(r'[\x00-\x1f\x7f<>]', value) or SECRET.search(value):
        refuse('METADATA_INVALID')
    return value


def reference_path(value):
    safe_path(value)
    if any(PRIVATE.search(part) for part in value.split('/')):
        refuse('PRIVATE_FILE_REFUSED')
    suffix = Path(value).suffix.lower()
    if suffix not in ('.md', '.txt', '.json', '.pdf') and value != 'upstream-reference/config.h':
        refuse('CONTENT_TYPE_REFUSED')
    if suffix == '.pdf' and not value.startswith('hardware/'):
        refuse('CONTENT_TYPE_REFUSED')
    return value


def validate_text(name, data):
    if name.lower().endswith('.pdf'):
        if not data.startswith(b'%PDF-'):
            refuse('CONTENT_TYPE_REFUSED')
        return
    if len(data) > MAX_TEXT or b'\x00' in data:
        refuse('TEXT_INVALID')
    text = data.decode('utf-8-sig')
    if SECRET.search(text) or ASSIGNED_SECRET.search(text):
        refuse('SECRET_REFUSED')
    if name.lower().endswith('.json'):
        load_json(data)  # Manifests and structured board facts use JSON objects.




def documentation_links(blobs):
    documents = {name for name in blobs if name != 'SHA256SUMS.txt' and not name.lower().endswith('.pdf')}
    links = []

    def visit(source, node, pointer='', depth=0):
        if depth > 16 or len(pointer) > 240:
            refuse('DOCUMENTATION_INVALID')
        if isinstance(node, list):
            for index, child in enumerate(node):
                visit(source, child, f'{pointer}/{index}', depth + 1)
        elif isinstance(node, dict):
            if 'documentation' in node:
                targets = node['documentation']
                if not isinstance(targets, list) or not 1 <= len(targets) <= 16 or any(not isinstance(target, str) for target in targets) or len(set(targets)) != len(targets):
                    refuse('DOCUMENTATION_INVALID')
                for target in targets:
                    reference_path(target)
                    if not target.lower().endswith(('.md', '.txt')) or target not in documents:
                        refuse('DOCUMENTATION_INVALID')
                links.append({'source': source, 'pointer': pointer or '/', 'documents': targets})
                if len(links) > 64:
                    refuse('DOCUMENTATION_INVALID')
            for key, child in node.items():
                if key != 'documentation':
                    part = key.replace('~', '~0').replace('/', '~1')
                    visit(source, child, f'{pointer}/{part}', depth + 1)

    for source, data in sorted(blobs.items()):
        if source.lower().endswith('.json'):
            visit(source, load_json(data))
    return links


def import_package(archive, root, package_id):
    if not re.fullmatch(ID, package_id):
        refuse('ID_INVALID')
    no_links(root, directory=True)
    target = Path(root) / package_id
    if target.exists():
        refuse('DESTINATION_EXISTS')
    source = no_links(archive)
    if source.suffix.lower() != '.zip':
        refuse('ZIP_INVALID')
    archive_bytes = read_file(source, MAX_ZIP)
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as z:
        entries = z.infolist()
        if not 1 <= len(entries) <= 128:
            refuse('ENTRY_LIMIT')
        files, seen, total = {}, set(), 0
        for entry in entries:
            if entry.orig_filename != entry.filename:
                refuse('PATH_INVALID')
            name = safe_path(entry.filename.rstrip('/') if entry.is_dir() else entry.filename)
            if name.lower() in seen:
                refuse('DUPLICATE_PATH')
            seen.add(name.lower())
            kind = stat.S_IFMT(entry.external_attr >> 16)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or (kind != 0 and entry.is_dir() != (kind == stat.S_IFDIR)):
                refuse('LINK_REFUSED')
            if entry.flag_bits & 1 or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                refuse('ZIP_INVALID')
            if entry.is_dir():
                continue
            total += entry.file_size
            if entry.file_size > MAX_FILE or total > MAX_TOTAL:
                refuse('EXPANSION_LIMIT')
            files[name] = entry
        roots = [name[:-len(MANIFEST)] for name in files if name == MANIFEST or name.endswith('/' + MANIFEST)]
        if len(roots) != 1 or roots[0].count('/') > 1:
            refuse('MANIFEST_MISSING')
        prefix = roots[0]
        if any(not name.startswith(prefix) for name in files):
            refuse('ROOT_INVALID')
        files = {name[len(prefix):]: entry for name, entry in files.items()}

        def read(name, limit=MAX_TEXT):
            if name not in files or files[name].file_size > limit:
                refuse('FILE_MISSING_OR_TOO_LARGE')
            with z.open(files[name]) as stream:
                data = stream.read(limit + 1)
            if len(data) > limit or len(data) != files[name].file_size:
                refuse('FILE_SIZE_INVALID')
            return data

        package = load_json(read(MANIFEST))
        board = load_json(read(BOARD))
        if package.get('schemaVersion') != 1 or package.get('packageType') != 'board-adaptation-kit' or board.get('schemaVersion') != 1 or board.get('packageType') != 'board-adaptation-kit':
            refuse('MANIFEST_UNSUPPORTED')
        board_id = label(board.get('boardId'), 64)
        if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', board_id):
            refuse('METADATA_INVALID')
        version = label(package.get('version'), 32)
        if not re.fullmatch(r'\d+\.\d+\.\d+', version) or board.get('version') != version or board.get('packageId') != package.get('packageId'):
            refuse('METADATA_INVALID')
        sums = {}
        for line in read('SHA256SUMS.txt').decode('utf-8-sig').splitlines():
            if not line or line.startswith('#'):
                continue
            match = re.fullmatch(r'([a-fA-F0-9]{64})  (.+)', line)
            if not match:
                refuse('CHECKSUM_LIST_INVALID')
            name = reference_path(match[2])
            if name.lower() in {item.lower() for item in sums}:
                refuse('DUPLICATE_PATH')
            sums[name] = match[1].lower()
        expected = set(files) - {MANIFEST, 'SHA256SUMS.txt'}
        if set(sums) != expected:
            refuse('CHECKSUM_COVERAGE_INVALID')
        rows = package.get('files')
        if not isinstance(rows, list) or len(rows) != len(expected):
            refuse('MANIFEST_FILES_INVALID')
        declared = {}
        for row in rows:
            name = reference_path(row['path'])
            if name in declared or name not in expected or type(row['bytes']) is not int or row['sha256'] != sums[name]:
                refuse('MANIFEST_FILES_INVALID')
            declared[name] = row
        blobs = {}
        for name in files:
            if name != 'SHA256SUMS.txt':
                reference_path(name)
            data = read(name, MAX_FILE if name.lower().endswith('.pdf') else MAX_TEXT)
            if name in expected and (len(data) != declared[name]['bytes'] or digest(data) != sums[name]):
                refuse('CHECKSUM_MISMATCH')
            if name != 'SHA256SUMS.txt':
                validate_text(name, data)
            blobs[name] = data
        documents = sorted(name for name in files if name != 'SHA256SUMS.txt' and not name.lower().endswith('.pdf'))
        display = board.get('display')
        display_label = None
        if display is not None:
            if not isinstance(display, dict):
                refuse('METADATA_INVALID')
            width, height = display.get('width'), display.get('height')
            if type(width) is not int or type(height) is not int or not 1 <= width <= 4096 or not 1 <= height <= 4096:
                refuse('METADATA_INVALID')
            display_label = f"{label(display.get('controller'), 64)} {width}×{height}"
        value = {
            'schemaVersion': 1, 'id': package_id, 'boardId': board_id,
            'name': label(board.get('boardName')), 'version': version,
            'archiveName': label(source.name), 'archiveSha256': digest(archive_bytes),
            'chip': label(board.get('chip'), 32), 'display': display_label,
            'documents': documents,
            'documentationLinks': documentation_links(blobs),
            'files': [{'path': name, 'bytes': len(data), 'sha256': digest(data)} for name, data in sorted(blobs.items())],
        }
        temporary = Path(root) / ('.' + package_id + '.tmp')
        if temporary.exists():
            refuse('DESTINATION_EXISTS')
        temporary.mkdir()
        try:
            for name, data in blobs.items():
                file = temporary / 'references' / name
                file.parent.mkdir(parents=True, exist_ok=True)
                with file.open('xb') as stream:
                    stream.write(data)
            with (temporary / 'binding.json').open('x', encoding='utf-8') as stream:
                json.dump(value, stream, ensure_ascii=False, indent=2)
            os.rename(temporary, target)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
        return value


def main():
    if len(sys.argv) != 5 or sys.argv[1] != 'import':
        refuse('REQUEST_INVALID')
    print(json.dumps(import_package(sys.argv[4], sys.argv[2], sys.argv[3]), ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error)
        if code.startswith('FIRMWARE_PACKAGE_'):
            code = 'BOARD_INFO_' + code[len('FIRMWARE_PACKAGE_'):]
        print(code if re.fullmatch(r'BOARD_INFO_[A-Z_]+', code) else 'BOARD_INFO_INVALID', file=sys.stderr)
        sys.exit(1)
