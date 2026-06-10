// kilocode_change - new file

import { MemoryEval } from "../src/kilocode/memory/eval"

const dir = process.argv[2] ?? process.cwd()
const result = await MemoryEval.run({ dir })

console.log(`run: ${result.runID}`)
console.log(`jsonl: ${result.root}/eval/runs/${result.runID}.jsonl`)
console.log(`report: ${result.report}`)
