import { spawnSync } from 'node:child_process';
import { lstatSync, rmSync } from 'node:fs';

// A copy-on-write copy of a file or a whole directory: the copy shares the original's blocks until one side
// writes, so it takes no room and little time, and what is written to one never reaches the other. On macOS one
// clonefile(2) clones a directory hierarchy in the kernel (APFS: 20,000 files in about 0.2 s, where `cp -c` takes
// 2.6 s and a plain copy 4.5 s); on Linux `cp --reflink=always` does it on filesystems that share extents
// (btrfs, xfs). False where the filesystem cannot (another volume, ext4, tmpfs), and then nothing is left at `to`.

type CloneFile = (from: string, to: string) => number;

let clonefile: CloneFile | null | undefined;

// libSystem's clonefile, loaded once; null where it is not there.
function darwinClonefile(): CloneFile | null {
  if (clonefile !== undefined) return clonefile;
  try {
    const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof import('bun:ffi');
    const lib = dlopen('/usr/lib/libSystem.B.dylib', { clonefile: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 } });
    const cstr = (s: string) => ptr(Buffer.from(`${s}\0`));
    // CLONE_NOFOLLOW: a link at `from` is cloned as the link, never followed.
    clonefile = (from, to) => lib.symbols.clonefile(cstr(from), cstr(to), 1) as number;
  } catch {
    clonefile = null;
  }
  return clonefile;
}

// `to` must not exist yet: one that does (even a dangling link) is left as it is, since `cp` would write into it.
export function cloneTree(from: string, to: string): boolean {
  try {
    lstatSync(to);
    return false;
  } catch {}
  if (process.platform === 'darwin') {
    const clone = darwinClonefile();
    return clone !== null && clone(from, to) === 0;
  }
  if (process.platform !== 'linux') return false;
  const r = spawnSync('cp', ['-R', '-P', '--reflink=always', from, to], { stdio: 'ignore' });
  if (r.status === 0) return true;
  rmSync(to, { recursive: true, force: true });
  return false;
}
