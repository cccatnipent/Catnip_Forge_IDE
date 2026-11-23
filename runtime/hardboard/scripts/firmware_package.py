"""Validate local firmware ZIPs. Never execute archive contents or open a device."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import zipfile

MAX_ZIP = 64 * 1024 * 1024
MAX_TOTAL = 128 * 1024 * 1024
MAX_FILE = 32 * 1024 * 1024
MAX_JSON = 512 * 1024
MANIFEST = 'REFERENCE_FIRMWARE_MANIFEST.json'
PLAN = 'package.json'


def refuse(code):
    raise ValueError(code)


def safe_path(value):
    if not isinstance(value, str) or not value or len(value) > 240:
        refuse('FIRMWARE_PACKAGE_PATH_INVALID')
    parts = value.split('/')
    if any(not part or part in ('.', '..') or part.endswith(('.', ' ')) or
           re.search(r'[\x00-\x1f\x7f<>:"\\|?*]', part) or
           re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', part, re.I)
           for part in parts):
        refuse('FIRMWARE_PACKAGE_PATH_INVALID')
    return value


def no_links(value, directory=False):
    p = Path(os.path.abspath(value))
    for item in [*reversed(p.parents), p]:
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            refuse('FIRMWARE_PACKAGE_LINK_REFUSED')
    info = p.stat()
    if directory:
        if not p.is_dir():
            refuse('FIRMWARE_PACKAGE_DIRECTORY_INVALID')
    elif not p.is_file() or info.st_nlink != 1:
        refuse('FIRMWARE_PACKAGE_LINK_REFUSED')
    return p



def read_file(value, limit):
    file = no_links(value)
    with file.open('rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
            refuse('FIRMWARE_PACKAGE_FILE_SIZE_INVALID')
        data = stream.read(limit + 1)
    if len(data) > limit or len(data) != info.st_size:
        refuse('FIRMWARE_PACKAGE_FILE_SIZE_INVALID')
    return data

def load_json(data):
    if len(data) > MAX_JSON:
        refuse('FIRMWARE_PACKAGE_METADATA_TOO_LARGE')
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                refuse('FIRMWARE_PACKAGE_DUPLICATE_JSON_KEY')
            result[key] = value
        return result
    value = json.loads(data.decode('utf-8-sig'), object_pairs_hook=pairs)
    if not isinstance(value, dict):
        refuse('FIRMWARE_PACKAGE_METADATA_INVALID')
    return value


def digest(data):
    return hashlib.sha256(data).hexdigest()


def text(value, limit=100):
    if not isinstance(value, str) or not value or len(value) > limit or re.search(r'[\x00-\x1f\x7f<>]', value):
        refuse('FIRMWARE_PACKAGE_METADATA_INVALID')
    return value


def offset(value):
    if not isinstance(value, str) or not re.fullmatch(r'0x[0-9a-fA-F]{1,8}', value):
        refuse('FIRMWARE_PACKAGE_OFFSET_INVALID')
    return int(value, 16)


def validate_settings(chip, mode, freq, size):
    if chip not in ('esp32', 'esp32s2', 'esp32s3', 'esp32c3', 'esp32c6', 'esp32h2'):
        refuse('FIRMWARE_PACKAGE_CHIP_UNSUPPORTED')
    if mode not in ('dio', 'qio', 'dout', 'qout') or freq not in ('20m', '26m', '40m', '80m') or size not in ('1MB', '2MB', '4MB', '8MB', '16MB', '32MB'):
        refuse('FIRMWARE_PACKAGE_FLASH_SETTINGS_INVALID')
    return int(size[:-2]) * 1024 * 1024


def validate_images(images, capacity):
    if not isinstance(images, list) or not 1 <= len(images) <= 16:
        refuse('FIRMWARE_PACKAGE_IMAGES_INVALID')
    seen = set()
    end = 0
    for image in sorted(images, key=lambda i: offset(i['offset'])):
        name = safe_path(image['path'])
        start = offset(image['offset'])
        size = image['bytes']
        if not name.startswith('flash/') or not name.endswith('.bin') or name.lower() in seen:
            refuse('FIRMWARE_PACKAGE_IMAGES_INVALID')
        if type(size) is not int or not 0 < size <= MAX_FILE or not re.fullmatch(r'[0-9a-f]{64}', image['sha256']):
            refuse('FIRMWARE_PACKAGE_IMAGES_INVALID')
        # write_flash erases entire sectors: byte-disjoint images in the same
        # sector can still destroy each other, so check rounded erase ranges.
        if start % 4096 or start < end or start + size > capacity:
            refuse('FIRMWARE_PACKAGE_IMAGE_RANGE_INVALID')
        end = (start + size + 4095) // 4096 * 4096
        if end > capacity:
            refuse('FIRMWARE_PACKAGE_IMAGE_RANGE_INVALID')
        seen.add(name.lower())


def project_key(project):
    return os.path.normcase(os.path.realpath(project))


def destination(root, package_id):
    if not re.fullmatch(r'firmware-[a-f0-9]{32}', package_id):
        refuse('FIRMWARE_PACKAGE_ID_INVALID')
    no_links(root, directory=True)
    return Path(root) / package_id


def import_package(archive, root, package_id, project):
    source = no_links(archive)
    if source.suffix.lower() != '.zip' or source.stat().st_size > MAX_ZIP:
        refuse('FIRMWARE_PACKAGE_ZIP_TOO_LARGE_OR_INVALID')
    folder = destination(root, package_id)
    if folder.exists():
        refuse('FIRMWARE_PACKAGE_DESTINATION_EXISTS')
    # Snapshot the bounded archive before inspection to avoid source replacement.
    with source.open('rb') as stream:
        archive_bytes = stream.read(MAX_ZIP + 1)
    if len(archive_bytes) > MAX_ZIP:
        refuse('FIRMWARE_PACKAGE_ZIP_TOO_LARGE_OR_INVALID')
    import io
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as z:
        entries = z.infolist()
        if not 1 <= len(entries) <= 256:
            refuse('FIRMWARE_PACKAGE_ENTRY_LIMIT')
        files = {}
        seen = set()
        total = 0
        for entry in entries:
            if entry.orig_filename != entry.filename:
                refuse('FIRMWARE_PACKAGE_PATH_INVALID')
            name = safe_path(entry.filename.rstrip('/') if entry.is_dir() else entry.filename)
            key = name.lower()
            if key in seen:
                refuse('FIRMWARE_PACKAGE_DUPLICATE_PATH')
            seen.add(key)
            kind = stat.S_IFMT(entry.external_attr >> 16)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or bool(entry.is_dir()) != (kind == stat.S_IFDIR) and kind != 0:
                refuse('FIRMWARE_PACKAGE_LINK_REFUSED')
            if entry.flag_bits & 1 or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                refuse('FIRMWARE_PACKAGE_ZIP_FORMAT_UNSUPPORTED')
            if entry.is_dir():
                continue
            total += entry.file_size
            if entry.file_size > MAX_FILE or total > MAX_TOTAL:
                refuse('FIRMWARE_PACKAGE_EXPANSION_LIMIT')
            files[name] = entry
        roots = [name[:-len(MANIFEST)] for name in files if name == MANIFEST or name.endswith('/' + MANIFEST)]
        if len(roots) != 1 or roots[0].count('/') > 1:
            refuse('FIRMWARE_PACKAGE_MANIFEST_MISSING')
        prefix = roots[0]
        if any(not name.startswith(prefix) for name in files):
            refuse('FIRMWARE_PACKAGE_ROOT_INVALID')
        files = {name[len(prefix):]: entry for name, entry in files.items()}
        def read(name, limit=MAX_FILE):
            if name not in files or files[name].file_size > limit:
                refuse('FIRMWARE_PACKAGE_FILE_MISSING_OR_TOO_LARGE')
            # ZipExtFile checks CRC when reaching EOF. Limit output even for
            # maliciously inconsistent ZIP size declarations.
            with z.open(files[name]) as stream:
                data = stream.read(limit + 1)
            if len(data) > limit or len(data) != files[name].file_size:
                refuse('FIRMWARE_PACKAGE_FILE_SIZE_INVALID')
            return data
        manifest = load_json(read(MANIFEST, MAX_JSON))
        if manifest.get('schemaVersion') != 1 or manifest.get('artifactType') != 'reference-firmware':
            refuse('FIRMWARE_PACKAGE_MANIFEST_UNSUPPORTED')
        sums = {}
        for line in read('SHA256SUMS.txt', MAX_JSON).decode('utf-8-sig').splitlines():
            if not line or line.startswith('#'):
                continue
            match = re.fullmatch(r'([0-9a-fA-F]{64})  (.+)', line)
            if not match:
                refuse('FIRMWARE_PACKAGE_CHECKSUM_LIST_INVALID')
            name = safe_path(match[2])
            if name in sums:
                refuse('FIRMWARE_PACKAGE_DUPLICATE_PATH')
            sums[name] = match[1].lower()
        expected = set(files) - {MANIFEST, 'SHA256SUMS.txt'}
        if set(sums) != expected:
            refuse('FIRMWARE_PACKAGE_CHECKSUM_COVERAGE_INVALID')
        rows = manifest.get('files')
        if not isinstance(rows, list) or len(rows) != len(expected):
            refuse('FIRMWARE_PACKAGE_MANIFEST_FILES_INVALID')
        metadata = {}
        for row in rows:
            name = safe_path(row['path'])
            if name in metadata or name not in expected or type(row['bytes']) is not int or row['sha256'] != sums[name]:
                refuse('FIRMWARE_PACKAGE_MANIFEST_FILES_INVALID')
            metadata[name] = row
        blobs = {}
        for name in expected:
            data = read(name)
            if len(data) != metadata[name]['bytes'] or digest(data) != sums[name]:
                refuse('FIRMWARE_PACKAGE_CHECKSUM_MISMATCH')
            if name.endswith('.bin') or name == 'flash/flasher_args.json':
                blobs[name] = data
        target = manifest['target']
        flash = manifest['flash']
        chip, mode, freq, size = target['chip'], flash['mode'], flash['frequency'], flash['size']
        capacity = validate_settings(chip, mode, freq, size)
        if target['flashSize'] != size:
            refuse('FIRMWARE_PACKAGE_FLASH_SETTINGS_MISMATCH')
        config = load_json(blobs.get('flash/flasher_args.json', b''))
        settings = {'flash_mode': mode, 'flash_size': size, 'flash_freq': freq}
        if config.get('flash_settings') != settings or config.get('write_flash_args') != ['--flash_mode', mode, '--flash_size', size, '--flash_freq', freq]:
            refuse('FIRMWARE_PACKAGE_FLASH_SETTINGS_MISMATCH')
        extra = config.get('extra_esptool_args')
        if extra != {'after': 'hard_reset', 'before': 'default_reset', 'stub': True, 'chip': chip}:
            refuse('FIRMWARE_PACKAGE_ESPTOOL_OPTIONS_REFUSED')
        images = []
        for row in flash['files']:
            name = safe_path(row['path'])
            if name not in blobs:
                refuse('FIRMWARE_PACKAGE_IMAGE_MISSING')
            images.append({'path': name, 'offset': hex(offset(row['offset'])), 'bytes': len(blobs[name]), 'sha256': digest(blobs[name])})
        validate_images(images, capacity)
        configured = {offset(k): 'flash/' + safe_path(v) for k, v in config['flash_files'].items()}
        if len(configured) != len(config['flash_files']) or configured != {offset(i['offset']): i['path'] for i in images}:
            refuse('FIRMWARE_PACKAGE_FLASH_FILES_MISMATCH')
        plan = {'schemaVersion': 1, 'id': package_id, 'projectDir': project_key(project),
                'name': text(manifest['artifactId']), 'version': text(manifest['version'], 40),
                'archiveName': text(source.name, 180), 'archiveSha256': digest(archive_bytes),
                'chip': chip, 'flashMode': mode, 'flashFrequency': freq, 'flashSize': size,
                'images': sorted(images, key=lambda i: offset(i['offset']))}
        folder.mkdir()
        try:
            for image in plan['images']:
                out = folder / image['path']
                out.parent.mkdir(parents=True, exist_ok=True)
                with out.open('xb') as stream:
                    stream.write(blobs[image['path']])
            with (folder / PLAN).open('x', encoding='utf-8') as stream:
                json.dump(plan, stream, indent=2)
                stream.write('\n')
        except BaseException:
            shutil.rmtree(folder)
            raise
    return plan


def inspect_package(root, package_id, project, expected_hash=None):
    folder = destination(root, package_id)
    no_links(folder, directory=True)
    file = no_links(folder / PLAN)
    if file.stat().st_size > MAX_JSON:
        refuse('FIRMWARE_PACKAGE_METADATA_TOO_LARGE')
    plan_bytes = read_file(file, MAX_JSON)
    if expected_hash is not None and (not re.fullmatch(r'[0-9a-f]{64}', expected_hash) or digest(plan_bytes) != expected_hash):
        refuse('FIRMWARE_PACKAGE_CHANGED_REIMPORT_REQUIRED')
    plan = load_json(plan_bytes)
    if plan.get('schemaVersion') != 1 or plan.get('id') != package_id or plan.get('projectDir') != project_key(project):
        refuse('FIRMWARE_PACKAGE_PROJECT_MISMATCH')
    text(plan['name'])
    text(plan['version'], 40)
    text(plan['archiveName'], 180)
    if not re.fullmatch(r'[0-9a-f]{64}', plan['archiveSha256']):
        refuse('FIRMWARE_PACKAGE_METADATA_INVALID')
    capacity = validate_settings(plan['chip'], plan['flashMode'], plan['flashFrequency'], plan['flashSize'])
    validate_images(plan['images'], capacity)
    for image in plan['images']:
        file = no_links(folder / image['path'])
        if file.stat().st_size != image['bytes'] or digest(read_file(file, image['bytes'])) != image['sha256']:
            refuse('FIRMWARE_PACKAGE_CHECKSUM_MISMATCH')
    return plan


def plan_sha256(root, package_id):
    file = no_links(destination(root, package_id) / PLAN)
    if file.stat().st_size > MAX_JSON:
        refuse('FIRMWARE_PACKAGE_METADATA_TOO_LARGE')
    return digest(read_file(file, MAX_JSON))


def flash_args(plan, port, image_root):
    if not re.fullmatch(r'COM[1-9][0-9]{0,3}|/dev/(?:ttyUSB|ttyACM|cu\.)[A-Za-z0-9._-]+', port):
        refuse('FIRMWARE_PACKAGE_PORT_INVALID')
    args = ['--chip', plan['chip'], '--port', port, '--before', 'default_reset',
            '--after', 'hard_reset', 'write_flash', '--flash_mode', plan['flashMode'],
            '--flash_freq', plan['flashFrequency'], '--flash_size', plan['flashSize']]
    for image in plan['images']:
        args.extend([image['offset'], str(Path(image_root) / image['path'])])
    return args


def flash_package(root, package_id, project, expected_hash, port):
    # The reviewed plan digest comes from Main, not package-provided commands.
    plan = inspect_package(root, package_id, project, expected_hash)
    import tempfile
    with tempfile.TemporaryDirectory(prefix='.flash-', dir=root) as snapshot:
        for image in plan['images']:
            source = no_links(destination(root, package_id) / image['path'])
            with source.open('rb') as stream:
                data = stream.read(image['bytes'] + 1)
            if len(data) != image['bytes'] or digest(data) != image['sha256']:
                refuse('FIRMWARE_PACKAGE_CHECKSUM_MISMATCH')
            out = Path(snapshot) / image['path']
            out.parent.mkdir(parents=True, exist_ok=True)
            with out.open('xb') as stream:
                stream.write(data)
        args = flash_args(plan, port, snapshot)
        print('FIRMWARE_PACKAGE_VERIFIED ' + plan['name'] + ' chip=' + plan['chip'] +
              ' flash=' + plan['flashSize'] + ' images=' + str(len(plan['images'])), flush=True)
        import esptool
        esptool.main(args)


def main():
    mode, root, package_id, project = sys.argv[1:5]
    no_links(project, directory=True)
    if mode == 'import' and len(sys.argv) == 6:
        print(json.dumps(import_package(sys.argv[5], root, package_id, project)))
    elif mode == 'inspect' and len(sys.argv) in (5, 6):
        print(json.dumps(inspect_package(root, package_id, project, sys.argv[5] if len(sys.argv) == 6 else None)))
    elif mode == 'flash' and len(sys.argv) == 7:
        flash_package(root, package_id, project, sys.argv[5], sys.argv[6])
    else:
        refuse('FIRMWARE_PACKAGE_REQUEST_INVALID')

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        code = str(exc) if isinstance(exc, ValueError) and str(exc).startswith('FIRMWARE_PACKAGE_') else 'FIRMWARE_PACKAGE_INVALID'
        print(code, file=sys.stderr)
        sys.exit(1)
