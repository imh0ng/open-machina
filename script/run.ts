export {}

import { runCli } from "open-machina-cli"

const result = await runCli(Bun.argv.slice(2), process.env)

if (result.stdout.length > 0) {
  console.log(result.stdout)
}

if (result.stderr && result.stderr.length > 0) {
  console.error(result.stderr)
}

process.exit(result.code)
