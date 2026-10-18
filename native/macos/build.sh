#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
output_dir=${1:-"$source_dir/build"}
mkdir -p "$output_dir"
xcrun clang -fobjc-arc -Wall -Wextra -Werror -O2 \
  "$source_dir/SplitRatioHost.m" -framework AppKit -framework ApplicationServices \
  -o "$output_dir/tab-out-split-ratio"
codesign --force --sign - --identifier com.tab_out_remote.split_ratio "$output_dir/tab-out-split-ratio"
printf '%s\n' "$output_dir/tab-out-split-ratio"
