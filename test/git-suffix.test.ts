import fs from "node:fs"
import path from "node:path"
import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process"
import { describe, expect, test } from "vitest"

import { Git } from "../src/git.js"

/** Runs a command to completion and resolves with its exit code. */
function run(cmd: string, args: string[], opts: SpawnOptionsWithoutStdio = {}): Promise<number> {
    return new Promise((resolve) => {
        spawn(cmd, args, {
            ...opts,
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

/** A source repo with a single commit on `main`, ready to be pushed. */
async function seedSource(): Promise<string> {
    const src = tmpDir()
    await run("git", ["init"], { cwd: src })
    fs.writeFileSync(path.join(src, "a.txt"), "abcd")
    await run("git", ["add", "a.txt"], { cwd: src })
    await run("git", ["commit", "-m", "a"], { cwd: src })
    return src
}

describe(".git suffix handling", () => {
    test("serves an existing `.git` repo over a suffix-less url", async () => {
        const base = tmpDir()
        const src = await seedSource()
        const dst = tmpDir()

        expect(await run("git", ["init", "--bare", path.join(base, "doom.git")])).toBe(0)

        // autoCreate is off, so the request only succeeds if `doom` resolves to `doom.git`
        const repos = new Git(base, { autoCreate: false })
        const port = randomPort()
        repos.listen(port)

        const seen: string[] = []
        repos.on("push", (push) => {
            seen.push(push.repo)
            push.accept()
        })
        repos.on("fetch", (fetch) => {
            seen.push(fetch.repo)
            fetch.accept()
        })

        expect(await repos.exists("doom")).toBe(true)
        expect(await run("git", ["push", `http://localhost:${port}/doom`, "main"], { cwd: src })).toBe(0)
        expect(await run("git", ["clone", `http://localhost:${port}/doom`], { cwd: dst })).toBe(0)
        expect(fs.existsSync(path.join(dst, "doom", "a.txt"))).toBe(true)

        // events report the on-disk name, whichever url form was used
        expect(seen).toEqual(["doom.git", "doom.git"])

        await repos.close()
    })

    test("serves a repo that exists on disk without a `.git` suffix", async () => {
        const base = tmpDir()
        const src = await seedSource()
        const dst = tmpDir()

        expect(await run("git", ["init", "--bare", path.join(base, "plain")])).toBe(0)

        const repos = new Git(base, { autoCreate: false })
        const port = randomPort()
        repos.listen(port)

        const seen: string[] = []
        repos.on("push", (push) => {
            seen.push(push.repo)
            push.accept()
        })

        expect(await repos.exists("plain")).toBe(true)
        expect(await run("git", ["push", `http://localhost:${port}/plain`, "main"], { cwd: src })).toBe(0)
        expect(await run("git", ["clone", `http://localhost:${port}/plain`], { cwd: dst })).toBe(0)
        expect(fs.existsSync(path.join(dst, "plain", "a.txt"))).toBe(true)
        expect(seen).toEqual(["plain"])
        // no second directory was conjured up for the same repo
        expect(fs.readdirSync(base)).toEqual(["plain"])

        await repos.close()
    })

    test("auto-creates a single repo for a suffix-less url", async () => {
        const base = tmpDir()
        const src = await seedSource()
        const dst = tmpDir()

        const repos = new Git(base, { autoCreate: true })
        const port = randomPort()
        repos.listen(port)

        expect(await run("git", ["push", `http://localhost:${port}/doom`, "main"], { cwd: src })).toBe(0)
        expect(fs.readdirSync(base)).toEqual(["doom.git"])

        // the same repo is now reachable under either url form
        expect(await run("git", ["clone", `http://localhost:${port}/doom.git`, "a"], { cwd: dst })).toBe(0)
        expect(await run("git", ["clone", `http://localhost:${port}/doom`, "b"], { cwd: dst })).toBe(0)
        expect(fs.existsSync(path.join(dst, "a", "a.txt"))).toBe(true)
        expect(fs.existsSync(path.join(dst, "b", "a.txt"))).toBe(true)
        expect(fs.readdirSync(base)).toEqual(["doom.git"])

        await repos.close()
    })

    test("serves HEAD for both url forms", async () => {
        const base = tmpDir()
        expect(await run("git", ["init", "--bare", path.join(base, "doom.git")])).toBe(0)

        const repos = new Git(base, { autoCreate: false })
        const port = randomPort()
        repos.listen(port)

        for (const name of ["doom", "doom.git"]) {
            const res = await fetch(`http://localhost:${port}/${name}/HEAD`)
            expect(res.status).toBe(200)
            expect(await res.text()).toContain("ref: refs/heads/")
        }

        await repos.close()
    })

    test("lists repos regardless of their suffix and skips everything else", async () => {
        const base = tmpDir()
        expect(await run("git", ["init", "--bare", path.join(base, "doom.git")])).toBe(0)
        expect(await run("git", ["init", "--bare", path.join(base, "plain")])).toBe(0)
        fs.mkdirSync(path.join(base, "not-a-repo"))
        fs.writeFileSync(path.join(base, "stray.git"), "not a directory")

        const repos = new Git(base)
        expect((await repos.list()).sort()).toEqual(["doom.git", "plain"])
    })

    test("creates checked-out repos without a `.git` suffix", async () => {
        const base = tmpDir()
        const repos = new Git(base, { checkout: true })

        await new Promise<void>((resolve, reject) => {
            repos.create("doom.git", (error) => (error ? reject(error) : resolve()))
        })

        expect(fs.readdirSync(base)).toEqual(["doom"])
        expect(fs.existsSync(path.join(base, "doom", ".git"))).toBe(true)
        expect(await repos.exists("doom.git")).toBe(true)
        expect(await repos.list()).toEqual(["doom"])
    })

    describe("enforceGitSuffix", () => {
        test("redirects suffix-less urls to the canonical one", async () => {
            const base = tmpDir()
            const src = await seedSource()
            const dst = tmpDir()

            const repos = new Git(base, { autoCreate: true, enforceGitSuffix: true })
            const port = randomPort()
            repos.listen(port)

            const res = await fetch(`http://localhost:${port}/doom/info/refs?service=git-upload-pack`, {
                redirect: "manual",
            })
            expect(res.status).toBe(301)
            expect(res.headers.get("location")).toBe("/doom.git/info/refs?service=git-upload-pack")

            // git follows the redirect on the initial request, so clients still work
            expect(await run("git", ["push", `http://localhost:${port}/doom`, "main"], { cwd: src })).toBe(0)
            expect(fs.readdirSync(base)).toEqual(["doom.git"])
            expect(await run("git", ["clone", `http://localhost:${port}/doom`], { cwd: dst })).toBe(0)
            expect(fs.existsSync(path.join(dst, "doom", "a.txt"))).toBe(true)

            await repos.close()
        })

        test("ignores repos on disk that lack the suffix", async () => {
            const base = tmpDir()
            expect(await run("git", ["init", "--bare", path.join(base, "doom.git")])).toBe(0)
            expect(await run("git", ["init", "--bare", path.join(base, "plain")])).toBe(0)

            const repos = new Git(base, { autoCreate: false, enforceGitSuffix: true })
            const port = randomPort()
            repos.listen(port)

            expect(await repos.list()).toEqual(["doom.git"])
            expect(await repos.exists("plain")).toBe(false)

            const res = await fetch(`http://localhost:${port}/plain.git/info/refs?service=git-upload-pack`)
            expect(res.status).toBe(404)

            await repos.close()
        })
    })
})
