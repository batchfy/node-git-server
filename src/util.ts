import { spawn } from "node:child_process"
import type * as http from "node:http"

import type { Git } from "./git.js"
import { HttpDuplex } from "./http-duplex.js"
import { Service, type ServiceOptions } from "./service.js"
import type { ServiceString } from "./types.js"

/**
 * Wraps a payload in a git pkt-line, prefixing it with its 4-byte hex length.
 */
export function packSideband(s: string): string {
    const n = (4 + s.length).toString(16)
    return n.padStart(4, "0") + s
}

/**
 * Adds headers to the response object to disable caching.
 * @param res - http response
 */
export function noCache(res: http.ServerResponse): void {
    res.setHeader("expires", "Fri, 01 Jan 1980 00:00:00 GMT")
    res.setHeader("pragma", "no-cache")
    res.setHeader("cache-control", "no-cache, max-age=0, must-revalidate")
}

/**
 * Sets and parses basic auth headers if they exist.
 * @param req - http request object
 * @param res - http response
 * @param callback - function(username, password)
 */
export function basicAuth(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    callback: (username?: string, password?: string) => void
): void {
    const authorization = req.headers["authorization"]

    if (!authorization) {
        res.setHeader("Content-Type", "text/plain")
        res.setHeader("WWW-Authenticate", 'Basic realm="authorization needed"')
        res.writeHead(401)
        res.end("401 Unauthorized")
        return
    }

    const [scheme, token] = authorization.split(" ")
    if (scheme === "Basic" && token) {
        const [username, ...rest] = Buffer.from(token, "base64").toString("utf8").split(":")
        callback(username, rest.join(":"))
    }
}

/**
 * Executes the given git operation and streams the advertisement to the client.
 * @param dup - duplex object to catch errors
 * @param service - the method that is responding (upload-pack, receive-pack)
 * @param repoLocation - the repo path on disk
 * @param res - http response
 */
export function serviceRespond(
    dup: HttpDuplex | Git,
    service: ServiceString,
    repoLocation: string,
    res: http.ServerResponse
): void {
    res.write(packSideband("# service=git-" + service + "\n"))
    res.write("0000")

    const isWin = process.platform === "win32"

    const cmd = isWin
        ? ["git", service, "--stateless-rpc", "--advertise-refs", repoLocation]
        : ["git-" + service, "--stateless-rpc", "--advertise-refs", repoLocation]

    const ps = spawn(cmd[0], cmd.slice(1))

    ps.on("error", (err) => {
        dup.emit("error", new Error(`${err.message} running command ${cmd.join(" ")}`))
    })
    ps.stdout.pipe(res)
}

/**
 * Sends the git info/refs response using the appropriate output from the service call.
 * @param git - an instance of the Git object
 * @param repo - the repository
 * @param service - the method that is responding (upload-pack, receive-pack)
 * @param req - http request object
 * @param res - http response
 */
export async function infoResponse(
    git: Git,
    repo: string,
    service: ServiceString,
    req: http.IncomingMessage,
    res: http.ServerResponse
): Promise<void> {
    const next = async (): Promise<void> => {
        res.setHeader("content-type", "application/x-git-" + service + "-advertisement")
        noCache(res)
        serviceRespond(git, service, await git.dirMap(repo), res)
    }

    const dup = new HttpDuplex(req, res)
    dup.cwd = await git.dirMap(repo)
    dup.repo = repo

    dup.accept = dup.emit.bind(dup, "accept")
    dup.reject = dup.emit.bind(dup, "reject")

    dup.once("reject", (code: number) => {
        res.statusCode = code || 500
        res.end()
    })

    const anyListeners = git.listeners("info").length > 0

    const exists = await git.exists(repo)
    dup.exists = exists

    if (!exists && git.autoCreate) {
        dup.once("accept", () => {
            git.create(repo, next)
        })

        git.emit("info", dup)
        if (!anyListeners) dup.accept()
    } else if (!exists) {
        res.statusCode = 404
        res.setHeader("content-type", "text/plain")
        res.end("repository not found")
    } else {
        dup.once("accept", next)
        git.emit("info", dup)

        if (!anyListeners) dup.accept()
    }
}

/**
 * Parses a git string and returns the repo name (strips a trailing `.git`).
 * @param repo - the raw repo name possibly containing `.git`
 */
export function parseGitName(repo: string): string {
    const locationOfGit = repo.lastIndexOf(".git")
    return repo.slice(0, locationOfGit > 0 ? locationOfGit : repo.length)
}

/**
 * Responds with the correct service depending on the action.
 * @param opts - options to pass Service
 * @param req - http request object
 * @param res - http response
 */
export function createAction(opts: ServiceOptions, req: http.IncomingMessage, res: http.ServerResponse): Service {
    return new Service(opts, req, res)
}
