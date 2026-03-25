/**
 * Base64 encoding/decoding utilities for the Nanvix sandbox I/O protocol.
 *
 * Programs and arguments are base64-encoded before being sent to the sandbox
 * via stdin, and the sandbox output is base64-encoded on stdout.
 */

export function encodeBase64(input: string): string {
    return Buffer.from(input, "utf-8").toString("base64");
}

export function decodeBase64(input: string): string {
    return Buffer.from(input, "base64").toString("utf-8");
}
