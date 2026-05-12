# Copyright(c) The Maintainers of Nanvix.
# Licensed under the MIT License.

"""nanvix-copilot build script — downloads runtime dependencies.

Extends the standard ZScript setup to download CPython and QuickJS
runtime archives in addition to the Nanvix sysroot.  These are full
runtime sysroots (ELF binary + stdlib), not build-time dependencies
(.a/.h), so they are handled outside the buildroot system.

Usage::

    ./z setup          # download sysroot + runtimes
    ./z distclean      # remove all downloaded artifacts
"""

from __future__ import annotations

import os
import shutil
import tarfile
from pathlib import Path

from nanvix_zutil import ZScript, github, log


class CopilotSetup(ZScript):
    """Downloads the Nanvix sysroot and interpreter runtimes."""

    def setup(self) -> bool:
        # Normalize GitHub token so zutils picks it up consistently.
        if not os.environ.get("GH_TOKEN") and os.environ.get("GITHUB_TOKEN"):
            os.environ["GH_TOKEN"] = os.environ["GITHUB_TOKEN"]

        used_fallback = super().setup()

        runtimes_dir = self.nanvix_dir / "runtimes"
        runtimes_dir.mkdir(parents=True, exist_ok=True)
        cache_dir = self.nanvix_dir / "cache"
        gh_token = os.environ.get("GH_TOKEN")

        # Download CPython runtime.
        log.info("Setting up CPython runtime...")
        self._download_runtime(
            repo="nanvix/cpython",
            asset_prefix="cpython-microvm-standalone-256mb",
            dest=runtimes_dir / "cpython",
            cache=cache_dir,
            gh_token=gh_token,
        )

        # Download QuickJS runtime.
        log.info("Setting up QuickJS runtime...")
        self._download_runtime(
            repo="nanvix/quickjs",
            asset_prefix="quickjs-microvm-standalone-256mb",
            dest=runtimes_dir / "quickjs",
            cache=cache_dir,
            gh_token=gh_token,
        )

        return used_fallback

    @staticmethod
    def _download_runtime(
        repo: str,
        asset_prefix: str,
        dest: Path,
        cache: Path,
        gh_token: str | None,
    ) -> None:
        """Download and extract a runtime archive from a GitHub release."""
        # Resolve the release to detect version changes.
        release = github.resolve_release(repo, "latest", gh_token)
        tag = release.get("tag_name", "")

        # Check if the cached version matches.
        tag_file = dest / ".tag"
        if dest.is_dir() and tag_file.is_file():
            cached_tag = tag_file.read_text().strip()
            if cached_tag == tag:
                log.info(f"Runtime already present at {dest} (tag={tag})")
                return
            log.info(f"Runtime tag mismatch (cached={cached_tag}, resolved={tag}), re-downloading...")
            shutil.rmtree(dest)
            # Purge cached tarballs matching this prefix to avoid reusing stale archives.
            for stale in cache.glob(f"{asset_prefix}*"):
                stale.unlink(missing_ok=True)

        asset_path = github.download_release_asset(
            repo=repo,
            version_specifier="latest",
            asset_name=asset_prefix,
            dest=cache,
            gh_token=gh_token,
            match_prefix=True,
            _release=release,
        )

        log.info(f"Extracting {asset_path.name}...")
        dest.mkdir(parents=True, exist_ok=True)
        with tarfile.open(asset_path, "r:*") as tf:
            tf.extractall(dest, filter="data")

        # Persist the resolved tag for cache invalidation.
        tag_file.write_text(tag)
        log.success(f"Runtime extracted to {dest}")


if __name__ == "__main__":
    CopilotSetup.main()
