"""Offline package boundary tests. No device or online provider is accessed."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
import warnings
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'runtime/hardboard/scripts/firmware_package.py'
ARCHIVE = ROOT / 'runtime/hardboard/packages/otto-st7789-reference-firmware-v1.zip'
spec = importlib.util.spec_from_file_location('firmware_package', SCRIPT)
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class FirmwarePackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.project = self.root / 'project'
        self.project.mkdir()
        self.id = 'firmware-' + 'a' * 32
        with zipfile.ZipFile(ARCHIVE) as z:
            prefix = next(i.filename[:-len(package.MANIFEST)] for i in z.infolist() if i.filename.endswith(package.MANIFEST))
            self.files = {i.filename[len(prefix):]: z.read(i) for i in z.infolist() if not i.is_dir()}

    def tearDown(self):
        self.temp.cleanup()

    def archive(self, files=None, entries=None):
        out = self.root / 'input.zip'
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
            for name, data in (files or self.files).items():
                z.writestr(name, data)
            for info, data in entries or []:
                with warnings.catch_warnings():
                    warnings.simplefilter('ignore')
                    z.writestr(info, data)
        return out

    def run_import(self, **kwargs):
        return package.import_package(self.archive(**kwargs), self.root, self.id, self.project)

    def test_real_package_and_fixed_flash_command(self):
        plan = self.run_import()
        self.assertEqual((plan['chip'], plan['flashSize']), ('esp32s3', '16MB'))
        self.assertEqual([i['offset'] for i in plan['images']], ['0x0', '0x8000', '0x10000'])
        self.assertEqual(plan['images'][2]['bytes'], 289728)
        self.assertEqual(package.inspect_package(self.root, self.id, self.project), plan)
        args = package.flash_args(plan, 'COM10', self.root / self.id)
        self.assertIn('write_flash', args)
        self.assertNotIn('erase_flash', args)
        self.assertNotIn('--force', args)
        self.assertNotIn('flash', args)
        self.assertEqual(args[-6::2], ['0x0', '0x8000', '0x10000'])
        self.assertEqual({p.relative_to(self.root / self.id).as_posix() for p in (self.root / self.id).rglob('*') if p.is_file()}, {'package.json', *[i['path'] for i in plan['images']]})

    def test_wrapped_archive(self):
        plan = self.run_import(files={'firmware-v1/' + k: v for k, v in self.files.items()})
        self.assertEqual(plan['chip'], 'esp32s3')

    def test_traversal_and_windows_reserved_paths(self):
        for name in ('../outside.bin', '/absolute.bin', 'flash/../evil.bin', 'C:/evil.bin', 'flash\\evil.bin', 'flash/NUL.bin', 'flash/file.bin.'):
            with self.subTest(name=name):
                info = zipfile.ZipInfo()
                info.filename = name  # Preserve raw backslashes on Windows.
                with self.assertRaisesRegex(ValueError, 'PATH_INVALID'):
                    self.run_import(entries=[(info, b'x')])
                self.assertFalse((self.root / self.id).exists())

    def test_duplicate_and_case_collision(self):
        for name in ('README.md', 'readme.md'):
            with self.assertRaisesRegex(ValueError, 'DUPLICATE_PATH'):
                self.run_import(entries=[(name, b'x')])

    def test_symlink_entry(self):
        info = zipfile.ZipInfo('flash/link.bin')
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaisesRegex(ValueError, 'LINK_REFUSED'):
            self.run_import(entries=[(info, b'../../private')])

    def test_missing_manifest_and_unlisted_file(self):
        with self.assertRaisesRegex(ValueError, 'MANIFEST_MISSING'):
            self.run_import(files={'README.md': b'not a firmware package'})
        with self.assertRaisesRegex(ValueError, 'CHECKSUM_COVERAGE_INVALID'):
            self.run_import(entries=[('flash/script.py', b'ignored and refused')])

    def test_corrupt_checksum(self):
        files = dict(self.files)
        files['flash/otto_rainbow_cat.bin'] = b'changed'
        with self.assertRaisesRegex(ValueError, 'CHECKSUM_MISMATCH'):
            self.run_import(files=files)

    def test_duplicate_json_key(self):
        files = dict(self.files)
        files[package.MANIFEST] = b'{"schemaVersion": 1, "schemaVersion": 1}'
        with self.assertRaisesRegex(ValueError, 'DUPLICATE_JSON_KEY'):
            self.run_import(files=files)

    def test_offsets_and_capacity(self):
        plan = self.run_import()
        for start in ('0x8001', '0x0', '0x1000000'):
            images = copy.deepcopy(plan['images'])
            images[1]['offset'] = start
            with self.assertRaisesRegex(ValueError, 'IMAGE_RANGE_INVALID'):
                package.validate_images(images, 16 * 1024 * 1024)

    def test_project_change_tampering_and_no_overwrite(self):
        plan = self.run_import()
        other = self.root / 'other-project'
        other.mkdir()
        with self.assertRaisesRegex(ValueError, 'PROJECT_MISMATCH'):
            package.inspect_package(self.root, self.id, other)
        with self.assertRaisesRegex(ValueError, 'DESTINATION_EXISTS'):
            self.run_import()
        image = self.root / self.id / plan['images'][0]['path']
        image.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'CHECKSUM_MISMATCH'):
            package.inspect_package(self.root, self.id, self.project)
        with self.assertRaisesRegex(ValueError, 'CHANGED_REIMPORT_REQUIRED'):
            package.flash_package(self.root, self.id, self.project, '0' * 64, 'COM10')

    def test_hardlink_file_and_invalid_port(self):
        plan = self.run_import()
        image = self.root / self.id / plan['images'][0]['path']
        os.link(image, self.root / 'linked-image.bin')
        with self.assertRaisesRegex(ValueError, 'LINK_REFUSED'):
            package.inspect_package(self.root, self.id, self.project)
        for port in ('', '--force', 'COM10 & cmd', 'COM0', '/tmp/device'):
            with self.assertRaisesRegex(ValueError, 'PORT_INVALID'):
                package.flash_args(plan, port, self.root)


if __name__ == '__main__':
    unittest.main(verbosity=2)
