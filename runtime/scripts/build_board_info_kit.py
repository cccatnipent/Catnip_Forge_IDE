"""Build and validate a source-free board kit, preserving every reference byte."""
import json
from pathlib import Path
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'hardboard' / 'scripts'))
from board_info_package import documentation_links, import_package, reference_path, validate_text
from firmware_package import digest, load_json, no_links


def build(source, destination):
    source = no_links(source, directory=True)
    destination = Path(destination).resolve()
    if destination.exists():
        raise ValueError('OUTPUT_ALREADY_EXISTS')
    blobs = {}
    for file in sorted(source.rglob('*')):
        if file.is_dir():
            no_links(file, directory=True)
            continue
        no_links(file)
        name = file.relative_to(source).as_posix()
        if name in ('PACKAGE_MANIFEST.json', 'SHA256SUMS.txt'):
            continue
        reference_path(name)
        data = file.read_bytes()
        validate_text(name, data)
        blobs[name] = data
    links = documentation_links(blobs)
    board = load_json(blobs['BOARD_MANIFEST.json'])
    manifest = load_json((source / 'PACKAGE_MANIFEST.json').read_bytes())
    manifest['version'] = board['version']
    manifest['files'] = [{'path': name, 'bytes': len(data), 'sha256': digest(data)} for name, data in sorted(blobs.items())]
    manifest['documentationPolicy'] = 'documentation arrays use package-root UTF-8 Markdown/text paths; validate declared files, preserve references, never fetch URLs'
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    sums = ''.join(f'{digest(data)}  {name}\n' for name, data in sorted(blobs.items())).encode('utf-8')
    (source / 'PACKAGE_MANIFEST.json').write_bytes(manifest_bytes)
    (source / 'SHA256SUMS.txt').write_bytes(sums)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='catnip-kit-build-') as temporary:
        output = Path(temporary) / destination.name
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, data in sorted({**blobs, 'PACKAGE_MANIFEST.json': manifest_bytes, 'SHA256SUMS.txt': sums}.items()):
                info = zipfile.ZipInfo(source.name + '/' + name, (2026, 10, 12, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, data)
        stage = Path(temporary) / 'stage'
        stage.mkdir()
        imported = import_package(output, stage, 'board-' + '1' * 32)
        with zipfile.ZipFile(output) as archive:
            assert archive.testzip() is None
        # Exclusive output creation; never overwrite a prior archive.
        with destination.open('xb') as stream:
            stream.write(output.read_bytes())
    return {'archive': str(destination), 'version': imported['version'], 'files': len(imported['files']), 'documents': len(imported['documents']), 'documentationLinks': links, 'sha256': digest(destination.read_bytes())}


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: build_board_info_kit.py <kit-directory> <new-zip-path>')
    print(json.dumps(build(sys.argv[1], sys.argv[2]), ensure_ascii=False, indent=2))
