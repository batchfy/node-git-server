// You can use the commands below to generate a self-signed certificate for use with this example.
// These commands require that you have 'openssl' installed on your system:
//   openssl genrsa -out privatekey.pem 1024
//   openssl req -new -key privatekey.pem -out certrequest.csr
//   openssl x509 -req -in certrequest.csr -signkey privatekey.pem -out certificate.pem
//
// Run `npm run build` first, then: `node example/index.js` (or `node example/index.js https`)

import fs from "node:fs"
import path from "node:path"

import { Git } from "../dist/index.js"

const type = process.argv.slice(2).includes("https") ? "https" : "http"
const port = Number(process.env.PORT) || 7005

const repos = new Git(path.resolve(import.meta.dirname, "tmp"), {
    autoCreate: true,
    authenticate: ({ type, repo, user, headers }, next) => {
        console.log(type, repo, headers)
        if (type === "push") {
            // Decide if this user is allowed to perform this action against this repo.
            user((username, password) => {
                if (username === "42" && password === "42") {
                    next()
                } else {
                    next(new Error("wrong password"))
                }
            })
        } else {
            // Check these credentials are correct for this user.
            next()
        }
    },
})

repos.on("push", (push) => {
    console.log(`push ${push.repo} / ${push.commit} ( ${push.branch} )`)

    repos.list((err, results = []) => {
        push.log(" ")
        push.log("Hey!")
        push.log("Checkout these other repos:")
        for (const repo of results) {
            push.log(`- ${repo}`)
        }
        push.log(" ")
    })

    push.accept()
})

repos.on("fetch", (fetch) => {
    console.log(`username ${fetch.username}`)
    console.log(`fetch ${fetch.repo}/${fetch.commit}`)
    fetch.accept()
})

function httpsOptions() {
    const key = path.resolve(import.meta.dirname, "privatekey.pem")
    const cert = path.resolve(import.meta.dirname, "certificate.pem")
    if (!fs.existsSync(key) || !fs.existsSync(cert)) {
        console.error(
            "https mode needs a self-signed certificate. Generate one in the example/ directory:\n" +
                "  openssl genrsa -out privatekey.pem 2048\n" +
                "  openssl req -new -key privatekey.pem -out certrequest.csr\n" +
                "  openssl x509 -req -in certrequest.csr -signkey privatekey.pem -out certificate.pem"
        )
        process.exit(1)
    }
    return { type, key: fs.readFileSync(key), cert: fs.readFileSync(cert) }
}

const listenOptions = type === "https" ? httpsOptions() : { type }

repos.listen(port, listenOptions, (error) => {
    if (error) {
        console.error(`failed to start git-server because of error ${error}`)
        return
    }
    console.log(`node-git-server running at ${type}://localhost:${port}`)
    repos.list((err, result) => {
        if (!result) {
            console.log("No repositories available...")
        } else {
            console.log(result)
        }
    })
})
