<p align="center">
  <a href="https://batchfy.com/node-git-server">
    <img src="https://batchfy.com/images/node-git-server-solid-orange.svg" alt="node-git-server" width="70" height="70" />
  </a>
</p>

<h1 align="center">node-git-server</h1>

<p align="center">A configurable git server written in Node.js</p>

This repository is a continuation of [gabrielcsapo/node-git-server](https://github.com/gabrielcsapo/node-git-server) — carrying the project forward with a modernized, ESM-only, zero-dependency codebase and an extended async API.

ESM-only, requires **Node.js >= 22**, and ships with **zero runtime dependencies**.

## Install

```shell
npm i @batchfy/node-git-server
```

## Usage

```js
import { Git } from "@batchfy/node-git-server"
import path from "node:path"

const repos = new Git(path.resolve("./repos"), {
    autoCreate: true,
})

repos.on("push", (push) => {
    console.log(`push ${push.repo}/${push.commit} (${push.branch})`)
    push.accept()
})

repos.on("fetch", (fetch) => {
    console.log(`fetch ${fetch.repo}/${fetch.commit}`)
    fetch.accept()
})

repos.listen(7005, { type: "http" }, () => {
    console.log("node-git-server running at http://localhost:7005")
})
```

The repo-directory resolver may also be asynchronous, and `authenticate` supports
async permission checks (e.g. a database lookup):

```js
const repos = new Git(
    async (repo) => resolveRepoPathFromDb(repo), // string | Promise<string>
    {
        authenticate: ({ type, repo, user }, next) => {
            user(async (username, password) => {
                try {
                    await checkPermission({ username, password, repo, action: type })
                    await next()
                } catch (err) {
                    await next(err)
                }
            })
        },
    }
)
```

`push` and `tag` events also carry `update`, the full ref update the event is about —
`{ ref: "refs/heads/main", last: "<sha before>", commit: "<sha after>" }` — the same shape
`postReceive` receives.

`push` fires before git has received anything, so it can only accept or reject. For work that
needs the pushed commits to be in the repo, pass `postReceive`. It runs once per push (branches
and tags alike) after the refs have moved, with only the updates git actually applied. The client
is not kept waiting on it, so it may be slow, and it is fail-tolerant: a throw or rejection only
logs a warning.

```js
const repos = new Git(path.resolve("./repos"), {
    postReceive: async ({ repo, updates }) => {
        // updates: [{ ref: "refs/heads/main", last: "<sha before>", commit: "<sha after>" }, ...]
        // `last` is all zeros for a created ref, `commit` all zeros for a deleted one.
        await rebuildCaches(repo, updates)
    },
})
```

## Documentation

Full documentation is available at [https://batchfy.com/node-git-server](https://batchfy.com/node-git-server).
