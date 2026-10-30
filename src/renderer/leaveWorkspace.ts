type LeaveGuard = () => boolean | Promise<boolean>;
const guards = new Set<LeaveGuard>();

/** Explicit sign out shares editor discard checks and pending-note flushes. */
export function registerLeaveGuard(guard: LeaveGuard) {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}
export async function canLeaveWorkspace() {
  for (const guard of guards) {
    if (!(await guard())) return false;
  }
  return true;
}
