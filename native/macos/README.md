# macOS split-ratio native host

This one-shot Native Messaging host supports `status` and `set-split-ratio` only.
The latter restores a bounded target ratio (overview 20-60% of the visible width) by dragging Chrome's existing native divider.
It never opens, moves, closes, or reloads tabs and does not read page text or URLs.
See [the frozen wire contract](../../docs/features/native-split-ratio-design.md).

## Build and protocol checks

macOS and Xcode Command Line Tools are required. No package dependencies are used.

```sh
sh native/macos/build.sh
python3 native/macos/test-protocol.py
sh native/macos/test-guards.sh
```

The build is ad-hoc signed with identifier `com.tab_out_remote.split_ratio`.
The generated binary is excluded from Git. Rebuilding can affect macOS's
Accessibility trust; recheck `status` instead of assuming permission survived.
The host checks existing Accessibility permission without opening a permission
prompt. It reports `permission-required` when unavailable. Grant permission
explicitly in macOS System Settings as part of isolated setup.

## Register only an isolated browser

Create a separate Chrome `--user-data-dir`, load the development extension there,
then use that extension's actual ID. Every path below must be absolute.

```sh
python3 native/macos/install-isolated.py \
  --user-data-dir /absolute/path/to/disposable-profile \
  --extension-id abcdefghijklmnopabcdefghijklmnop \
  --host-binary /absolute/path/to/native/macos/build/tab-out-split-ratio
```

Registration writes only `NativeMessagingHosts/com.tab_out_remote.split_ratio.json`
under the explicitly supplied data root. The script refuses personal Application
Support paths, missing directories, invalid IDs, and existing manifests. Chrome
must be launched with the same `--user-data-dir`; no default browser registration
is installed. Remove that one manifest to unregister this isolated host.

## Safety and result semantics

Only a direct Chrome or Chrome for Testing browser parent with matching bundle
identity and executable path is accepted. Shell invocation cannot manipulate the
desktop. The request has a 16 KiB frame limit; the host reads and replies to one
frame, and stdout contains only protocol data.

Before moving the pointer, the host requires one foreground AX window matching
the extension's bounds and one native split slider. It does not traverse webpage
accessibility trees. A physically held left mouse button prevents a drag. There
is no caller-specified PID, coordinate, keystroke, resize, or arbitrary-ratio API.

The commit wait is further capped to two seconds, inside a total execution deadline of six seconds. Before
mouse-down and every drag step, the host rechecks deadline, foreground browser,
focused window, unchanged bounds, the same unique native slider, and the same
two selected native tab references in the unique native tab group. Ordinary
single-tab layouts or unavailable native tab identities are refused. Webpage
tabs, titles, and URLs are never inspected. A finally block releases the mouse after
interruption. The drag guard checks deadline, foreground app and window geometry on every step;
the full AX identity walk runs before mouse-down and again after commit, keeping the drag responsive. The host never brings another application or window forward.

`adjusted` means the drag completed, not that measured ratio passed. The extension
must verify real tab widths and restore browser-side input focus when its split
identity is still current. Native failures must not rebuild or roll back tabs.

The protocol tests exercise framing, rejected operations, strict request shape,
and untrusted-parent rejection without GUI events. They do not replace real
Chrome Native Messaging, Accessibility, divider, and focus acceptance tests.
The native identity guard test executes the production comparison against opaque
reference fixtures, including a different selected pair in the same tab group,
and performs no Accessibility queries or mouse events.
