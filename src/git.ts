import fs from "node:fs"
import path from "node:path"
import http, { type ServerOptions } from "node:http"
import https from "node:https"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"

import { HttpDuplex } from "./http-duplex.js"
import { parseGitName, createAction, infoResponse, basicAuth, noCache } from "./util.js"
import type { ServiceString } from "./types.js"

const services: ServiceString[] = ["upload-pack", "receive-pack"]

interface GitServerOptions extends ServerOptions {
    type: "http" | "https"
}

/**
 * Resolves a repo slug to an on-disk directory. May be synchronous or return a
 * `Promise`, which allows the directory to be looked up asynchronously (e.g. from
 * a database) before git is invoked.
 */
export type RepoDirResolver = (dir?: string) => string | Promise<string>

/**
 * The `next` callback handed to `authenticate`. Call it with no argument to allow
 * the request, or with an `Error` to reject it. It may be awaited.
 */
export type AuthenticateCallback = (error?: Error) => void | Promise<void>

export interface GitOptions {
    autoCreate?: boolean
    authenticate?: (
        options: GitAuthenticateOptions,
        callback: AuthenticateCallback
    ) => void | Promise<Error | undefined | void> | undefined
    checkout?: boolean
}

export interface GitAuthenticateOptions {
    type: string
    repo: string
    user: (() => Promise<[string | undefined, string | undefined]>) &
        ((callback: (username?: string | undefined, password?: string | undefined) => void) => void)
    headers: http.IncomingHttpHeaders
}

/**
 * An http duplex object (see below) with these extra properties:
 */
export interface TagData extends HttpDuplex {
    repo: string // The string that defines the repo
    commit: string // The string that defines the commit sha
    version: string // The string that defines the tag being pushed
}

/**
 * Is a http duplex object (see below) with these extra properties
 */
export interface PushData extends HttpDuplex {
    repo: string // The string that defines the repo
    commit: string // The string that defines the commit sha
    branch: string // The string that defines the branch
}

/**
 * an http duplex object (see below) with these extra properties
 */
export interface FetchData extends HttpDuplex {
    repo: string // The string that defines the repo
    commit: string //  The string that defines the commit sha
}

/**
 * an http duplex object (see below) with these extra properties
 */
export interface InfoData extends HttpDuplex {
    repo: string // The string that defines the repo
}

/**
 * an http duplex object (see below) with these extra properties
 */
export interface HeadData extends HttpDuplex {
    repo: string // The string that defines the repo
}

export interface GitEvents {
    /**
     * @example
     * repos.on('push', function (push) { ... }
     *
     * Emitted when somebody does a `git push` to the repo.
     *
     * Exactly one listener must call `push.accept()` or `push.reject()`. If there are
     * no listeners, `push.accept()` is called automatically.
     **/
    on(event: "push", listener: (push: PushData) => void): this

    /**
     * @example
     * repos.on('tag', function (tag) { ... }
     *
     * Emitted when somebody does a `git push --tags` to the repo.
     * Exactly one listener must call `tag.accept()` or `tag.reject()`. If there are
     * No listeners, `tag.accept()` is called automatically.
     **/
    on(event: "tag", listener: (tag: TagData) => void): this

    /**
     * @example
     * repos.on('fetch', function (fetch) { ... }
     *
     * Emitted when somebody does a `git fetch` to the repo (which happens whenever you
     * do a `git pull` or a `git clone`).
     *
     * Exactly one listener must call `fetch.accept()` or `fetch.reject()`. If there are
     * no listeners, `fetch.accept()` is called automatically.
     **/
    on(event: "fetch", listener: (fetch: FetchData) => void): this

    /**
     * @example
     * repos.on('info', function (info) { ... }
     *
     * Emitted when the repo is queried for info before doing other commands.
     *
     * Exactly one listener must call `info.accept()` or `info.reject()`. If there are
     * no listeners, `info.accept()` is called automatically.
     **/
    on(event: "info", listener: (info: InfoData) => void): this

    /**
     * @example
     * repos.on('head', function (head) { ... }
     *
     * Emitted when the repo is queried for HEAD before doing other commands.
     *
     * Exactly one listener must call `head.accept()` or `head.reject()`. If there are
     * no listeners, `head.accept()` is called automatically.
     *
     **/
    on(event: "head", listener: (head: HeadData) => void): this
}

export class Git extends EventEmitter implements GitEvents {
    dirMap: RepoDirResolver

    authenticate:
        | ((
              options: GitAuthenticateOptions,
              callback: AuthenticateCallback
          ) => void | Promise<Error | undefined | void> | undefined)
        | undefined

    autoCreate: boolean
    checkout: boolean | undefined
    server: https.Server | http.Server | undefined

    /**
     * Handles invoking the git-*-pack binaries
     * @param repoDir - Create a new repository collection from the directory `repoDir`. `repoDir` should be entirely empty except for git repo directories. If `repoDir` is a function, `repoDir(repo)` will be used to dynamically resolve project directories. The return value of `repoDir(repo)` should be a string path specifying where to put the string `repo`. Make sure to return the same value for `repo` every time since `repoDir(repo)` will be called multiple times.
     * @param options - options that can be applied on the new instance being created
     * @param options.autoCreate - By default, repository targets will be created if they don't exist. You can disable that behavior with `options.autoCreate = false`
     * @param options.authenticate - a function that has the following arguments ({ type, repo, user, headers }, next) and will be called when a request comes through if set
     * @param options.checkout - If `opts.checkout` is true, create and expect checked-out repos instead of bare repos
     */
    constructor(repoDir: string | RepoDirResolver, options: GitOptions = {}) {
        super()

        if (typeof repoDir === "function") {
            this.dirMap = repoDir
        } else {
            this.dirMap = (dir?: string): string => path.normalize(dir ? path.join(repoDir, dir) : repoDir)
        }

        if (options.authenticate) {
            this.authenticate = options.authenticate
        }

        this.autoCreate = options.autoCreate !== false
        this.checkout = options.checkout
    }

    /**
     * Get a list of all the repositories
     * @param callback function to be called when repositories have been found `function(error, repos)`
     */
    async list(callback: (error: Error | undefined, repos?: string[]) => void): Promise<void>
    async list(): Promise<string[]>
    async list(callback?: (error: Error | undefined, repos?: string[]) => void): Promise<string[] | void> {
        const dir = await this.dirMap()
        const execf = (res: (repos: string[]) => void, rej: (err: Error) => void) =>
            fs.readdir(dir, (error, results) => {
                if (error) return rej(error)
                res(results.filter((r) => r.endsWith(".git")))
            })

        if (callback) {
            return execf(
                (repos) => callback(undefined, repos),
                (err) => callback(err, undefined)
            )
        }
        return new Promise<string[]>((res, rej) => execf(res, rej))
    }

    /**
     * Find out whether `repo` exists on disk. Resolves the (possibly async) repo
     * directory before checking, so this returns a `Promise<boolean>`.
     * @param repo - name of the repo
     */
    async exists(repo: string): Promise<boolean> {
        try {
            await fs.promises.access(await this.dirMap(repo))
            return true
        } catch {
            return false
        }
    }

    /**
     * Create a subdirectory `dir` in the repo dir.
     * @param dir - directory name
     */
    mkdir(dir: string): void {
        fs.mkdirSync(path.dirname(dir), { recursive: true })
    }

    /**
     * Create a new bare repository `repoName` in the instance repository directory.
     * @param repo - the name of the repo
     * @param callback - Optionally get a callback `cb(err)` to be notified when the repository was created.
     */
    async create(repo: string, callback: (error?: Error) => void): Promise<void> {
        if (typeof callback !== "function") {
            callback = () => {
                return
            }
        }

        if (!/\.git$/.test(repo)) repo += ".git"

        // `git init` creates the target directory (and any parent dirs) itself.
        const dir = await this.dirMap(repo)
        const ps = this.checkout ? spawn("git", ["init", dir]) : spawn("git", ["init", "--bare", dir])

        let error = ""
        ps.stderr.on("data", (chunk: Buffer) => {
            error += chunk
        })

        // Guard against both `error` (e.g. git not installed) and `exit` firing.
        let settled = false
        const finish = (err?: Error) => {
            if (settled) return
            settled = true
            callback(err)
        }
        ps.on("error", finish)
        ps.on("exit", (code) => finish(code ? new Error(error) : undefined))
    }

    /**
     * Returns the type of service being processed: either `fetch` or `push`.
     * @param service - the service type
     */
    getType(service: string): string {
        switch (service) {
            case "upload-pack":
                return "fetch"
            case "receive-pack":
                return "push"
            default:
                return "unknown"
        }
    }

    /**
     * Handle incoming HTTP requests with a connect-style middleware
     * @param req - http request object
     * @param res - http response object
     */
    handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        const handlers: Array<
            (req: http.IncomingMessage, res: http.ServerResponse) => boolean | void | Promise<boolean | void>
        > = [
            // GET /:repo/info/refs
            (req, res) => {
                if (req.method !== "GET") return false

                const u = new URL(req.url ?? "", "http://localhost")
                const m = u.pathname.match(/\/(.+)\/info\/refs$/)
                if (!m) return false
                if (/\.\./.test(m[1])) return false

                const repo = m[1]
                const requestedService = u.searchParams.get("service")
                if (!requestedService) {
                    res.statusCode = 400
                    res.end("service parameter required")
                    return
                }

                const service = requestedService.replace(/^git-/, "")

                if (!services.includes(service as ServiceString)) {
                    res.statusCode = 405
                    res.end("service not available")
                    return
                }

                const repoName = parseGitName(m[1])
                const next = (error?: Error | void) => {
                    if (error) {
                        res.setHeader("Content-Type", "text/plain")
                        res.setHeader("WWW-Authenticate", 'Basic realm="authorization needed"')
                        res.writeHead(401)
                        res.end(typeof error === "string" ? error : error.toString())
                        return
                    }
                    return infoResponse(this, repo, service as ServiceString, req, res)
                }

                // check if the repo is authenticated
                if (this.authenticate) {
                    const type = this.getType(service)
                    const headers = req.headers
                    const user = (callback?: (username?: string, password?: string) => void) =>
                        callback
                            ? basicAuth(req, res, callback)
                            : new Promise<[string | undefined, string | undefined]>((resolve) =>
                                  basicAuth(req, res, (u, p) => resolve([u, p]))
                              )

                    const promise = this.authenticate(
                        {
                            type,
                            repo: repoName,
                            user: user as unknown as GitAuthenticateOptions["user"],
                            headers,
                        },
                        (error?: Error) => next(error)
                    )

                    if (promise instanceof Promise) {
                        return void promise.then(next).catch(next)
                    }
                    return
                }

                return next()
            },
            // GET /:repo/HEAD
            async (req, res) => {
                if (req.method !== "GET") return false

                const u = new URL(req.url ?? "", "http://localhost")
                const m = u.pathname.match(/^\/(.+)\/HEAD$/)
                if (!m) return false
                if (/\.\./.test(m[1])) return false

                const repo = m[1]

                const next = async () => {
                    const file = await this.dirMap(path.join(repo, "HEAD"))
                    try {
                        // `file` is already a resolved path, so check it directly.
                        await fs.promises.access(file)
                        fs.createReadStream(file).pipe(res)
                    } catch {
                        res.statusCode = 404
                        res.end("not found")
                    }
                }

                const exists = await this.exists(repo)
                const anyListeners = this.listeners("head").length > 0
                const dup = new HttpDuplex(req, res)
                dup.exists = exists
                dup.repo = repo
                dup.cwd = await this.dirMap(repo)

                dup.accept = dup.emit.bind(dup, "accept")
                dup.reject = dup.emit.bind(dup, "reject")

                dup.once("reject", (code: number) => {
                    dup.statusCode = code || 500
                    dup.end()
                })

                if (!exists && this.autoCreate) {
                    dup.once("accept", (dir: string) => {
                        this.create(dir || repo, next)
                    })
                    this.emit("head", dup)
                    if (!anyListeners) dup.accept()
                } else if (!exists) {
                    res.statusCode = 404
                    res.setHeader("content-type", "text/plain")
                    res.end("repository not found")
                } else {
                    dup.once("accept", next)
                    this.emit("head", dup)
                    if (!anyListeners) dup.accept()
                }
            },
            // POST /:repo/git-:service
            async (req, res) => {
                if (req.method !== "POST") return false
                const m = req.url?.match(/\/(.+)\/git-(.+)/)
                if (!m) return false
                if (/\.\./.test(m[1])) return false

                const repo = m[1]
                const service = m[2]

                if (!services.includes(service as ServiceString)) {
                    res.statusCode = 405
                    res.end("service not available")
                    return
                }

                res.setHeader("content-type", "application/x-git-" + service + "-result")
                noCache(res)

                const action = createAction(
                    {
                        repo,
                        service: service as ServiceString,
                        cwd: await this.dirMap(repo),
                    },
                    req,
                    res
                )

                action.on("header", () => {
                    const evName = action.evName
                    if (evName) {
                        const anyListeners = this.listeners(evName).length > 0
                        this.emit(evName, action)
                        if (!anyListeners) action.accept()
                    }
                })
            },
            // reject unsupported methods
            (req, res) => {
                if (req.method !== "GET" && req.method !== "POST") {
                    res.statusCode = 405
                    res.end("method not supported")
                } else {
                    return false
                }
            },
            // fall-through 404
            (_req, res) => {
                res.statusCode = 404
                res.end("not found")
            },
        ]

        res.setHeader("connection", "close")

        const runNext = async (ix: number): Promise<void> => {
            const result = await handlers[ix](req, res)
            if (result === false) await runNext(ix + 1)
        }
        void runNext(0)
    }

    /**
     * Starts a git server on the given port.
     * @param port - the port to start the server on
     * @param options - the options to add extended functionality to the server
     * @param options.type - this is either https or http (the default is http)
     * @param options.key - private key in PEM format for the https server
     * @param options.cert - cert chains in PEM format for the https server
     * @param callback - the function to call when server is started or error has occurred
     */
    listen(port: number, options?: GitServerOptions | null, callback?: () => void): this {
        const opts: GitServerOptions = options ?? { type: "http" }

        this.server =
            opts.type === "http"
                ? http.createServer((req, res) => this.handle(req, res))
                : https.createServer(opts, (req, res) => this.handle(req, res))

        this.server.listen(port, callback)

        return this
    }

    /**
     * Closes the server instance.
     * @returns a promise that resolves or rejects when the server closes or fails to close.
     */
    close(): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            this.server?.close((err) => {
                if (err) {
                    reject(err)
                } else {
                    resolve("Success")
                }
            })
        })
    }
}
