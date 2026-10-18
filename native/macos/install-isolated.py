#!/usr/bin/env python3
"""Register the built host in an explicitly selected disposable Chrome data root."""
import argparse
import json
import os
from pathlib import Path
import re

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--user-data-dir', required=True, type=Path)
parser.add_argument('--extension-id', required=True)
parser.add_argument('--host-binary', required=True, type=Path)
args = parser.parse_args()
if not re.fullmatch(r'[a-p]{32}', args.extension_id):
    parser.error('extension ID must contain exactly 32 letters a-p')
if not args.user_data_dir.is_absolute() or not args.host_binary.is_absolute():
    parser.error('user-data-dir and host-binary must be absolute paths')
profile = args.user_data_dir.resolve(strict=True)
binary = args.host_binary.resolve(strict=True)
personal = Path.home() / 'Library' / 'Application Support'
if profile == personal or personal in profile.parents:
    parser.error('refusing registration under personal Application Support')
if not profile.is_dir() or not binary.is_file() or not os.access(binary, os.X_OK):
    parser.error('existing disposable data directory and executable host required')
host_directory = profile / 'NativeMessagingHosts'
if host_directory.is_symlink():
    parser.error('refusing symlinked NativeMessagingHosts directory')
host_directory.mkdir(mode=0o700, exist_ok=True)
resolved_directory = host_directory.resolve(strict=True)
if not resolved_directory.is_dir() or profile not in resolved_directory.parents:
    parser.error('NativeMessagingHosts must stay within the isolated profile')
target = host_directory / 'com.tab_out_remote.split_ratio.json'
manifest = {
    'name': 'com.tab_out_remote.split_ratio',
    'description': 'Tab Out Remote bounded split ratio helper',
    'path': str(binary),
    'type': 'stdio',
    'allowed_origins': [f'chrome-extension://{args.extension_id}/'],
}
if target.exists():
    parser.error(f'manifest already exists; inspect and remove it explicitly: {target}')
directory_fd = os.open(host_directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    file_fd = os.open(target.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
    with os.fdopen(file_fd, 'w', encoding='utf-8') as stream:
        os.fchmod(stream.fileno(), 0o600)
        json.dump(manifest, stream, indent=2)
        stream.write('\n')
finally:
    os.close(directory_fd)
print(target)
