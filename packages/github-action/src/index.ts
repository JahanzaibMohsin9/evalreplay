// The entry point action.yml runs.
import { main } from './main.js';

process.exitCode = await main();
