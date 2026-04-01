import { createWriteStream } from "node:fs";
import { mkdir, access, stat, writeFile, rm, cp, rename, readdir, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import { PYTHON_EVAL_WRAPPER, JS_EVAL_WRAPPER } from "./sandbox.js";
import { IS_WINDOWS, hostBinaryName } from "./platform.js";

interface ReleaseAsset {
    name: string;
    browser_download_url: string;
}

interface GitHubRelease {
    tag_name: string;
    assets: ReleaseAsset[];
}

interface SetupOptions {
    nanvixHome: string;
    verbose?: boolean;
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}

/** Recursively compute the size of a directory in bytes. */
async function directorySize(dirPath: string): Promise<number> {
    let total = 0;
    const entries = await readdir(dirPath, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
        if (entry.isFile()) {
            const fullPath = path.join(entry.parentPath ?? entry.path, entry.name);
            const info = await stat(fullPath);
            total += info.size;
        }
    }
    return total;
}

/** Find the first directory matching `name` under `rootDir` (max 2 levels deep). */
async function findDirectory(rootDir: string, name: string): Promise<string | undefined> {
    const entries = await readdir(rootDir, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
        if (entry.isDirectory() && entry.name === name) {
            return path.join(entry.parentPath ?? entry.path, entry.name);
        }
    }
    return undefined;
}

/** Find the first file matching a test predicate under `rootDir`. */
async function findFile(
    rootDir: string,
    predicate: (name: string) => boolean,
): Promise<string | undefined> {
    const entries = await readdir(rootDir, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
        if (entry.isFile() && predicate(entry.name)) {
            return path.join(entry.parentPath ?? entry.path, entry.name);
        }
    }
    return undefined;
}

/** Remove all directories matching `name` anywhere under `rootDir`. */
async function removeDirectoriesByName(rootDir: string, name: string): Promise<void> {
    const entries = await readdir(rootDir, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
        if (entry.isDirectory() && entry.name === name) {
            const fullPath = path.join(entry.parentPath ?? entry.path, entry.name);
            await rm(fullPath, { recursive: true, force: true });
        }
    }
}

async function fetchLatestRelease(repo: string): Promise<GitHubRelease> {
    const url = `https://api.github.com/repos/${repo}/releases/latest`;
    const response = await fetch(url, {
        headers: {
            Accept: "application/vnd.github.v3+json",
            ...(process.env.GITHUB_TOKEN
                ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
                : {}),
        },
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch release from ${repo}: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as GitHubRelease;
}

function findAsset(release: GitHubRelease, pattern: RegExp): ReleaseAsset {
    const asset = release.assets.find((a) => pattern.test(a.name));
    if (!asset) {
        const names = release.assets.map((a) => a.name).join(", ");
        throw new Error(
            `No asset matching ${pattern} found in release ${release.tag_name}. Available: ${names}`
        );
    }
    return asset;
}

async function downloadAndExtract(
    asset: ReleaseAsset,
    destDir: string,
    verbose: boolean
): Promise<void> {
    const archivePath = path.join(destDir, asset.name);

    if (verbose) {
        console.error(`[setup] Downloading ${asset.name}...`);
    }

    // Download.
    const response = await fetch(asset.browser_download_url, {
        headers: process.env.GITHUB_TOKEN
            ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
            : {},
    });

    if (!response.ok || !response.body) {
        throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }

    const fileStream = createWriteStream(archivePath);
    await pipeline(Readable.fromWeb(response.body as any), fileStream);

    if (verbose) {
        const info = await stat(archivePath);
        console.error(`[setup] Downloaded ${(info.size / 1024 / 1024).toFixed(1)} MB`);
    }

    // Extract.
    if (verbose) {
        console.error(`[setup] Extracting ${asset.name}...`);
    }

    if (archivePath.endsWith(".zip")) {
        // Use tar (bsdtar on Windows) which handles zip files.
        execSync(`tar -xf "${archivePath}" -C "${destDir}"`, {
            stdio: verbose ? "inherit" : "pipe",
        });
    } else {
        // .tar.bz2 — works on both Linux (GNU tar) and Windows 10+ (bsdtar).
        // On Windows, tar may emit non-fatal warnings for Unix symlinks it
        // cannot create.  These symlinks (e.g. python3 → python3.12) are
        // non-essential and trimmed during sysroot cleanup, so we allow the
        // extraction to continue despite errors.
        try {
            execSync(`tar -xjf "${archivePath}" -C "${destDir}"`, {
                stdio: verbose ? "inherit" : "pipe",
            });
        } catch {
            // Verify that at least some files were extracted before swallowing
            // the error.  If the directory is still empty, re-throw.
            const entries = await readdir(destDir);
            // Only the archive file itself is present → extraction truly failed.
            if (entries.length <= 1) {
                throw new Error(`Extraction failed for ${path.basename(archivePath)}`);
            }
            if (verbose) {
                console.error("[setup] tar completed with warnings (expected on Windows for symlinks)");
            }
        }
    }

    // Clean up archive file.
    await unlink(archivePath);
}

/**
 * Download and set up Nanvix sandbox binaries and runtime sysroots.
 *
 * For each runtime, we:
 *   1. Download the release tarball/zip (contains sysroot with binary + stdlib)
 *   2. Extract the sysroot directory under nanvixHome/runtimes/<name>-sysroot/
 *
 * At execution time, the sandbox runner writes the user script into the
 * sysroot, runs mkramfs to package it, then invokes nanvixd.
 */
export async function setup(options: SetupOptions): Promise<void> {
    const { nanvixHome, verbose = false } = options;

    await mkdir(nanvixHome, { recursive: true });
    await mkdir(path.join(nanvixHome, "runtimes"), { recursive: true });

    const stagingDir = path.join(nanvixHome, ".staging");
    await mkdir(stagingDir, { recursive: true });

    console.error("[setup] Fetching latest releases...");

    // 1. Download Nanvix sandbox.
    //    Linux:   nanvix-microvm-standalone-release-128mb-*.tar.bz2
    //    Windows: nanvix-windows-microvm-standalone-release-128mb-*.zip
    const nanvixRelease = await fetchLatestRelease("nanvix/nanvix");
    const nanvixAssetPattern = IS_WINDOWS
        ? /nanvix-windows-microvm-standalone-release-128mb-.*\.zip$/
        : /nanvix-microvm-standalone-release-128mb-.*\.tar\.bz2$/;
    const nanvixAsset = findAsset(nanvixRelease, nanvixAssetPattern);

    await downloadAndExtract(nanvixAsset, stagingDir, verbose);

    // Copy extracted binaries into nanvixHome.
    //
    // Linux archives contain a directory tree (bin/, etc/, lib/). We locate
    // the bin/ directory and copy the parent tree.
    //
    // Windows archives contain flat files (*.exe, *.elf, *.img) in the
    // archive root.  We create bin/ and copy all binaries into it.
    const nanvixBinDir = await findDirectory(stagingDir, "bin");
    if (nanvixBinDir) {
        // Linux layout — copy the whole tree.
        const nanvixRoot = path.dirname(nanvixBinDir);
        await cp(nanvixRoot, nanvixHome, { recursive: true });
    } else if (IS_WINDOWS) {
        // Windows flat layout — stage binaries into bin/.
        const binDir = path.join(nanvixHome, "bin");
        await mkdir(binDir, { recursive: true });
        const entries = await readdir(stagingDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isFile()) {
                await cp(
                    path.join(stagingDir, entry.name),
                    path.join(binDir, entry.name),
                );
            }
        }
    }

    const mkramfs = path.join(nanvixHome, "bin", hostBinaryName("mkramfs"));
    if (!(await fileExists(mkramfs))) {
        throw new Error(`${hostBinaryName("mkramfs")} not found at ${mkramfs}`);
    }

    // Clean staging for runtime downloads.
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true });

    // 2. Download CPython runtime (microvm, standalone, 128mb).
    //    Guest runtime — same archive on all host platforms.
    console.error("[setup] Setting up Python runtime...");
    const cpythonRelease = await fetchLatestRelease("nanvix/cpython");
    const cpythonAsset = findAsset(
        cpythonRelease,
        /cpython-microvm-standalone-128mb\.tar\.bz2$/
    );

    await downloadAndExtract(cpythonAsset, stagingDir, verbose);

    // The CPython tarball extracts to sysroot/ with bin/python3.12 and lib/python3.12/.
    // Keep it as a directory so we can inject user scripts at runtime before mkramfs.
    const cpythonSysroot = path.join(stagingDir, "sysroot");
    const pythonSysrootDest = path.join(nanvixHome, "runtimes", "python-sysroot");

    if (await fileExists(cpythonSysroot)) {
        await rm(pythonSysrootDest, { recursive: true, force: true });
        await rename(cpythonSysroot, pythonSysrootDest);

        // Aggressively trim the Python sysroot to fit in the 128MB VM.
        // Empirically, the ramfs image is ≈3.5× file sizes (block-alignment
        // overhead + 2× image mapping), so file content must stay under ~36MB.
        console.error("[setup] Trimming Python sysroot for 128MB VM...");

        // Phase 1: Remove top-level build artifacts and development files.
        for (const target of ["include", "share", "lib/pkgconfig"]) {
            await rm(path.join(pythonSysrootDest, target), { recursive: true, force: true }).catch(() => { });
        }

        // Phase 2: Remove everything from lib/ except the python3.12/ directory.
        // The standalone binary is statically linked — no shared/static libs needed.
        const libDir = path.join(pythonSysrootDest, "lib");
        if (await fileExists(libDir)) {
            const libEntries = await readdir(libDir, { withFileTypes: true });
            for (const entry of libEntries) {
                if (entry.name !== "python3.12") {
                    await rm(path.join(libDir, entry.name), { recursive: true, force: true });
                }
            }
        }

        // Phase 3: Clean bin/ — keep only the python3.12 interpreter binary.
        const binDir = path.join(pythonSysrootDest, "bin");
        if (await fileExists(binDir)) {
            const binEntries = await readdir(binDir, { withFileTypes: true });
            for (const entry of binEntries) {
                if (entry.name !== "python3.12") {
                    await rm(path.join(binDir, entry.name), { recursive: true, force: true });
                }
            }
        }

        // Phase 4: Strip debug symbols from the Python binary.
        // Try llvm-strip first (handles ELF on any host, including Windows),
        // then fall back to strip (Linux/macOS).
        const pythonBin = path.join(pythonSysrootDest, "bin", "python3.12");
        if (await fileExists(pythonBin)) {
            let stripped = false;
            for (const cmd of ["llvm-strip", "strip"]) {
                if (stripped) break;
                try {
                    execSync(`${cmd} "${pythonBin}"`, { stdio: "pipe" });
                    stripped = true;
                    if (verbose) console.error(`[setup] Stripped Python binary with ${cmd}`);
                } catch {
                    // Tool not available or failed; try next.
                }
            }
        }

        // Phase 5: Allowlist for lib/python3.12/ — keep only essential modules.
        // Uses an allowlist instead of a blacklist so the sysroot stays small
        // regardless of what the upstream CPython release ships.
        const pyLibDir = path.join(pythonSysrootDest, "lib", "python3.12");
        if (await fileExists(pyLibDir)) {
            const allowedFiles = new Set([
                // Python boot and import chain.
                "__future__.py",
                "_collections_abc.py",
                "_py_abc.py",
                "_sitebuiltins.py",
                "_weakrefset.py",
                "abc.py",
                "codecs.py",
                "copyreg.py",
                "genericpath.py",
                "io.py",
                "os.py",
                "posixpath.py",
                "site.py",
                "stat.py",
                "types.py",
                "warnings.py",
                "linecache.py",
                "traceback.py",
                // Eval wrapper dependencies (base64 → struct → binascii).
                "base64.py",
                "struct.py",
                // Commonly used stdlib modules for user scripts.
                "string.py",
                "functools.py",
                "operator.py",
                "keyword.py",
                "copy.py",
                "enum.py",
                "contextlib.py",
                "random.py",
                "heapq.py",
                "bisect.py",
                "datetime.py",
                "textwrap.py",
            ]);
            const allowedDirs = new Set([
                "collections",
                "encodings",
                "importlib",
                "json",
                "re",
            ]);

            const pyLibEntries = await readdir(pyLibDir, { withFileTypes: true });
            for (const entry of pyLibEntries) {
                if (entry.isDirectory()) {
                    if (!allowedDirs.has(entry.name)) {
                        await rm(path.join(pyLibDir, entry.name), { recursive: true, force: true });
                    }
                } else if (entry.isFile()) {
                    if (!allowedFiles.has(entry.name)) {
                        await rm(path.join(pyLibDir, entry.name), { force: true });
                    }
                }
            }

            // Prune encodings/ to essential codecs only (saves ~1.5MB of small files
            // that also cause disproportionate ramfs block-alignment waste).
            const encodingsDir = path.join(pyLibDir, "encodings");
            if (await fileExists(encodingsDir)) {
                const essentialEncodings = new Set([
                    "__init__.py",
                    "aliases.py",
                    "ascii.py",
                    "latin_1.py",
                    "raw_unicode_escape.py",
                    "unicode_escape.py",
                    "utf_8.py",
                    "utf_8_sig.py",
                ]);
                const encEntries = await readdir(encodingsDir, { withFileTypes: true });
                for (const entry of encEntries) {
                    if (!essentialEncodings.has(entry.name)) {
                        await rm(path.join(encodingsDir, entry.name), { recursive: true, force: true });
                    }
                }
            }

            // Remove importlib/metadata/ (package metadata not needed at runtime).
            await rm(path.join(pyLibDir, "importlib", "metadata"), { recursive: true, force: true }).catch(() => { });
        }

        // Phase 6: Remove __pycache__ dirs (Python runs from .py sources).
        await removeDirectoriesByName(pythonSysrootDest, "__pycache__");

        // Phase 7: Bake the eval wrapper into the sysroot.
        await writeFile(
            path.join(pythonSysrootDest, "eval_stdin.py"),
            PYTHON_EVAL_WRAPPER,
            "utf-8"
        );

        // Phase 8: Validate sysroot size fits in the 128MB VM.
        // The VM reserves space for initrd + slack (~22MB), leaving ~101MB
        // for ramfs. Ramfs image = 2× content, content ≈ 1.6× file sizes,
        // so max file sizes ≈ 101 / 2 / 1.6 ≈ 31MB.
        const sysrootSize = await directorySize(pythonSysrootDest);
        const sysrootMB = sysrootSize / 1024 / 1024;
        const maxContentBytes = 30 * 1024 * 1024;
        if (verbose || sysrootSize > maxContentBytes) {
            console.error(`[setup] Python sysroot: ${sysrootMB.toFixed(1)}M (trimmed, with eval wrapper)`);
        }
        if (sysrootSize > maxContentBytes) {
            console.error(
                `[setup] WARNING: Python sysroot (${sysrootMB.toFixed(1)}M) exceeds ` +
                `the estimated safe limit (~30M). The ramfs image may not fit ` +
                `in the 128MB VM. Consider removing additional modules.`
            );
        }
    } else {
        console.error("[setup] WARNING: CPython sysroot not found in release");
    }

    // Clean staging for next download.
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true });

    // 3. Download QuickJS runtime (microvm, standalone, 128mb).
    //    Guest runtime — same archive on all host platforms.
    console.error("[setup] Setting up QuickJS runtime...");
    const quickjsRelease = await fetchLatestRelease("nanvix/quickjs");
    const quickjsAsset = findAsset(
        quickjsRelease,
        /quickjs-microvm-standalone-128mb\.tar\.bz2$/
    );

    await downloadAndExtract(quickjsAsset, stagingDir, verbose);

    // QuickJS extracts to quickjs-microvm-standalone-128mb/ with bin/qjs.elf.
    // Build a sysroot directory for the sandbox runner.
    const qjsSysrootDest = path.join(nanvixHome, "runtimes", "quickjs-sysroot");
    const qjsBin = await findFile(
        stagingDir,
        (name) => name === "qjs" || name === "qjs.elf",
    );
    if (qjsBin) {
        await rm(qjsSysrootDest, { recursive: true, force: true });
        await mkdir(path.join(qjsSysrootDest, "bin"), { recursive: true });
        // Copy the qjs binary into the sysroot.
        await cp(qjsBin, path.join(qjsSysrootDest, "bin", path.basename(qjsBin)));
        // Bake the eval wrapper into the sysroot.
        await writeFile(
            path.join(qjsSysrootDest, "eval_stdin.js"),
            JS_EVAL_WRAPPER,
            "utf-8"
        );
        if (verbose) {
            const size = await directorySize(qjsSysrootDest);
            console.error(`[setup] QuickJS sysroot: ${(size / 1024 / 1024).toFixed(1)}M (with eval wrapper)`);
        }
    } else {
        console.error("[setup] NOTE: QuickJS release is SDK-only (no interpreter binary).");
        console.error("[setup]       JavaScript runtime is not yet available.");
    }

    // Clean up staging.
    await rm(stagingDir, { recursive: true, force: true });

    // Verify core artifacts.
    const requiredFiles = [
        path.join(nanvixHome, "bin", hostBinaryName("nanvixd")),
        mkramfs,
        pythonSysrootDest,
    ];

    for (const file of requiredFiles) {
        if (!(await fileExists(file))) {
            throw new Error(`Required file not found: ${file}`);
        }
    }

    console.error("[setup] Setup complete. Nanvix home:", nanvixHome);
    console.error("[setup] Available runtimes:");
    if (await fileExists(pythonSysrootDest)) {
        console.error("[setup]   - Python:  runtimes/python-sysroot/");
    }
    const qjsSysroot = path.join(nanvixHome, "runtimes", "quickjs-sysroot");
    if (await fileExists(qjsSysroot)) {
        console.error("[setup]   - QuickJS: runtimes/quickjs-sysroot/");
    }
}

// Allow running directly: npx tsx src/setup.ts [--nanvix-home <path>]
const isMain = process.argv[1]?.endsWith("setup.ts") || process.argv[1]?.endsWith("setup.js");
if (isMain) {
    const homeIdx = process.argv.indexOf("--nanvix-home");
    const nanvixHome = homeIdx !== -1 && process.argv[homeIdx + 1]
        ? process.argv[homeIdx + 1]
        : path.join(process.cwd(), "nanvix");

    const verbose = process.argv.includes("--verbose");

    setup({ nanvixHome, verbose }).catch((err) => {
        console.error("Setup failed:", err.message);
        process.exit(1);
    });
}
