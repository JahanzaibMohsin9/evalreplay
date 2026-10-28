// The "a tool breaks" demo: runs the cases with verify_beneficiary failing, as an outage of the
// service behind it would. The cases that verify a payee fail, and say where.
import { main } from 'evalreplay';

process.env.CARRYPAY_BROKEN_TOOL ??= 'verify_beneficiary';
process.exitCode = await main(['run', ...process.argv.slice(2)]);
