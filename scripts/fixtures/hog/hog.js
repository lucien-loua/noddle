// Memory bomb, run during the BUILD phase (npm run build).
//
// It stands in for a real Next.js build on a 2 GB VM: same outcome, 200 ms to
// write, and deterministic. If the cap works, this process is killed by the
// builder's cgroup BEFORE it exhausts the VM's RAM — and the services already
// running do not flinch.
//
// Buffer.alloc with a fill value forces the pages to be really committed:
// without it we only allocate virtual address space and the cgroup never
// fires.
const chunks = [];
let mb = 0;

for (;;) {
  chunks.push(Buffer.alloc(64 * 1024 * 1024, 1));
  mb += 64;
  console.log(`[hog] ${mb} MB allocated`);
}
