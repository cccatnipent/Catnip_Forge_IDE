"""Offline acceptance for user-selected board information archives."""
import hashlib
import json
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'hardboard' / 'scripts'))
import board_info_package as package

KIT = ROOT / 'hardboard/packages/otto-st7789-board-adaptation-kit-v1.1.0.zip'


class BoardInfoTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='catnip-board-info-test-'))
        self.stage = self.root / 'stage'
        self.stage.mkdir()
        with zipfile.ZipFile(KIT) as archive:
            prefix = next(name[:-len(package.MANIFEST)] for name in archive.namelist() if name.endswith('/' + package.MANIFEST))
            self.files = {name[len(prefix):]: archive.read(name) for name in archive.namelist() if not name.endswith('/')}
        self.sequence = 0

    def tearDown(self):
        shutil.rmtree(self.root)

    def archive(self, entries=None):
        self.sequence += 1
        file = self.root / f'input-{self.sequence}.zip'
        with zipfile.ZipFile(file, 'w', zipfile.ZIP_DEFLATED) as archive:
            for name, data in (entries or self.files).items():
                info = zipfile.ZipInfo(name)
                info.filename = name  # Preserve raw Windows names; ZipInfo normally normalizes them.
                archive.writestr(info, data)
        return file

    def import_file(self, file):
        self.sequence += 1
        return package.import_package(file, self.stage, f'board-{self.sequence:032x}')

    def refuse(self, file, pattern):
        before = sorted(self.stage.iterdir())
        with self.assertRaisesRegex(ValueError, pattern):
            self.import_file(file)
        self.assertEqual(before, sorted(self.stage.iterdir()), 'failed import changed existing packages')

    def add_reference(self, name, data):
        self.files[name] = data
        digest = hashlib.sha256(data).hexdigest()
        manifest = json.loads(self.files['PACKAGE_MANIFEST.json'])
        manifest['files'].append({'path': name, 'bytes': len(data), 'sha256': digest})
        self.files['PACKAGE_MANIFEST.json'] = json.dumps(manifest).encode()
        self.files['SHA256SUMS.txt'] += f'{digest}  {name}\n'.encode()

    def update_reference(self, name, data):
        self.files[name] = data
        manifest = json.loads(self.files['PACKAGE_MANIFEST.json'])
        for row in manifest['files']:
            if row['path'] == name:
                row['bytes'], row['sha256'] = len(data), hashlib.sha256(data).hexdigest()
        self.files['PACKAGE_MANIFEST.json'] = json.dumps(manifest).encode()
        self.files['SHA256SUMS.txt'] = ''.join(f"{row['sha256']}  {row['path']}\n" for row in manifest['files']).encode()

    def test_documentation_links_and_text_notes(self):
        value = self.import_file(KIT)
        link = next(row for row in value['documentationLinks'] if row['source'] == 'hardware/pinout.json' and row['pointer'] == '/lcd')
        self.assertEqual(link['documents'], ['hardware/ST7789.md'])
        self.assertIn('hardware/ST7789.md', value['documents'])
        self.add_reference('hardware/MOTOR_MODEL.txt', '型号未知，等待用户资料。'.encode())
        pinout = json.loads(self.files['hardware/pinout.json'])
        pinout['motor'] = {'documentation': ['hardware/MOTOR_MODEL.txt']}
        self.update_reference('hardware/pinout.json', json.dumps(pinout).encode())
        imported = self.import_file(self.archive())
        self.assertTrue(any(row['pointer'] == '/motor' and row['documents'] == ['hardware/MOTOR_MODEL.txt'] for row in imported['documentationLinks']))

    def test_bad_documentation_refused_with_valid_checksums(self):
        original = dict(self.files)
        for targets in [[], 'hardware/ST7789.md', ['hardware/missing.md'], ['../outside.md'], ['C:/outside.md'], ['https://example.com/manual.md'], ['hardware/schematic/otto-robot-schematic.pdf'], ['upstream-reference/config.h'], ['hardware/ST7789.md', 'hardware/ST7789.md'], ['hardware/st7789.md']]:
            with self.subTest(documentation=targets):
                self.files = dict(original)
                pinout = json.loads(self.files['hardware/pinout.json'])
                pinout['lcd']['documentation'] = targets
                self.update_reference('hardware/pinout.json', json.dumps(pinout).encode())
                self.refuse(self.archive(), 'DOCUMENTATION_INVALID|PATH_INVALID')

    def test_legacy_without_documentation(self):
        for name in ['BOARD_MANIFEST.json', 'hardware/pinout.json']:
            value = json.loads(self.files[name])
            value.pop('documentation', None)
            for child in value.values():
                if isinstance(child, dict):
                    child.pop('documentation', None)
            self.update_reference(name, json.dumps(value).encode())
        self.assertEqual(self.import_file(self.archive())['documentationLinks'], [])

    def test_real_package_preserves_every_byte(self):
        value = self.import_file(KIT)
        self.assertEqual(value['boardId'], 'otto-robot-st7789')
        self.assertIn('hardware/HARDWARE_CONTRACT.md', value['documents'])
        self.assertNotIn('hardware/schematic/otto-robot-schematic.pdf', value['documents'])
        target = self.stage / value['id'] / 'references'
        for name, data in self.files.items():
            self.assertEqual(data, (target / name).read_bytes())
        with self.assertRaisesRegex(ValueError, 'DESTINATION_EXISTS'):
            package.import_package(KIT, self.stage, value['id'])

    def test_wrapper_and_other_package_types(self):
        wrapped = self.archive({'wrapper/' + name: data for name, data in self.files.items()})
        self.assertEqual(self.import_file(wrapped)['version'], '1.1.0')
        for name, kind in [('WORKSPACE_MANIFEST.json', 'agent-workspace'), ('REFERENCE_FIRMWARE_MANIFEST.json', 'reference-firmware')]:
            self.refuse(self.archive({name: json.dumps({'schemaVersion': 1, 'packageType': kind}).encode()}), 'MANIFEST_MISSING')
        self.refuse(self.archive({'outer/inner/' + name: data for name, data in self.files.items()}), 'MANIFEST_MISSING')

    def test_hash_and_coverage(self):
        self.files['hardware/HARDWARE_CONTRACT.md'] += b'changed'
        self.refuse(self.archive(), 'CHECKSUM_MISMATCH')
        self.files['SHA256SUMS.txt'] = b''
        self.refuse(self.archive(), 'CHECKSUM_COVERAGE_INVALID')

    def test_json_duplicates_and_manifest_mismatch(self):
        original = self.files['PACKAGE_MANIFEST.json']
        self.files['PACKAGE_MANIFEST.json'] = b'{"schemaVersion":1,"schemaVersion":1}'
        self.refuse(self.archive(), 'DUPLICATE_JSON_KEY')
        manifest = json.loads(original)
        manifest['files'][0]['bytes'] += 1
        self.files['PACKAGE_MANIFEST.json'] = json.dumps(manifest).encode()
        self.refuse(self.archive(), 'CHECKSUM_MISMATCH')

    def test_paths_and_case_collisions(self):
        for name in ['../escape.md', 'C:/escape.md', 'folder\\escape.md', 'CON.json', 'file.md:stream', 'folder./file.md']:
            with self.subTest(path=name):
                self.refuse(self.archive({**self.files, name: b'bad'}), 'PATH_INVALID')
        self.refuse(self.archive({**self.files, 'board_manifest.json': self.files['BOARD_MANIFEST.json']}), 'DUPLICATE_PATH')

    def test_links_in_archive_and_source(self):
        for kind in [stat.S_IFLNK, stat.S_IFIFO]:
            file = self.archive()
            with zipfile.ZipFile(file, 'a') as archive:
                entry = zipfile.ZipInfo('linked.md')
                entry.create_system = 3
                entry.external_attr = (kind | 0o777) << 16
                archive.writestr(entry, b'outside')
            self.refuse(file, 'LINK_REFUSED')
        file = self.archive()
        link = self.root / 'hardlinked.zip'
        try:
            link.hardlink_to(file)
            self.refuse(link, 'LINK_REFUSED')
        except OSError:
            self.skipTest('hardlink creation unavailable')

    def test_source_code_scripts_and_secrets(self):
        base = dict(self.files)
        for name, data, error in [
            ('main.c', b'void app_main(void) {}', 'CONTENT_TYPE_REFUSED'),
            ('run.py', b'print("do not run")', 'CONTENT_TYPE_REFUSED'),
            ('nested.zip', b'PK', 'CONTENT_TYPE_REFUSED'),
            ('apikey.json', b'{}', 'PRIVATE_FILE_REFUSED'),
            ('hardware/note.md', b'sk-012345678901234567890123456789', 'SECRET_REFUSED'),
            ('hardware/settings.json', b'{"api_key":"fixture-credential-1234567890"}', 'SECRET_REFUSED'),
            ('hardware/note.md', b'-----BEGIN PRIVATE KEY-----', 'SECRET_REFUSED'),
            ('hardware/note.md', b'hello\x00world', 'TEXT_INVALID'),
        ]:
            self.files = dict(base)
            self.add_reference(name, data)
            self.refuse(self.archive(), error)

    def test_bounded_bytes_and_entries(self):
        file = self.root / 'oversized.zip'
        with file.open('wb') as stream:
            stream.truncate(package.MAX_ZIP + 1)
        self.refuse(file, 'FILE_SIZE_INVALID')
        self.refuse(self.archive({f'file-{i}.md': b'' for i in range(129)}), 'ENTRY_LIMIT')
        self.refuse(self.archive({**self.files, 'hardware/huge.md': b'x' * (package.MAX_FILE + 1)}), 'EXPANSION_LIMIT')
        self.add_reference('hardware/long.md', b'x' * (package.MAX_TEXT + 1))
        self.refuse(self.archive(), 'FILE_MISSING_OR_TOO_LARGE')


if __name__ == '__main__':
    unittest.main(verbosity=2)
