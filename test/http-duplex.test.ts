import http, { type Server } from "node:http"
import { readFileSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { HttpDuplex } from "../src/http-duplex.js"

const selfSrc = readFileSync(import.meta.filename)

/** Minimal `{0}`-style template formatter (replaces the old String.prototype.format). */
function format(template: string, ...args: unknown[]): string {
    return template.replace(/{(\d+)}/g, (match, index) =>
        typeof args[index] !== "undefined" ? String(args[index]) : match
    )
}

/** Collapses repeated whitespace/newlines (replaces the old String.prototype.streamline). */
function streamline(input: string, ending = "\n"): string {
    return input.replace(/[\f\t\v ]{2,}/g, " ").replace(/[\r\n]+/g, ending)
}

describe("http-duplex", () => {
    let server: Server

    beforeEach(() => {
        server = http.createServer((req, res) => {
            const dup = new HttpDuplex(req, res)
            switch (dup.url) {
                case "/":
                    dup.setHeader("content-type", "text/plain")
                    if (dup.method === "POST") {
                        dup.end(dup.headers["content-length"])
                    } else {
                        dup.end(readFileSync(import.meta.filename))
                    }
                    break
                case "/info":
                    if (dup.method === "GET") {
                        dup.setHeader("content-type", "text/plain")
                        const output = format(
                            "Method: {0}\n" +
                                "Path: {1}\n" +
                                "Status: {2}\n" +
                                "Http Version: {3}\n" +
                                "Complete: {4}\n" +
                                "Readable: {5}\n" +
                                "Writeable: {6}\n",
                            dup.method,
                            dup.url,
                            dup.statusCode,
                            `${dup.httpVersionMajor}.${dup.httpVersionMinor}`,
                            dup.complete,
                            dup.readable,
                            dup.writable
                        )
                        dup.end(streamline(output))
                    } else {
                        dup.statusCode = 400
                        dup.end("Bad Request")
                    }
                    break
                default:
                    dup.statusCode = 404
                    dup.end("File doesn't exist")
                    break
            }
        })
        server.listen()
    })

    afterEach(() => {
        server.close()
    })

    test("should be able to handle requests", async () => {
        expect.assertions(6)

        await new Promise((resolve, reject) => {
            server.on("error", reject)

            server.on("listening", async () => {
                const { port } = server.address() as AddressInfo
                const base = `http://localhost:${port}/`

                const body = await (await fetch(base)).text()
                expect(body).toBe(selfSrc.toString())

                const postBody = await (
                    await fetch(base, {
                        method: "POST",
                        body: "beep boop\n",
                        headers: { "Content-Type": "text/plain" },
                    })
                ).text()
                expect(postBody).toBe("10")

                const infoBody = streamline(await (await fetch(base + "info")).text())
                expect(infoBody).toContain("Method: GET")
                expect(infoBody).toContain("Path: /info")
                expect(infoBody).toContain("Status: 200")
                expect(infoBody).toContain("Http Version: 1.1")

                resolve("passed")
            })
        })
    })
})
