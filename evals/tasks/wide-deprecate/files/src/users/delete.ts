import { oldLog } from '../log.ts';

// users/delete: the delete step.
export function run(id = "u1"): void {
  oldLog(
    'warn',
    `deleting ${id}`,
  );
  oldLog(
    'info',
    'deleted',
  );
}
