// Force a deterministic git environment for every subprocess the tests spawn —
// `main` as the default branch AND a committer identity — regardless of the
// host's config. CI runners default to `master` and may have no user.name /
// user.email set (so `git commit` fails with exit 128). Uses git's env-based
// config, which takes precedence over the global/system config, so the machine's
// own git configuration is never touched.
const gitConfig: Array<[string, string]> = [
    ["init.defaultBranch", "main"],
    ["user.name", "node-git-server tests"],
    ["user.email", "tests@node-git-server.invalid"],
]

process.env.GIT_CONFIG_COUNT = String(gitConfig.length)
gitConfig.forEach(([key, value], i) => {
    process.env[`GIT_CONFIG_KEY_${i}`] = key
    process.env[`GIT_CONFIG_VALUE_${i}`] = value
})
