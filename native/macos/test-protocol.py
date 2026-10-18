#!/usr/bin/env python3
"""No GUI: malformed frames are rejected and shell-launched valid requests cannot act."""
import json
from pathlib import Path
import struct
import subprocess
import sys
import time
import unittest

BINARY = Path(sys.argv.pop(1)).resolve() if len(sys.argv) > 1 else Path(__file__).parent / 'build/tab-out-split-ratio'


def request_bytes(value):
    encoded = json.dumps(value).encode()
    return struct.pack('=I', len(encoded)) + encoded


class ProtocolTests(unittest.TestCase):
    def exchange(self, wire, origin='chrome-extension://abcdefghijklmnopabcdefghijklmnop/'):
        arguments = [str(BINARY)] + ([origin] if origin is not None else [])
        result = subprocess.run(arguments, input=wire, capture_output=True, timeout=5, check=True)
        self.assertEqual(result.stderr, b'')
        self.assertGreaterEqual(len(result.stdout), 4)
        length, = struct.unpack('=I', result.stdout[:4])
        self.assertEqual(length, len(result.stdout) - 4)
        value = json.loads(result.stdout[4:])
        self.assertEqual(value['version'], 2)
        self.assertIn(value['status'], ('adjusted', 'already-correct', 'permission-required', 'refused', 'error'))
        return value

    def test_oversized_frame(self):
        self.assertEqual(self.exchange(struct.pack('=I', 16385))['reason'], 'invalid-frame')

    def test_zero_length(self):
        self.assertEqual(self.exchange(struct.pack('=I', 0))['reason'], 'invalid-frame')

    def test_truncated_header(self):
        self.assertEqual(self.exchange(b'\x02')['reason'], 'invalid-frame')

    def test_truncated_body(self):
        self.assertEqual(self.exchange(struct.pack('=I', 10) + b'{}')['reason'], 'incomplete-frame')

    def test_invalid_json(self):
        self.assertEqual(self.exchange(struct.pack('=I', 1) + b'{')['reason'], 'invalid-json')

    def test_array_rejected(self):
        self.assertEqual(self.exchange(request_bytes([]))['reason'], 'invalid-json')

    def test_unknown_operations(self):
        for operation in ('type', 'resize', 'drag', 'inspect'):
            with self.subTest(operation=operation):
                value = self.exchange(request_bytes(dict(version=2, requestId='test', operation=operation)))
                self.assertEqual(value['reason'], 'invalid-request')

    def test_extra_keys_rejected(self):
        value = self.exchange(request_bytes(dict(version=2, requestId='test', operation='status', pid=123)))
        self.assertEqual(value['reason'], 'invalid-request')

    def test_boolean_version_rejected(self):
        value = self.exchange(request_bytes(dict(version=True, requestId='test', operation='status')))
        self.assertEqual(value['reason'], 'invalid-request')

    def test_v1_rejected(self):
        value = self.exchange(request_bytes(dict(version=1, requestId='test', operation='status')))
        self.assertEqual(value['reason'], 'invalid-request')

    def test_status_requires_browser_parent(self):
        value = self.exchange(request_bytes(dict(version=2, requestId='test', operation='status')))
        self.assertEqual(value['requestId'], 'test')
        self.assertEqual(value['reason'], 'untrusted-parent')

    def test_valid_set_requires_browser_parent(self):
        value = self.exchange(request_bytes(self.valid_set()))
        self.assertEqual(value['reason'], 'untrusted-parent')

    def valid_set(self):
        return dict(version=2, requestId='test', operation='set-split-ratio',
            expiresAt=int(time.time()*1000)+1500, overviewSide='left',
            viewportWidths=dict(left=677, right=677),
            windowBounds=dict(left=0, top=25, width=1400, height=816),
            targetRatio=0.42)

    def test_malformed_geometry(self):
        for key, bad in (('viewportWidths', None), ('viewportWidths', dict(left=True, right=677)),
                ('viewportWidths', dict(left=0, right=677)), ('viewportWidths', dict(left='677', right=677)),
                ('windowBounds', dict(left=0, top=25, width=-1, height=816)),
                ('windowBounds', dict(left=0, top=25, width=1400)),
                ('overviewSide', 'bottom'), ('expiresAt', 'tomorrow')):
            with self.subTest(key=key, bad=bad):
                request = self.valid_set()
                request[key] = bad
                self.assertEqual(self.exchange(request_bytes(request))['reason'], 'invalid-request')

    def test_target_ratio_required(self):
        request = self.valid_set()
        del request['targetRatio']
        self.assertEqual(self.exchange(request_bytes(request))['reason'], 'invalid-request')

    def test_target_ratio_bounds_and_types(self):
        for bad in (0.19, 0.61, -0.2, 1, '0.42', True, None):
            with self.subTest(bad=bad):
                request = self.valid_set()
                request['targetRatio'] = bad
                self.assertEqual(self.exchange(request_bytes(request))['reason'], 'invalid-request')

    def test_valid_ratio_bounds_reach_parent_check(self):
        for good in (0.20, 0.42, 0.60):
            with self.subTest(good=good):
                request = self.valid_set()
                request['targetRatio'] = good
                self.assertEqual(self.exchange(request_bytes(request))['reason'], 'untrusted-parent')

    def test_expired_request(self):
        request = self.valid_set()
        request['expiresAt'] = int(time.time()*1000)-1
        self.assertEqual(self.exchange(request_bytes(request))['reason'], 'expired')

    def test_viewports_exceed_window(self):
        request = self.valid_set()
        request['viewportWidths'] = dict(left=1000, right=1000)
        self.assertEqual(self.exchange(request_bytes(request))['reason'], 'viewport-mismatch')

    def test_invalid_caller_origins(self):
        for origin in (None, 'https://example.com/', 'chrome-extension://short/',
                'chrome-extension://abcdefghijklmnopabcdefghijklmnop/index.html',
                'chrome-extension://abcdefghijklmnopabcdefghijklmnop/\n'):
            with self.subTest(origin=origin):
                wire = request_bytes(dict(version=2, requestId='test', operation='status'))
                self.assertEqual(self.exchange(wire, origin)['reason'], 'invalid-origin')

    def test_only_one_response(self):
        wire = request_bytes(dict(version=2, requestId='first', operation='status'))
        self.assertEqual(self.exchange(wire + wire)['requestId'], 'first')


unittest.main()
