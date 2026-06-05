import { mkdir, access, stat, writeFile, readFile, rm, cp, readdir } from "node:fs/promises";
import { execSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import { PYTHON_EVAL_WRAPPER, JS_EVAL_WRAPPER } from "./sandbox.js";
import { IS_WINDOWS, hostBinaryName } from "./platform.js";

// VM memory tier — 256MB on all platforms.
const VM_MEMORY_TIER = "256mb";

// Docker image passed to `nanvix-zutil setup --with-docker`. nanvix-zutil's
// setup subcommand requires a toolchain image, but nanvix-copilot is
// download-only (it never compiles inside the container), so the image is
// validated/persisted but never used for a build. Override via the
// NANVIX_DOCKER_IMAGE environment variable if needed.
const DEFAULT_DOCKER_IMAGE = "ghcr.io/nanvix/toolchain-python:latest";

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

/**
 * Invoke `./z setup` (nanvix_zutil) to download and extract all
 * dependencies into `.nanvix/`.  The bootstrap scripts auto-install
 * nanvix-zutil into `.nanvix/venv/` when it is not already present.
 *
 * nanvix-zutil's `setup` subcommand requires a `--with-docker IMAGE`
 * argument (the image is persisted for later build/release commands).
 * nanvix-copilot never builds inside the container, so the image is only
 * used to satisfy the CLI; on Linux it is still pulled by zutil.
 */
function runZutilSetup(projectRoot: string, verbose: boolean): void {
    const env = { ...process.env };
    // Normalize token so zutils picks it up consistently.
    if (!env.GH_TOKEN && env.GITHUB_TOKEN) {
        env.GH_TOKEN = env.GITHUB_TOKEN;
    }

    const dockerImage = env.NANVIX_DOCKER_IMAGE || DEFAULT_DOCKER_IMAGE;
    const setupArgs = ["setup", "--with-docker", dockerImage];

    const result = IS_WINDOWS
        ? spawnSync(
              "powershell.exe",
              ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(projectRoot, "z.ps1"), ...setupArgs],
              { cwd: projectRoot, env, stdio: verbose ? "inherit" : "pipe" },
          )
        : spawnSync(
              "bash",
              [path.join(projectRoot, "z.sh"), ...setupArgs],
              { cwd: projectRoot, env, stdio: verbose ? "inherit" : "pipe" },
          );

    if (result.status !== 0) {
        const stderr = result.stderr ? result.stderr.toString().trim() : "";
        throw new Error(`nanvix-zutil setup failed (exit ${result.status})${stderr ? ": " + stderr : ""}`);
    }
}

/**
 * Set up Nanvix sandbox binaries and runtime sysroots.
 *
 * Dependencies are downloaded by nanvix_zutil (``./z setup``), which
 * extracts them into ``.nanvix/``.  This function copies the results
 * into ``nanvixHome`` and applies copilot-specific post-processing
 * (stdlib allowlist, compressed zip, eval wrappers).
 */
export async function setup(options: SetupOptions): Promise<void> {
    const { nanvixHome, verbose = false } = options;

    // Locate the project root (where z.sh / .nanvix/ live).
    const thisFile = fileURLToPath(import.meta.url);
    const projectRoot = path.resolve(path.dirname(thisFile), "..");
    const nanvixDir = path.join(projectRoot, ".nanvix");

    await mkdir(nanvixHome, { recursive: true });
    await mkdir(path.join(nanvixHome, "runtimes"), { recursive: true });

    // 1. Run nanvix_zutil to download sysroot + runtimes into .nanvix/.
    console.error("[setup] Running nanvix-zutil setup...");
    runZutilSetup(projectRoot, verbose);

    // 2. Copy Nanvix sysroot binaries into nanvixHome.
    console.error("[setup] Installing Nanvix sysroot...");
    const sysrootDir = path.join(nanvixDir, "sysroot");
    const sysrootBinDir = await findDirectory(sysrootDir, "bin");
    if (sysrootBinDir) {
        const sysrootRoot = path.dirname(sysrootBinDir);
        await cp(sysrootRoot, nanvixHome, { recursive: true });
    } else {
        throw new Error(`Nanvix sysroot bin/ not found under ${sysrootDir}`);
    }

    const mkramfs = path.join(nanvixHome, "bin", hostBinaryName("mkramfs"));
    if (!(await fileExists(mkramfs))) {
        throw new Error(`${hostBinaryName("mkramfs")} not found at ${mkramfs}`);
    }

    // 3. Process CPython runtime.
    console.error("[setup] Setting up Python runtime...");
    const cpythonDir = path.join(nanvixDir, "runtimes", "cpython");
    const pythonSysrootDest = path.join(nanvixHome, "runtimes", "python-sysroot");

    if (await fileExists(cpythonDir)) {
        await rm(pythonSysrootDest, { recursive: true, force: true });
        await mkdir(pythonSysrootDest, { recursive: true });

        // Copy python.elf into the sysroot.
        const pythonElf = await findFile(cpythonDir, (name) => name === "python.elf");
        if (!pythonElf) {
            throw new Error("python.elf not found in CPython runtime");
        }
        const sysrootBin = path.join(pythonSysrootDest, "bin");
        await mkdir(sysrootBin, { recursive: true });
        await cp(pythonElf, path.join(sysrootBin, "python.elf"));

        // Copy the stdlib tree.  The upstream tarball is already trimmed by
        // zutils (idlelib, tkinter, etc. removed).  We copy it so that the
        // copilot-specific allowlist (below) can further reduce it.
        const cpythonSysroot = await findDirectory(cpythonDir, "sysroot");
        const cpythonLibDir = cpythonSysroot
            ? await findDirectory(cpythonSysroot, "python3.12")
            : undefined;
        if (!cpythonLibDir) {
            throw new Error("python3.12 stdlib not found in CPython runtime");
        }
        const destLib = path.join(pythonSysrootDest, "lib", "python3.12");
        await cp(cpythonLibDir, destLib, { recursive: true });

        // Strip debug symbols from the Python binary.
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

        // Allowlist for lib/python3.12/ — keep only essential modules.
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

            // Prune encodings/ to essential codecs only.
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

        // Defensive cleanup: remove __pycache__ before zipping.
        await removeDirectoriesByName(pythonSysrootDest, "__pycache__");

        // Create the ramfs directory structure.
        const ramfsDir = path.join(pythonSysrootDest, "ramfs");
        const ramfsLibDir = path.join(ramfsDir, "lib");
        await mkdir(ramfsLibDir, { recursive: true });

        // Consolidate stdlib into a compressed zip in the ramfs.
        const pyLibDir312 = path.join(pythonSysrootDest, "lib", "python3.12");
        const stdlibZipPath = path.join(ramfsLibDir, "python312.zip");
        if (await fileExists(pyLibDir312)) {
            await createDeflatedZip(pyLibDir312, stdlibZipPath);
            await rm(pyLibDir312, { recursive: true, force: true });
            if (verbose) console.error("[setup] Consolidated stdlib into ramfs/lib/python312.zip");
        }
        await rm(path.join(pythonSysrootDest, "lib"), { recursive: true, force: true }).catch(() => { });

        // Bake the eval wrapper into the ramfs.
        await writeFile(
            path.join(ramfsDir, "eval_stdin.py"),
            PYTHON_EVAL_WRAPPER,
            "utf-8"
        );

        // Validate ramfs content size fits in the VM.
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
        console.error("[setup] WARNING: CPython runtime not found in .nanvix/runtimes/cpython");
    }

    // 4. Process QuickJS runtime.
    console.error("[setup] Setting up QuickJS runtime...");
    const quickjsDir = path.join(nanvixDir, "runtimes", "quickjs");
    const qjsSysrootDest = path.join(nanvixHome, "runtimes", "quickjs-sysroot");

    if (await fileExists(quickjsDir)) {
        const qjsBin = await findFile(
            quickjsDir,
            (name) => name === "qjs" || name === "qjs.elf",
        );
        if (qjsBin) {
            await rm(qjsSysrootDest, { recursive: true, force: true });
            await mkdir(path.join(qjsSysrootDest, "bin"), { recursive: true });
            await cp(qjsBin, path.join(qjsSysrootDest, "bin", path.basename(qjsBin)));
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
    } else {
        console.error("[setup] WARNING: QuickJS runtime not found in .nanvix/runtimes/quickjs");
    }

    // 5. Verify core artifacts.
    const requiredFiles = [
        path.join(nanvixHome, "bin", hostBinaryName("nanvixd")),
        mkramfs,
        path.join(pythonSysrootDest, "bin", "python.elf"),
        path.join(pythonSysrootDest, "ramfs", "lib", "python312.zip"),
        path.join(pythonSysrootDest, "ramfs", "eval_stdin.py"),
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
    if (await fileExists(qjsSysrootDest)) {
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
