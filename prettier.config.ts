import type { Config } from "prettier"

/**
 * @see https://prettier.io/docs/configuration
 */
const config: Config = {
    trailingComma: "es5",
    tabWidth: 4,
    useTabs: false,
    semi: false,
    arrowParens: "always",
    printWidth: 120,
    singleQuote: false,
}

export default config
