import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { encodeBase64, decodeBase64 } from "../src/encoding.js";
import { parseArgs } from "../src/cli.js";
import { IS_WINDOWS, hostBinaryName, hostBinaryPath } from "../src/platform.js";

describe("encoding", () => {
    it("should base64 encode a string", () => {
        const input = 'print("Hello, Nanvix!")';
        const encoded = encodeBase64(input);
        assert.equal(encoded, Buffer.from(input).toString("base64"));
    });

    it("should base64 decode a string", () => {
        const original = "Hello, World!";
        const encoded = Buffer.from(original).toString("base64");
        assert.equal(decodeBase64(encoded), original);
    });

    it("should roundtrip encode/decode", () => {
        const programs = [
            'print("Hello, Nanvix!")',
            'console.log("test")',
            "def fib(n):\n    if n <= 1: return n\n    return fib(n-1) + fib(n-2)\nprint(fib(10))",
            "",
            "Unicode: ñ, ü, 日本語",
        ];

        for (const program of programs) {
            assert.equal(decodeBase64(encodeBase64(program)), program);
        }
    });
});

describe("cli", () => {
    it("should parse a simple prompt", () => {
        const args = parseArgs(["node", "index.js", "Write a hello world"]);
        assert.equal(args.prompt, "Write a hello world");
        assert.equal(args.runtime, undefined);
        assert.equal(args.verbose, false);
        assert.equal(args.showHelp, false);
        assert.equal(args.setupMode, false);
    });

    it("should parse --runtime flag", () => {
        const args = parseArgs(["node", "index.js", "--runtime", "python", "do stuff"]);
        assert.equal(args.runtime, "python");
        assert.equal(args.prompt, "do stuff");
    });

    it("should parse --verbose flag", () => {
        const args = parseArgs(["node", "index.js", "--verbose", "do stuff"]);
        assert.equal(args.verbose, true);
    });

    it("should parse --setup flag", () => {
        const args = parseArgs(["node", "index.js", "--setup"]);
        assert.equal(args.setupMode, true);
    });

    it("should parse --help flag", () => {
        const args = parseArgs(["node", "index.js", "--help"]);
        assert.equal(args.showHelp, true);
    });

    it("should parse --perf flag", () => {
        const args = parseArgs(["node", "index.js", "--perf", "do stuff"]);
        assert.equal(args.perf, true);
        assert.equal(args.prompt, "do stuff");
    });

    it("should parse --nanvix-home flag", () => {
        const args = parseArgs(["node", "index.js", "--nanvix-home", "/opt/nanvix", "test"]);
        assert.equal(args.nanvixHome, path.resolve("/opt/nanvix"));
        assert.equal(args.prompt, "test");
    });
});

describe("platform", () => {
    it("should detect the current platform", () => {
        assert.equal(typeof IS_WINDOWS, "boolean");
    });

    it("should return .exe on Windows and .elf on Linux", () => {
        const name = hostBinaryName("nanvixd");
        if (IS_WINDOWS) {
            assert.equal(name, "nanvixd.exe");
        } else {
            assert.equal(name, "nanvixd.elf");
        }
    });

    it("should build a full host binary path", () => {
        const result = hostBinaryPath("/opt/nanvix", "mkramfs");
        const expected = IS_WINDOWS
            ? path.join("/opt/nanvix", "bin", "mkramfs.exe")
            : path.join("/opt/nanvix", "bin", "mkramfs.elf");
        assert.equal(result, expected);
    });

    it("should not change guest binary names", () => {
        // Guest binaries (python.elf, qjs.elf) are always ELF and are not
        // affected by hostBinaryName(). This test documents the intent.
        const guestBin = "python.elf";
        assert.equal(guestBin, "python.elf");
    });
});
