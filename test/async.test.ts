import fs from "node:fs"
import path from "node:path"
import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import { describe, expect, test } from "vitest"

import { Git } from "../src/git.js"

/** Runs a command to completion and resolves with its exit code. */
function run(cmd: string, args: string[], opts: SpawnOptionsWithoutStdio = {}): Promise<number> {
    return new Promise((resolve) => {
        spawn(cmd, args, {
            ...opts,
            // never block on an interactive credential prompt during tests
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
        }).on("exit", (code) => resolve(code ?? -1))
    })
}

function tmpDir(): string {
    const dir = `/tmp/${Math.floor(Math.random() * (1 << 30)).toString(16)}`
    fs.mkdirSync(dir, "0700")
    return dir
}

function randomPort(): number {
    return Math.floor(Math.random() * ((1 << 16) - 1e4)) + 1e4
}

describe("async interface", () => {
    test("supports an async repoDir resolver", async () => {
        const base = tmpDir()
        const src = tmpDir()
        const dst = tmpDir()

        // resolver returns a Promise — the directory is resolved asynchronously
        // (as scienhub does when it looks the path up from a database).
        const repos = new Git(
            async (dir?: string) => {
                await delay(5)
                return path.normalize(dir ? path.join(base, dir) : base)
            },
            { autoCreate: true }
        )
        const port = randomPort()
        repos.listen(port)

        expect(await run("git", ["init"], { cwd: src })).toBe(0)
        fs.writeFileSync(path.join(src, "a.txt"), "abcd")
        expect(await run("git", ["add", "a.txt"], { cwd: src })).toBe(0)
        expect(await run("git", ["commit", "-m", "a"], { cwd: src })).toBe(0)
        expect(await run("git", ["push", `http://localhost:${port}/doom`, "main"], { cwd: src })).toBe(0)
        expect(await run("git", ["clone", `http://localhost:${port}/doom`], { cwd: dst })).toBe(0)
        expect(fs.existsSync(path.join(dst, "doom", "a.txt"))).toBe(true)

        await repos.close()
    })

    test("supports async db-style authentication", async () => {
        const base = tmpDir()
        const okDst = tmpDir()
        const denyDst = tmpDir()

        // seed a bare repo up front; autoCreate is off, mirroring scienhub.
        expect(await run("git", ["init", "--bare", path.join(base, "doom.git")], {})).toBe(0)

        // pretend this is a user table queried asynchronously per request.
        const users = new Map([["root", "s3cret"]])

        const repos = new Git(async (dir?: string) => path.normalize(dir ? path.join(base, dir) : base), {
            autoCreate: false,
            authenticate: ({ user }, next) => {
                user(async (username, password) => {
                    await delay(5) // simulate an async DB lookup
                    if (username && users.get(username) === password) {
                        await next()
                    } else {
                        await next(new Error("access denied"))
                    }
                })
            },
        })
        const port = randomPort()
        repos.listen(port)

        // correct credentials -> clone (fetch) succeeds
        expect(await run("git", ["clone", `http://root:s3cret@localhost:${port}/doom.git`], { cwd: okDst })).toBe(0)

        // wrong credentials -> clone fails
        expect(await run("git", ["clone", `http://root:wrong@localhost:${port}/doom.git`], { cwd: denyDst })).not.toBe(
            0
        )

        await repos.close()
    })
})
