export const HELP = `noddle — talk to a Noddle installation

usage
  noddle whoami                   who this token is, and what it may do
  noddle servers                  the machines this Noddle manages
  noddle services                 the services it runs
  noddle deploy <service-id>      deploy a service
  noddle status <deployment-id>   how a deployment ended

options
  --wait              with deploy, block until it finishes
  --timeout <seconds> how long --wait waits (default 900)
  --json              machine-readable output
  --url <address>     the Noddle to talk to (or NODDLE_URL)
  --token <token>     the token to use (or NODDLE_TOKEN)
  -h, --help          this text

exit codes
  0  it worked
  1  it failed, including a deployment that failed under --wait
  2  the command line was wrong`;
