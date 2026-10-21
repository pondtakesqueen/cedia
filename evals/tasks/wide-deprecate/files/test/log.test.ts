import { expect, test } from 'bun:test';
import { setSink } from '../src/log.ts';
import { run as run0 } from '../src/auth/login.ts';
import { run as run1 } from '../src/auth/logout.ts';
import { run as run2 } from '../src/auth/tokens.ts';
import { run as run3 } from '../src/billing/invoice.ts';
import { run as run4 } from '../src/billing/refund.ts';
import { run as run5 } from '../src/billing/tax.ts';
import { run as run6 } from '../src/cache/memory.ts';
import { run as run7 } from '../src/cache/disk.ts';
import { run as run8 } from '../src/jobs/queue.ts';
import { run as run9 } from '../src/jobs/retry.ts';
import { run as run10 } from '../src/jobs/schedule.ts';
import { run as run11 } from '../src/http/server.ts';
import { run as run12 } from '../src/http/routes.ts';
import { run as run13 } from '../src/http/errors.ts';
import { run as run14 } from '../src/mail/send.ts';
import { run as run15 } from '../src/mail/bounce.ts';
import { run as run16 } from '../src/search/index.ts';
import { run as run17 } from '../src/search/query.ts';
import { run as run18 } from '../src/users/profile.ts';
import { run as run19 } from '../src/users/delete.ts';

const CASES: [string, () => void, string[]][] = [
  ['auth/login', run0, ["INFO login ann", "WARN slow login"]],
  ['auth/logout', run1, ["INFO logout ann"]],
  ['auth/tokens', run2, ["DEBUG token refreshed", "ERROR token expired"]],
  ['billing/invoice', run3, ["INFO invoice i7 for 1200"]],
  ['billing/refund', run4, ["WARN refund over limit: 900"]],
  ['billing/tax', run5, ["DEBUG tax table loaded"]],
  ['cache/memory', run6, ["DEBUG cache miss", "INFO cache warmed"]],
  ['cache/disk', run7, ["ERROR disk full: /var/c"]],
  ['jobs/queue', run8, ["WARN queue drained"]],
  ['jobs/retry', run9, ["WARN retry 3", "ERROR giving up"]],
  ['jobs/schedule', run10, ["INFO schedule loaded"]],
  ['http/server', run11, ["INFO listening on 8080"]],
  ['http/routes', run12, ["DEBUG route GET /x"]],
  ['http/errors', run13, ["ERROR status 503"]],
  ['mail/send', run14, ["INFO mail to a@b.c", "WARN mail queue slow"]],
  ['mail/bounce', run15, ["ERROR hard bounce"]],
  ['search/index', run16, ["INFO indexed 42 docs"]],
  ['search/query', run17, ["DEBUG query \"mug\""]],
  ['users/profile', run18, ["INFO profile saved"]],
  ['users/delete', run19, ["WARN deleting u1", "INFO deleted"]],
];

test('every module logs the same lines as before', () => {
  for (const [name, run, want] of CASES) {
    const got: string[] = [];
    setSink((l) => got.push(l));
    run();
    expect([name, ...got]).toEqual([name, ...want]);
  }
});
