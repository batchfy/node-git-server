import type * as http from "node:http"
import { createGunzip, createInflate } from "node:zlib"
import { format } from "node:util"
import { spawn } from "node:child_process"
import { PassThrough, Transform, type Duplex } from "node:stream"

import { HttpDuplex } from "./http-duplex.js"
import type { ServiceString } from "./types.js"
import { packSideband } from "./util.js"

const headerRegex: Record<string, string> = {
    "receive-pack": "([0-9a-fA-F]+) ([0-9a-fA-F]+) refs/(heads|tags)/(.*?)( |00|\\u0000)|^(0000)$",
    "upload-pack": "^\\S+ ([0-9a-fA-F]+)",
}

const decoder: Record<string, () => Duplex> = {
    gzip: () => createGunzip(),
    deflate: () => createInflate(),
}

export interface ServiceOptions {
    repo: string
    cwd: string
    service: ServiceString
}

export class Service extends HttpDuplex {
    status: string
    override repo: string
    service: string
    override cwd: string
    logs: string[]
    last: string | undefined
    commit: string | undefined
    evName: string | undefined
    username: string | undefined

    /**
     * Handles invoking the git-*-pack binaries.
     * @param opts - options to bootstrap the service object
     * @param req - http request object
     * @param res - http response
     */
    constructor(opts: ServiceOptions, req: http.IncomingMessage, res: http.ServerResponse) {
        super(req, res)

        let data = ""

        this.status = "pending"
        this.repo = opts.repo
        this.service = opts.service
        this.cwd = opts.cwd
        this.logs = []

        // buffers the request body until the service is accepted, then replays it to git
        const buffered = new PassThrough()
        buffered.pause()

        // peeks at the decoded stream so we can parse the pkt-line header before accepting
        const ts = new PassThrough()

        const encoding = req.headers["content-encoding"]

        if (encoding && decoder[encoding]) {
            // data is compressed with gzip or deflate
            req.pipe(decoder[encoding]()).pipe(ts).pipe(buffered)
        } else {
            // data is not compressed
            req.pipe(ts).pipe(buffered)
        }

        const authorization = req.headers["authorization"]
        if (authorization) {
            const [scheme, token] = authorization.split(" ")
            if (scheme === "Basic" && token) {
                const [username] = Buffer.from(token, "base64").toString("utf8").split(":")
                this.username = username
            }
        }

        ts.once("data", (chunk: Buffer | string) => {
            data += chunk

            const ops = data.match(new RegExp(headerRegex[this.service], "gi"))
            if (!ops) return
            data = ""

            for (const op of ops) {
                const m = op.match(new RegExp(headerRegex[this.service]))
                if (!m) continue

                if (this.service === "receive-pack") {
                    this.last = m[1]
                    this.commit = m[2]

                    const type = m[3] === "heads" ? "branch" : "version"
                    this.evName = type === "branch" ? "push" : "tag"

                    const headers: Record<string, string> = {
                        last: this.last,
                        commit: this.commit,
                    }
                    headers[type] = (this as unknown as Record<string, string>)[type] = m[4]
                    this.emit("header", headers)
                } else if (this.service === "upload-pack") {
                    this.commit = m[1]
                    this.evName = "fetch"
                    this.emit("header", {
                        commit: this.commit,
                    })
                }
            }
        })

        this.once("accept", () => {
            process.nextTick(() => {
                const cmd =
                    process.platform === "win32"
                        ? ["git", opts.service, "--stateless-rpc", opts.cwd]
                        : ["git-" + opts.service, "--stateless-rpc", opts.cwd]

                const ps = spawn(cmd[0], cmd.slice(1))

                ps.on("error", (error: Error) => {
                    this.emit("error", new Error(`${error.message} running command ${cmd.join(" ")}`))
                })

                this.emit("service", ps)

                const respStream = new Transform({
                    transform: (chunk: Buffer, _encoding, callback) => {
                        if (this.listenerCount("response") === 0) {
                            while (this.logs.length > 0) {
                                respStream.push(this.logs.pop())
                            }
                            respStream.push(chunk)
                            return callback()
                        }
                        // prevent git from sending the close signal
                        if (chunk.length === 4 && chunk.toString() === "0000") {
                            return callback()
                        }
                        respStream.push(chunk)
                        callback()
                    },
                })

                ;(respStream as unknown as { log: Service["log"] }).log = this.log.bind(this)

                this.emit("response", respStream, function endResponse() {
                    respStream.push(Buffer.from("0000"))
                    respStream.push(null)
                })

                // `end: false` keeps respStream open after git exits so the exit handler
                // can append any buffered log messages before closing the connection.
                ps.stdout.pipe(respStream, { end: false }).pipe(res)

                buffered.pipe(ps.stdin)
                buffered.resume()

                ps.on("exit", () => {
                    if (this.logs.length > 0) {
                        while (this.logs.length > 0) {
                            respStream.push(this.logs.pop())
                        }
                        respStream.push(Buffer.from("0000"))
                    }
                    respStream.push(null)

                    this.emit("exit")
                })
            })
        })

        this.once("reject", (code: number, msg: string) => {
            res.statusCode = code
            res.end(msg)
        })
    }

    log(...args: unknown[]): void {
        const line = format(...args)
        const SIDEBAND = String.fromCharCode(2) // PROGRESS
        const message = `${SIDEBAND}${line}\n`
        const formattedMessage = Buffer.from(packSideband(message))

        this.logs.unshift(formattedMessage.toString())
    }

    /**
     * Rejects the request in flight.
     * @param code - http response code
     * @param msg - message that should be displayed on the client
     */
    override reject(code: number, msg: string): void {
        if (this.status !== "pending") return

        if (msg === undefined && typeof code === "string") {
            msg = code
            code = 500
        }
        this.status = "rejected"
        this.emit("reject", code || 500, msg)
    }

    /**
     * Accepts the request to access the resource.
     */
    override accept(): void {
        if (this.status !== "pending") return

        this.status = "accepted"
        this.emit("accept")
    }
}
