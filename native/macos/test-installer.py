#!/usr/bin/env python3
import json
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

INSTALLER = Path(__file__).with_name('install-isolated.py')
EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop'
MANIFEST = 'com.tab_out_remote.split_ratio.json'


class InstallerTests(unittest.TestCase):
    def invoke(self, profile):
        return subprocess.run([sys.executable, str(INSTALLER), '--user-data-dir', str(profile),
            '--extension-id', EXTENSION_ID, '--host-binary', str(Path(sys.executable).resolve())],
            capture_output=True, text=True, timeout=5)

    def test_explicit_profile_only_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as root:
            profile = Path(root) / 'profile'
            profile.mkdir()
            self.assertEqual(self.invoke(profile).returncode, 0)
            target = profile / 'NativeMessagingHosts' / MANIFEST
            content = target.read_bytes()
            self.assertEqual(json.loads(content)['allowed_origins'], [f'chrome-extension://{EXTENSION_ID}/'])
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            self.assertNotEqual(self.invoke(profile).returncode, 0)
            self.assertEqual(target.read_bytes(), content)

    def test_symlinked_host_directory_never_writes_outside_profile(self):
        with tempfile.TemporaryDirectory() as root:
            profile = Path(root) / 'profile'
            outside = Path(root) / 'outside'
            profile.mkdir()
            outside.mkdir()
            (profile / 'NativeMessagingHosts').symlink_to(outside, target_is_directory=True)
            result = self.invoke(profile)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('symlinked', result.stderr)
            self.assertEqual(list(outside.iterdir()), [])

    def test_dangling_and_internal_symlink_directories_are_rejected(self):
        for dangling in [False, True]:
            with self.subTest(dangling=dangling), tempfile.TemporaryDirectory() as root:
                profile = Path(root) / 'profile'
                profile.mkdir()
                destination = profile / 'alternate'
                if not dangling:
                    destination.mkdir()
                (profile / 'NativeMessagingHosts').symlink_to(destination, target_is_directory=True)
                self.assertNotEqual(self.invoke(profile).returncode, 0)
                self.assertFalse((destination / MANIFEST).exists())


unittest.main()
