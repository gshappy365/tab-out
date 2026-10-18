#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/tab-out-guards.XXXXXX")
trap 'rm -rf "$temporary_dir"' EXIT HUP INT TERM
xcrun clang -fobjc-arc -Wall -Wextra -Werror -O2 \
  "$source_dir/test-guards.m" -framework AppKit -framework ApplicationServices \
  -o "$temporary_dir/test-guards"
"$temporary_dir/test-guards"
