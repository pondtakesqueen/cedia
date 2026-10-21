import { log } from '../log.ts';

// users/delete: the delete step.
export function run(id = "u1"): void {
  log.warn(
    `deleting ${id}`,
  );
  log.info(
    'deleted',
  );
}
