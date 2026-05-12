import { createWriteStream } from "node:fs";
import { mkdir, access, stat, writeFile, readFile, rm, cp, rename, readdir, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import { crc32, deflateRawSync } from "node:zlib";
import { PYTHON_EVAL_WRAPPER, JS_EVAL_WRAPPER } from "./sandbox.js";
import { IS_WINDOWS, hostBinaryName } from "./platform.js";

// VM memory tier — 256MB on all platforms.
const VM_MEMORY_TIER = "256mb";

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

/**
 * Create a DEFLATE-compressed ZIP from all files under `dirPath`.
 * Python's zipimport uses this format (lib/python312.zip) to import modules.
 * Deflate compression significantly reduces the zip size (Python .py source
 * files compress ~60-70%), keeping the ramfs image within the VM memory limit.
 * Python's zipimport natively supports deflated entries via its built-in zlib.
 */
async function createDeflatedZip(dirPath: string, outputPath: string): Promise<void> {
    const entries = await readdir(dirPath, { withFileTypes: true, recursive: true });
    const files: Array<{ name: string; data: Buffer; compressed: Buffer }> = [];
    for (const entry of entries) {
        if (entry.isFile()) {
            const fullPath = path.join(entry.parentPath ?? entry.path, entry.name);
            const data = await readFile(fullPath);
            const relPath = path.relative(dirPath, fullPath).split(path.sep).join("/");
            const compressed = deflateRawSync(data);
            files.push({ name: relPath, data, compressed });
        }
    }

    const parts: Buffer[] = [];
    const cdEntries: Buffer[] = [];
    let offset = 0;

    for (const file of files) {
        const nameBytes = Buffer.from(file.name);
        const fileCrc = crc32(file.data);

        // Local file header (30 bytes fixed + name + compressed data).
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);            // local header signature
        lh.writeUInt16LE(20, 4);                     // version needed (2.0)
        lh.writeUInt16LE(8, 8);                      // compression: deflated
        lh.writeUInt32LE(fileCrc, 14);               // CRC-32
        lh.writeUInt32LE(file.compressed.length, 18); // compressed size
        lh.writeUInt32LE(file.data.length, 22);      // uncompressed size
        lh.writeUInt16LE(nameBytes.length, 26);      // file name length
        parts.push(lh, nameBytes, file.compressed);

        // Central directory entry (46 bytes fixed + name).
        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);             // central dir signature
        cd.writeUInt16LE(20, 4);                     // version made by
        cd.writeUInt16LE(20, 6);                     // version needed
        cd.writeUInt16LE(8, 10);                     // compression: deflated
        cd.writeUInt32LE(fileCrc, 16);               // CRC-32
        cd.writeUInt32LE(file.compressed.length, 20); // compressed size
        cd.writeUInt32LE(file.data.length, 24);      // uncompressed size
        cd.writeUInt16LE(nameBytes.length, 28);      // file name length
        cd.writeUInt32LE(offset, 42);                // local header offset
        cdEntries.push(cd, nameBytes);

        offset += 30 + nameBytes.length + file.compressed.length;
    }

    // End of central directory record (22 bytes).
    const cdOffset = offset;
    const cdSize = cdEntries.reduce((s, b) => s + b.length, 0);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);               // EOCD signature
    eocd.writeUInt16LE(files.length, 8);             // entries on this disk
    eocd.writeUInt16LE(files.length, 10);            // total entries
    eocd.writeUInt32LE(cdSize, 12);                  // central dir size
    eocd.writeUInt32LE(cdOffset, 16);                // central dir offset

    await writeFile(outputPath, Buffer.concat([...parts, ...cdEntries, eocd]));
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
        // .tar.bz2 or .tar.gz — works on both Linux (GNU tar) and Windows 10+ (bsdtar).
        // On Windows, tar may emit non-fatal warnings for Unix symlinks it
        // cannot create.  These symlinks (e.g. python3 → python3.12) are
        // non-essential and trimmed during sysroot cleanup, so we allow the
        // extraction to continue despite errors.
        const tarFlag = archivePath.endsWith(".tar.bz2") ? "-xjf" : "-xzf";
        try {
            execSync(`tar ${tarFlag} "${archivePath}" -C "${destDir}"`, {
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
    //    Linux:   nanvix-x86-microvm-standalone-release-256mb-*.tar.bz2
    //    Windows: nanvix-windows-x86-microvm-standalone-release-256mb-*.zip
    const nanvixRelease = await fetchLatestRelease("nanvix/nanvix");
    const nanvixAssetPattern = IS_WINDOWS
        ? new RegExp(`nanvix-windows-x86-microvm-standalone-release-${VM_MEMORY_TIER}-.*\\.zip$`)
        : new RegExp(`nanvix-x86-microvm-standalone-release-${VM_MEMORY_TIER}-.*\\.tar\\.bz2$`);
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

    // 2. Download CPython runtime (microvm, standalone, matching VM tier).
    //    Same tarball on all platforms — stdlib is pure Python (.py) and the
    //    guest binary is always ELF (runs inside the Nanvix microvm).
    console.error("[setup] Setting up Python runtime...");
    const cpythonRelease = await fetchLatestRelease("nanvix/cpython");
    const cpythonAsset = findAsset(
        cpythonRelease,
        new RegExp(`cpython-microvm-standalone-${VM_MEMORY_TIER}\\.tar\\.gz$`)
    );

    await downloadAndExtract(cpythonAsset, stagingDir, verbose);

    // The CPython 256MB tarball extracts to:
    //   sysroot/lib/python3.12/   — stdlib sources
    //   bin/python.elf            — guest binary (outside sysroot/)
    // We reassemble them into python-sysroot/ with bin/ and lib/.
    const cpythonSysroot = path.join(stagingDir, "sysroot");
    const pythonSysrootDest = path.join(nanvixHome, "runtimes", "python-sysroot");

    if (await fileExists(cpythonSysroot)) {
        await rm(pythonSysrootDest, { recursive: true, force: true });
        await rename(cpythonSysroot, pythonSysrootDest);

        // The guest binary (python.elf) may be outside sysroot/ in the tarball.
        // Locate it in staging and move it into the sysroot bin/ directory.
        const stagedBin = await findFile(stagingDir, (name) => name === "python.elf");
        if (stagedBin) {
            const sysrootBinDir = path.join(pythonSysrootDest, "bin");
            await mkdir(sysrootBinDir, { recursive: true });
            await cp(stagedBin, path.join(sysrootBinDir, "python.elf"));
        }

        // Trim the Python sysroot to fit in the VM.
        // Empirically, mkramfs adds ~43% filesystem overhead (block alignment,
        // metadata) and the image is 2× content, so image ≈ 2.86× file sizes.
        // For a 256MB VM, file sizes must stay under ~89MB.
        console.error(`[setup] Trimming Python sysroot for ${VM_MEMORY_TIER.toUpperCase()} VM...`);

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

        // Phase 3: Clean bin/ — keep only the python.elf interpreter binary.
        const binDir = path.join(pythonSysrootDest, "bin");
        if (await fileExists(binDir)) {
            const binEntries = await readdir(binDir, { withFileTypes: true });
            for (const entry of binEntries) {
                if (entry.name !== "python.elf") {
                    await rm(path.join(binDir, entry.name), { recursive: true, force: true });
                }
            }
        }

        // Phase 4: Strip debug symbols from the Python binary.
        // Try llvm-strip first (handles ELF on any host, including Windows),
        // then fall back to strip (Linux/macOS).
        const pythonBin = path.join(pythonSysrootDest, "bin", "python.elf");
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
                "token.py",
                "tokenize.py",
                // Eval wrapper dependencies (base64 → struct → binascii).
                "base64.py",
                "struct.py",
                // Commonly used stdlib modules for user scripts.
                "string.py",
                "textwrap.py",
                "functools.py",
                "operator.py",
                "keyword.py",
                "copy.py",
                "enum.py",
                "typing.py",
                "contextlib.py",
                "dataclasses.py",
                "random.py",
                "heapq.py",
                "bisect.py",
                "datetime.py",
                "pprint.py",
                "reprlib.py",
                "numbers.py",
                "platform.py",
                "inspect.py",
                "dis.py",
                "opcode.py",
                "_opcode.py",
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

        // Phase 7: Create the ramfs directory structure.
        // The python.elf binary is loaded by nanvixd via the host path (not from
        // the ramfs), so we exclude it from the ramfs to save ~36MB. Only the
        // stdlib zip and eval wrapper go into the ramfs.
        const ramfsDir = path.join(pythonSysrootDest, "ramfs");
        const ramfsLibDir = path.join(ramfsDir, "lib");
        await mkdir(ramfsLibDir, { recursive: true });

        // Phase 7b: Consolidate stdlib into a compressed zip in the ramfs.
        // Python automatically adds lib/python312.zip to sys.path at startup
        // (see CPython Modules/getpath.py). This replaces ~50 loose files with
        // one deflate-compressed zip file, saving both per-file ramfs overhead
        // (~14MB of block-alignment waste) and raw file size (~60-70% compression
        // on .py text).
        const pyLibDir312 = path.join(pythonSysrootDest, "lib", "python3.12");
        const stdlibZipPath = path.join(ramfsLibDir, "python312.zip");
        if (await fileExists(pyLibDir312)) {
            await createDeflatedZip(pyLibDir312, stdlibZipPath);
            await rm(pyLibDir312, { recursive: true, force: true });
            if (verbose) console.error("[setup] Consolidated stdlib into ramfs/lib/python312.zip");
        }
        // Remove the original lib/ (now empty or unused).
        await rm(path.join(pythonSysrootDest, "lib"), { recursive: true, force: true }).catch(() => { });

        // Phase 8: Bake the eval wrapper into the ramfs.
        await writeFile(
            path.join(ramfsDir, "eval_stdin.py"),
            PYTHON_EVAL_WRAPPER,
            "utf-8"
        );

        // Phase 9: Validate ramfs content size fits in the VM.
        // Without the binary, the ramfs only contains the deflate-compressed
        // stdlib zip (~4MB) and the eval wrapper (<1KB). mkramfs adds fixed
        // filesystem overhead, then image = 2× content. This should be well
        // under the VM limit.
        const ramfsSize = await directorySize(ramfsDir);
        const ramfsMB = ramfsSize / 1024 / 1024;
        const vmSizeMB = parseInt(VM_MEMORY_TIER, 10);
        const maxRamfsBytes = Math.floor(vmSizeMB / 2.86) * 1024 * 1024;
        const maxRamfsMB = Math.floor(vmSizeMB / 2.86);
        if (verbose || ramfsSize > maxRamfsBytes) {
            console.error(`[setup] Python ramfs content: ${ramfsMB.toFixed(1)}M (stdlib zip + eval wrapper)`);
        }
        if (ramfsSize > maxRamfsBytes) {
            console.error(
                `[setup] WARNING: Python ramfs content (${ramfsMB.toFixed(1)}M) exceeds ` +
                `the estimated safe limit (~${maxRamfsMB}M). The ramfs image may not fit ` +
                `in the ${VM_MEMORY_TIER.toUpperCase()} VM. Consider removing additional modules.`
            );
        }
    } else {
        console.error("[setup] WARNING: CPython sysroot not found in release");
    }

    // Clean staging for next download.
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true });

    // 3. Download QuickJS runtime (microvm, standalone, matching VM tier).
    //    Guest binary must match the VM memory tier.
    console.error("[setup] Setting up QuickJS runtime...");
    const quickjsRelease = await fetchLatestRelease("nanvix/quickjs");
    const quickjsAsset = findAsset(
        quickjsRelease,
        new RegExp(`quickjs-microvm-standalone-${VM_MEMORY_TIER}\\.tar\\.gz$`)
    );

    await downloadAndExtract(quickjsAsset, stagingDir, verbose);

    // QuickJS extracts to quickjs-microvm-standalone-<tier>/ with bin/qjs.elf.
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
