// Printed after `dev:stack:reset`, and only there.
//
// Dropping the volumes takes the ADOPTED server with them, and nothing says
// so. Anything that deploys then fails with "no Swarm manager registered —
// the installer should have created one", which reads as a broken
// installation. It cost five runs of verify-prune-toggle to find that the
// bench was right and the database was empty.
const DIM = "\u001B[2m";
const BOLD = "\u001B[1m";
const OFF = "\u001B[0m";

process.stdout.write(
  `\n  ${BOLD}The database is empty again \u2014 including the adopted server.${OFF}\n` +
    `  ${DIM}Register the VM as target #1 before deploying anything:${OFF}\n` +
    `      ./scripts/adopt-local.sh\n\n`
);
