import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { AddressInfo } from "node:net"

import { Git, type GitOptions, type ReceiveData } from "../src/git.js"

const execFileAsync = promisify(execFile)
const ZERO = "0000000000000000000000000000000000000000"

/** Runs git in `cwd`, returning trimmed stdout; rejects on a non-zero exit. */
async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd })
    return stdout.trim()
}

/** Runs git in `cwd` and resolves with its exit code instead of rejecting. */
async function gitCode(cwd: string, ...args: string[]): Promise<number> {
    try {
        await execFileAsync("git", args, { cwd })
        return 0
    } catch (error) {
        return (error as { code: number }).code
    }
}

/** A promise plus its resolver, for waiting on a callback without sleeping. */
function deferred<T = void>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((r) => (resolve = r))
    return { promise, resolve }
}

interface Fixture {
    repos: Git
    url: string
    bareDir: string
    srcDir: string
    calls: ReceiveData[]
    /** Records a call and wakes `nextCall` — what the default `postReceive` does; custom ones call it too. */
    record: (data: ReceiveData) => void
    /** Resolves with the next `postReceive` call (or the one already recorded at that index). */
    nextCall: () => Promise<ReceiveData>
    commit: (file: string, content: string) => Promise<string>
    close: () => Promise<void>
}

/**
 * A server with one bare repo "doom" and a local clone source dir. `postReceive` defaults to
 * recording each call; pass `options` to override it.
 */
async function setup(options: GitOptions = {}): Promise<Fixture> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ngs-post-receive-"))
    const repoDir = path.join(root, "repos")
    const srcDir = path.join(root, "src")
    fs.mkdirSync(repoDir)
    fs.mkdirSync(srcDir)

    const calls: ReceiveData[] = []
    const waiters: Array<{ index: number; resolve: (d: ReceiveData) => void }> = []
    const record = (data: ReceiveData) => {
        calls.push(data)
        for (const w of waiters.filter((w) => w.index < calls.length)) w.resolve(calls[w.index])
    }
    let consumed = 0
    const nextCall = () => {
        const index = consumed++
        if (index < calls.length) return Promise.resolve(calls[index])
        return new Promise<ReceiveData>((resolve) => waiters.push({ index, resolve }))
    }

    const repos = new Git(repoDir, { postReceive: record, ...options })
    await new Promise<void>((resolve, reject) => repos.create("doom", (err) => (err ? reject(err) : resolve())))

    const server = http.createServer((req, res) => repos.handle(req, res))
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const url = `http://localhost:${(server.address() as AddressInfo).port}/doom`

    await git(srcDir, "init")
    const commit = async (file: string, content: string) => {
        fs.writeFileSync(path.join(srcDir, file), content)
        await git(srcDir, "add", file)
        await git(srcDir, "commit", "-m", `write ${file}`)
        return git(srcDir, "rev-parse", "HEAD")
    }

    return {
        repos,
        url,
        bareDir: path.join(repoDir, "doom.git"),
        srcDir,
        calls,
        record,
        nextCall,
        commit,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
}

describe("postReceive", () => {
    let fx: Fixture | undefined

    afterEach(async () => {
        await fx?.close()
        fx = undefined
    })

    test("a first push to a branch: called once with the created ref, after the bare repo already has it", async () => {
        let refAtCallTime: string | undefined
        const f = (fx = await setup({
            postReceive: async (data) => {
                refAtCallTime = await git(f.bareDir, "rev-parse", "refs/heads/main")
                f.record(data)
            },
        }))
        const sha = await f.commit("a.txt", "a")

        expect(await gitCode(f.srcDir, "push", f.url, "main")).toBe(0)
        await vi.waitFor(() => expect(f.calls).toHaveLength(1))

        expect(f.calls[0]).toEqual({ repo: "doom", updates: [{ ref: "refs/heads/main", last: ZERO, commit: sha }] })
        expect(refAtCallTime).toBe(sha)
    })

    test("a fast-forward push reports the previous sha as `last`", async () => {
        const f = (fx = await setup())
        const first = await f.commit("a.txt", "a")
        await git(f.srcDir, "push", f.url, "main")
        await f.nextCall()

        const second = await f.commit("b.txt", "b")
        await git(f.srcDir, "push", f.url, "main")

        expect(await f.nextCall()).toEqual({
            repo: "doom",
            updates: [{ ref: "refs/heads/main", last: first, commit: second }],
        })
        expect(f.calls).toHaveLength(2)
    })

    test("pushing two branches in one request calls it once, with both updates", async () => {
        const f = (fx = await setup())
        const mainSha = await f.commit("a.txt", "a")
        await git(f.srcDir, "checkout", "-b", "dev")
        const devSha = await f.commit("b.txt", "b")

        await git(f.srcDir, "push", f.url, "main", "dev")
        const call = await f.nextCall()

        expect(call.repo).toBe("doom")
        expect([...call.updates].sort((a, b) => a.ref.localeCompare(b.ref))).toEqual([
            { ref: "refs/heads/dev", last: ZERO, commit: devSha },
            { ref: "refs/heads/main", last: ZERO, commit: mainSha },
        ])
        expect(f.calls).toHaveLength(1)
    })

    test("a tag push is reported under refs/tags", async () => {
        const f = (fx = await setup())
        const sha = await f.commit("a.txt", "a")
        await git(f.srcDir, "push", f.url, "main")
        await f.nextCall()

        await git(f.srcDir, "tag", "v1")
        await git(f.srcDir, "push", f.url, "v1")

        expect(await f.nextCall()).toEqual({
            repo: "doom",
            updates: [{ ref: "refs/tags/v1", last: ZERO, commit: sha }],
        })
    })

    test("deleting a branch is reported with an all-zero `commit`", async () => {
        const f = (fx = await setup())
        await f.commit("a.txt", "a")
        await git(f.srcDir, "checkout", "-b", "dev")
        const devSha = await f.commit("b.txt", "b")
        await git(f.srcDir, "push", f.url, "main", "dev")
        await f.nextCall()

        await git(f.srcDir, "push", f.url, ":dev")

        expect(await f.nextCall()).toEqual({
            repo: "doom",
            updates: [{ ref: "refs/heads/dev", last: devSha, commit: ZERO }],
        })
        expect(await gitCode(f.bareDir, "rev-parse", "--verify", "refs/heads/dev")).not.toBe(0)
    })

    test("a push the `push` listener rejects never reaches it", async () => {
        const f = (fx = await setup())
        let rejectNext = true
        f.repos.on("push", (push) => {
            if (rejectNext) push.reject(403, "denied")
            else push.accept()
        })
        await f.commit("a.txt", "a")

        expect(await gitCode(f.srcDir, "push", f.url, "main")).not.toBe(0)

        // The next accepted push creates main (last = zeros), which proves the rejected one moved nothing,
        // and it must be the first and only call.
        rejectNext = false
        const sha = await f.commit("b.txt", "b")
        await git(f.srcDir, "push", f.url, "main")
        expect(await f.nextCall()).toEqual({
            repo: "doom",
            updates: [{ ref: "refs/heads/main", last: ZERO, commit: sha }],
        })
        expect(f.calls).toHaveLength(1)
    })

    test("a ref git declines (denyNonFastForwards) is left out; if nothing moved, it is not called", async () => {
        const f = (fx = await setup())
        await f.commit("a.txt", "a")
        await git(f.srcDir, "push", f.url, "main")
        await f.nextCall()
        await git(f.bareDir, "config", "receive.denyNonFastForwards", "true")

        // Rewrite main, then force-push it alongside a brand-new branch: git declines main, accepts dev.
        await git(f.srcDir, "commit", "--amend", "-m", "rewritten")
        await git(f.srcDir, "branch", "dev")
        const devSha = await git(f.srcDir, "rev-parse", "dev")
        expect(await gitCode(f.srcDir, "push", "--force", f.url, "main", "dev")).not.toBe(0)
        expect(await f.nextCall()).toEqual({
            repo: "doom",
            updates: [{ ref: "refs/heads/dev", last: ZERO, commit: devSha }],
        })

        // A force-push of main alone moves nothing at all — the next call must be the later, real push.
        expect(await gitCode(f.srcDir, "push", "--force", f.url, "main")).not.toBe(0)
        await git(f.srcDir, "checkout", "-b", "feature")
        const featureSha = await f.commit("c.txt", "c")
        await git(f.srcDir, "push", f.url, "feature")
        expect(await f.nextCall()).toEqual({
            repo: "doom",
            updates: [{ ref: "refs/heads/feature", last: ZERO, commit: featureSha }],
        })
        // first push of main, then dev, then feature — the declined main-only push added nothing
        expect(f.calls).toHaveLength(3)
    })

    test("a slow callback does not hold up the client's git push", async () => {
        const started = deferred()
        const release = deferred()
        let finished = false
        const f = (fx = await setup({
            postReceive: async () => {
                started.resolve()
                await release.promise
                finished = true
            },
        }))
        await f.commit("a.txt", "a")

        expect(await gitCode(f.srcDir, "push", f.url, "main")).toBe(0)
        await started.promise
        expect(finished).toBe(false)

        release.resolve()
        await vi.waitFor(() => expect(finished).toBe(true))
    })

    test("a rejecting callback only logs a warning; the push lands and the next push still calls it", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
        const boom = new Error("post-push work failed")
        let attempts = 0
        const f = (fx = await setup({
            postReceive: async (data) => {
                attempts++
                if (attempts === 1) throw boom
                f.record(data)
            },
        }))
        const first = await f.commit("a.txt", "a")

        expect(await gitCode(f.srcDir, "push", f.url, "main")).toBe(0)
        await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
        expect(warn.mock.calls[0][0]).toContain("doom")
        expect(warn.mock.calls[0][1]).toBe(boom)
        expect(await git(f.bareDir, "rev-parse", "refs/heads/main")).toBe(first)

        const second = await f.commit("b.txt", "b")
        expect(await gitCode(f.srcDir, "push", f.url, "main")).toBe(0)
        expect(await f.nextCall()).toEqual({
            repo: "doom",
            updates: [{ ref: "refs/heads/main", last: first, commit: second }],
        })
        expect(warn).toHaveBeenCalledTimes(1)
        warn.mockRestore()
    })

    test("a synchronously throwing callback only logs a warning, and the server keeps serving", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
        const boom = new Error("sync failure")
        const f = (fx = await setup({
            postReceive: () => {
                throw boom
            },
        }))
        const sha = await f.commit("a.txt", "a")

        expect(await gitCode(f.srcDir, "push", f.url, "main")).toBe(0)
        await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
        expect(warn.mock.calls[0][1]).toBe(boom)

        // The same server still answers a clone with the pushed commit.
        const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "ngs-clone-"))
        await git(cloneDir, "clone", f.url, "copy")
        expect(await git(path.join(cloneDir, "copy"), "rev-parse", "HEAD")).toBe(sha)
        warn.mockRestore()
    })

    test("a failing callback with no `error` listener does not crash the process", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
        const f = (fx = await setup({ postReceive: () => Promise.reject(new Error("nobody listens")) }))
        expect(f.repos.listenerCount("error")).toBe(0)
        await f.commit("a.txt", "a")

        expect(await gitCode(f.srcDir, "push", f.url, "main")).toBe(0)
        await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
        warn.mockRestore()
    })

    test("fetches and clones never call it", async () => {
        const f = (fx = await setup())
        await f.commit("a.txt", "a")
        await git(f.srcDir, "push", f.url, "main")
        await f.nextCall()

        const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "ngs-clone-"))
        await git(cloneDir, "clone", f.url, "copy")
        await git(path.join(cloneDir, "copy"), "fetch", "origin")

        // A later push is the next call — nothing was recorded for the clone or the fetch in between.
        const sha = await f.commit("b.txt", "b")
        await git(f.srcDir, "push", f.url, "main")
        expect((await f.nextCall()).updates[0].commit).toBe(sha)
        expect(f.calls).toHaveLength(2)
    })

    test("concurrent pushes to different branches each get their own call", async () => {
        const f = (fx = await setup())
        await f.commit("a.txt", "a")
        await git(f.srcDir, "push", f.url, "main")
        await f.nextCall()

        const shas: Record<string, string> = {}
        for (const branch of ["b1", "b2", "b3"]) {
            await git(f.srcDir, "checkout", "-b", branch, "main")
            shas[branch] = await f.commit(`${branch}.txt`, branch)
        }
        await Promise.all(["b1", "b2", "b3"].map((b) => git(f.srcDir, "push", f.url, b)))

        await vi.waitFor(() => expect(f.calls).toHaveLength(4))
        const seen = f.calls.slice(1).flatMap((c) => c.updates.map((u) => [u.ref, u.commit]))
        expect(Object.fromEntries(seen)).toEqual({
            "refs/heads/b1": shas.b1,
            "refs/heads/b2": shas.b2,
            "refs/heads/b3": shas.b3,
        })
    })

    test("without postReceive, pushes behave exactly as before", async () => {
        const f = (fx = await setup({ postReceive: undefined }))
        const sha = await f.commit("a.txt", "a")

        expect(await gitCode(f.srcDir, "push", f.url, "main")).toBe(0)
        expect(await git(f.bareDir, "rev-parse", "refs/heads/main")).toBe(sha)
        expect(f.calls).toHaveLength(0)
    })

    describe("fires per ref movement, not per commit", () => {
        test("one push carrying five commits on one branch: exactly one call, with only the before/after tips", async () => {
            const f = (fx = await setup())
            const base = await f.commit("base.txt", "base")
            await git(f.srcDir, "push", f.url, "main")
            await f.nextCall()

            const shas: string[] = []
            for (let i = 1; i <= 5; i++) shas.push(await f.commit(`c${i}.txt`, `commit ${i}`))
            await git(f.srcDir, "push", f.url, "main")

            expect(await f.nextCall()).toEqual({
                repo: "doom",
                updates: [{ ref: "refs/heads/main", last: base, commit: shas[4] }],
            })
            // The four intermediate commits are not reported anywhere.
            for (const sha of shas.slice(0, 4)) {
                expect(f.calls.flatMap((c) => c.updates).some((u) => u.commit === sha || u.last === sha)).toBe(false)
            }
            // A later push is the very next call — nothing else was queued for the five commits.
            const after = await f.commit("after.txt", "after")
            await git(f.srcDir, "push", f.url, "main")
            expect((await f.nextCall()).updates).toEqual([{ ref: "refs/heads/main", last: shas[4], commit: after }])
            expect(f.calls).toHaveLength(3)
        })

        test("a first push carrying a deep history (25 commits) is still one call", async () => {
            const f = (fx = await setup())
            let tip = ""
            for (let i = 1; i <= 25; i++) tip = await f.commit(`deep${i}.txt`, `deep ${i}`)
            await git(f.srcDir, "push", f.url, "main")

            expect(await f.nextCall()).toEqual({
                repo: "doom",
                updates: [{ ref: "refs/heads/main", last: ZERO, commit: tip }],
            })
            const count = await git(f.bareDir, "rev-list", "--count", "refs/heads/main")
            expect(count).toBe("25")
            expect(f.calls).toHaveLength(1)
        })

        test("three pushes of one commit each: three calls, each chaining from the previous tip", async () => {
            const f = (fx = await setup())
            let last = ZERO
            for (let i = 1; i <= 3; i++) {
                const sha = await f.commit(`p${i}.txt`, `push ${i}`)
                await git(f.srcDir, "push", f.url, "main")
                expect(await f.nextCall()).toEqual({
                    repo: "doom",
                    updates: [{ ref: "refs/heads/main", last, commit: sha }],
                })
                last = sha
            }
            expect(f.calls).toHaveLength(3)
        })

        test("pushing an existing commit to a new branch (no new commits) still moves a ref: one call", async () => {
            const f = (fx = await setup())
            const sha = await f.commit("a.txt", "a")
            await git(f.srcDir, "push", f.url, "main")
            await f.nextCall()
            const objectsBefore = await git(f.bareDir, "count-objects", "-v")

            await git(f.srcDir, "push", f.url, "main:refs/heads/alias")

            expect(await f.nextCall()).toEqual({
                repo: "doom",
                updates: [{ ref: "refs/heads/alias", last: ZERO, commit: sha }],
            })
            // No commit travelled: the object store is exactly what it was.
            expect(await git(f.bareDir, "count-objects", "-v")).toBe(objectsBefore)
            expect(f.calls).toHaveLength(2)
        })

        test("a push where git declines every ref moves nothing: no call at all", async () => {
            const f = (fx = await setup())
            const original = await f.commit("a.txt", "a")
            await git(f.srcDir, "push", f.url, "main")
            await f.nextCall()
            await git(f.bareDir, "config", "receive.denyNonFastForwards", "true")

            // Three rewritten commits in one force-push, all declined.
            await git(f.srcDir, "commit", "--amend", "-m", "rewritten 1")
            await f.commit("b.txt", "b")
            await f.commit("c.txt", "c")
            expect(await gitCode(f.srcDir, "push", "--force", f.url, "main")).not.toBe(0)
            expect(await git(f.bareDir, "rev-parse", "refs/heads/main")).toBe(original)

            // The declined push produced no call: the next call is this later push to a fresh branch.
            await git(f.srcDir, "checkout", "-b", "fresh")
            const fresh = await f.commit("d.txt", "d")
            await git(f.srcDir, "push", f.url, "fresh")
            expect(await f.nextCall()).toEqual({
                repo: "doom",
                updates: [{ ref: "refs/heads/fresh", last: ZERO, commit: fresh }],
            })
            expect(f.calls).toHaveLength(2)
        })
    })

    describe("push/tag events carry the same RefUpdate", () => {
        test("a first push: the push event's update is the created ref, and matches what postReceive gets", async () => {
            const f = (fx = await setup())
            const seen: Array<{ branch: string; commit: string; update: unknown }> = []
            f.repos.on("push", (push) => {
                seen.push({ branch: push.branch, commit: push.commit, update: { ...push.update } })
                push.accept()
            })
            const sha = await f.commit("a.txt", "a")
            await git(f.srcDir, "push", f.url, "main")

            const call = await f.nextCall()
            expect(seen).toEqual([
                { branch: "main", commit: sha, update: { ref: "refs/heads/main", last: ZERO, commit: sha } },
            ])
            expect(call.updates).toEqual([seen[0].update])
        })

        test("a fast-forward: update.last is the previous tip, without the pkt-line length prefix", async () => {
            const f = (fx = await setup())
            const first = await f.commit("a.txt", "a")
            await git(f.srcDir, "push", f.url, "main")
            await f.nextCall()

            const updates: unknown[] = []
            f.repos.on("push", (push) => {
                updates.push({ ...push.update })
                push.accept()
            })
            const second = await f.commit("b.txt", "b")
            await git(f.srcDir, "push", f.url, "main")
            await f.nextCall()

            expect(updates).toEqual([{ ref: "refs/heads/main", last: first, commit: second }])
        })

        test("a two-branch push: each push event sees its own ref's update, in request order", async () => {
            const f = (fx = await setup())
            const mainSha = await f.commit("a.txt", "a")
            await git(f.srcDir, "checkout", "-b", "dev")
            const devSha = await f.commit("b.txt", "b")

            const seen: Array<{ branch: string; update: unknown }> = []
            f.repos.on("push", (push) => {
                seen.push({ branch: push.branch, update: { ...push.update } })
                push.accept()
            })
            await git(f.srcDir, "push", f.url, "main", "dev")
            const call = await f.nextCall()

            const byBranch = Object.fromEntries(seen.map((e) => [e.branch, e.update]))
            expect(byBranch).toEqual({
                main: { ref: "refs/heads/main", last: ZERO, commit: mainSha },
                dev: { ref: "refs/heads/dev", last: ZERO, commit: devSha },
            })
            // The events saw the updates in the same order postReceive lists them.
            expect(seen.map((e) => e.update)).toEqual(call.updates)
        })

        test("a tag push: the tag event's update is under refs/tags, with version set as before", async () => {
            const f = (fx = await setup())
            const sha = await f.commit("a.txt", "a")
            await git(f.srcDir, "push", f.url, "main")
            await f.nextCall()

            const seen: Array<{ version: string; update: unknown }> = []
            f.repos.on("tag", (tag) => {
                seen.push({ version: tag.version, update: { ...tag.update } })
                tag.accept()
            })
            await git(f.srcDir, "tag", "v1")
            await git(f.srcDir, "push", f.url, "v1")
            await f.nextCall()

            expect(seen).toEqual([{ version: "v1", update: { ref: "refs/tags/v1", last: ZERO, commit: sha } }])
        })

        test("a rejected push still exposed its update to the listener, and postReceive never runs", async () => {
            const f = (fx = await setup())
            const seen: unknown[] = []
            let reject = true
            f.repos.on("push", (push) => {
                seen.push({ ...push.update })
                if (reject) push.reject(403, "denied")
                else push.accept()
            })
            const sha = await f.commit("a.txt", "a")

            expect(await gitCode(f.srcDir, "push", f.url, "main")).not.toBe(0)
            expect(seen).toEqual([{ ref: "refs/heads/main", last: ZERO, commit: sha }])

            reject = false
            await git(f.srcDir, "push", f.url, "main")
            expect(await f.nextCall()).toEqual({
                repo: "doom",
                updates: [{ ref: "refs/heads/main", last: ZERO, commit: sha }],
            })
            expect(f.calls).toHaveLength(1)
        })
    })
})
