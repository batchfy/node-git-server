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

## Repository names and the `.git` suffix

A repo has one canonical on-disk name, and that is the name the server creates it
under, reports from `list()`, passes to your `repoDir` resolver, and sets on the
`repo` property of every event:

- bare repos (the default) are named `<name>.git`
- checked-out repos (`checkout: true`) are named `<name>`

Requests may use either form: `git clone http://localhost:7005/doom` and
`git clone http://localhost:7005/doom.git` both reach the same repository. A repo
that already exists under the requested name wins, so repos on disk without a
`.git` suffix keep working, and `list()` reports every directory that is a git
repository rather than only the `.git`-suffixed ones.

To insist on a single external name, set `enforceGitSuffix`:

```js
const repos = new Git(path.resolve("./repos"), { enforceGitSuffix: true })
```

With it, `<name>.git` is the only name a repo is known by: `GET` requests for a
suffix-less URL are answered with a `301` to the `.git` URL (git follows it), and
directories without the suffix are neither listed nor served.

## Documentation

Full documentation is available at [https://batchfy.com/node-git-server](https://batchfy.com/node-git-server).
