#!/usr/bin/env bash
# The bundled platform-tools (v1.41) rustc predates edition2024 (stabilized
# ~rustc 1.85). Run this after any `cargo generate-lockfile` /
# `rm Cargo.lock` to pin the transitive deps that have since moved past it
# back to their last MSRV-1.75-compatible release, and to downgrade the
# lockfile format cargo-build-sbf's bundled old cargo can parse.
#
# Usage: (from contracts-solana/) ./pin-msrv-compat.sh
set -euo pipefail
cd "$(dirname "$0")"

cargo update -p blake3 --precise 1.5.5
cargo update -p borsh-derive@1.5.7 --precise 1.5.1 2>/dev/null || true
cargo update -p proc-macro-crate@3.5.0 --precise 3.0.0 2>/dev/null || true
cargo update -p indexmap --precise 2.2.6 2>/dev/null || true
cargo update -p zeroize_derive --precise 1.4.2 2>/dev/null || true
cargo update -p jobserver --precise 0.1.32 2>/dev/null || true

sed -i 's/^version = 4$/version = 3/' Cargo.lock
echo "pinned. verify with: cargo build-sbf --workspace --tools-version v1.41 --skip-tools-install"
