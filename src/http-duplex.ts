import type * as http from "node:http"
import { EventEmitter } from "node:events"

/**
 * Constructs a proxy object over an incoming request and outgoing response,
 * exposing them as a single unified stream. Generally meant to combine the
 * request and response streams passed to the http `request` event.
 * @see {@link https://nodejs.org/api/http.html#http_event_request|request}
 * @see {@link https://nodejs.org/api/http.html#http_class_http_incomingmessage|http.IncomingMessage}
 * @see {@link https://nodejs.org/api/http.html#http_class_http_serverresponse|http.ServerResponse}
 *
 * @example
 * ```js
 * http.createServer(function (req, res) {
 *   const dup = new HttpDuplex(req, res);
 *   res.end('Request: ' + req.method + ' ' + req.url);
 * }).listen(80);
 * ```
 */
export class HttpDuplex extends EventEmitter {
    setHeader(_name: string, _value: string): void {
        throw new Error("Method not implemented.")
    }
    end(_reason?: unknown): void {
        throw new Error("Method not implemented.")
    }
    destroy(): void {
        throw new Error("Method not implemented.")
    }
    accept(): void {
        throw new Error("Method not implemented.")
    }
    reject(_code: number, _msg: string): void {
        throw new Error("Method not implemented.")
    }

    /**
     * The IncomingMessage created by http.Server or http.ClientRequest, usually passed
     * as the first parameter to the 'request' and 'response' events.
     * @see {@link https://nodejs.org/api/http.html#http_class_http_incomingmessage|http.IncomingMessage}
     */
    req: http.IncomingMessage

    /**
     * The http.ServerResponse, passed as the second parameter to the 'request' event.
     * @see {@link https://nodejs.org/api/http.html#http_class_http_serverresponse|http.ServerResponse}
     */
    res: http.ServerResponse
    cwd: string | undefined
    repo: string | undefined
    exists: boolean | undefined

    constructor(input: http.IncomingMessage, output: http.ServerResponse) {
        super()

        this.req = input
        this.res = output

        // request / input proxy events
        for (const name of ["data", "end", "error", "close"] as const) {
            this.req.on(name, this.emit.bind(this, name))
        }

        // response / output proxy events
        for (const name of ["error", "drain"] as const) {
            this.res.on(name, this.emit.bind(this, name))
        }
    }

    get complete(): boolean {
        return this.req.complete
    }

    /**
     * Reference to the underlying socket for the request connection.
     * @readonly
     */
    get connection(): http.IncomingMessage["socket"] {
        return this.req.socket
    }

    /**
     * Request/response headers. Header names are always lower-case.
     * @readonly
     */
    get headers(): http.IncomingHttpHeaders {
        return this.req.headers
    }

    /**
     * Requested HTTP version sent by the client. Usually either '1.0' or '1.1'.
     * @readonly
     */
    get httpVersion(): string {
        return this.req.httpVersion
    }

    /**
     * First integer in the httpVersion string.
     * @readonly
     */
    get httpVersionMajor(): number {
        return this.req.httpVersionMajor
    }

    /**
     * Second integer in the httpVersion string.
     * @readonly
     */
    get httpVersionMinor(): number {
        return this.req.httpVersionMinor
    }

    /**
     * Request method of the incoming request.
     * @readonly
     */
    get method(): string | undefined {
        return this.req.method
    }

    /**
     * Whether this stream is readable.
     * @readonly
     */
    get readable(): boolean {
        return this.req.readable
    }

    /**
     * net.Socket object associated with the connection.
     * @readonly
     */
    get socket(): http.IncomingMessage["socket"] {
        return this.req.socket
    }

    /**
     * The HTTP status code, generally assigned before sending headers.
     */
    get statusCode(): number {
        return this.res.statusCode
    }

    set statusCode(val: number) {
        this.res.statusCode = val
    }

    /**
     * The status message sent to the client, as long as writeHead() isn't called explicitly.
     */
    get statusMessage(): string {
        return this.res.statusMessage
    }

    set statusMessage(val: string) {
        this.res.statusMessage = val
    }

    /**
     * Request/response trailer headers. Only populated at the 'end' event.
     * @readonly
     */
    get trailers(): NodeJS.Dict<string> {
        return this.req.trailers
    }

    /**
     * Request URL string.
     * @readonly
     */
    get url(): string | undefined {
        return this.req.url
    }

    get writable(): boolean {
        return this.res.writable
    }

    /**
     * Sends a response header to the client. Must be called only once and before end().
     */
    writeHead(statusCode: number, statusMessage?: string, headers?: http.OutgoingHttpHeaders): this {
        this.res.writeHead(statusCode, statusMessage, headers)
        return this
    }

    /**
     * Buffers written data in memory, flushed when uncork() or end() is called.
     */
    cork(): this {
        this.res.socket?.cork()
        return this
    }

    /**
     * Flushes all data buffered since cork() was called.
     */
    uncork(): this {
        this.res.socket?.uncork()
        return this
    }
}

// proxy request methods
for (const name of ["pause", "resume", "setEncoding"] as const) {
    ;(HttpDuplex.prototype as any)[name] = function (this: HttpDuplex, ...args: unknown[]) {
        return (this.req as any)[name](...args)
    }
}

// proxy response methods
for (const name of [
    "setDefaultEncoding",
    "write",
    "end",
    "flush",
    "writeHeader",
    "writeContinue",
    "setHeader",
    "getHeader",
    "removeHeader",
    "addTrailers",
] as const) {
    ;(HttpDuplex.prototype as any)[name] = function (this: HttpDuplex, ...args: unknown[]) {
        return (this.res as any)[name](...args)
    }
}

/**
 * Destroys the object and its bound streams.
 */
HttpDuplex.prototype.destroy = function (this: HttpDuplex): void {
    this.req.destroy()
    this.res.destroy()
}
