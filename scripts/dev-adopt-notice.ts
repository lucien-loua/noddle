const DIM = "\u001B[2m";
const BOLD = "\u001B[1m";
const OFF = "\u001B[0m";

process.stdout.write(
  `\n  ${BOLD}The database is empty again \u2014 including the adopted server and the backup destination.${OFF}\n` +
    `  ${DIM}Register the VM as target #1, and the dev S3 bucket for backups, before deploying anything:${OFF}\n` +
    `      ./scripts/adopt-local.sh\n\n`
);
