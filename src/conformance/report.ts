/** Print the conformance matrix. `node src/conformance/report.ts` */
import { ALL_CAPABILITIES } from './capabilities.ts'
import { formatReport, runConformance } from './suite.ts'

console.log(formatReport(runConformance(ALL_CAPABILITIES)))
