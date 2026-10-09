import { buildDashboard, type DashboardDeps, type DashboardTestHooks } from './server.js';

/** Test-only entry (Task 13 fix round 4, M12): the dashboard with hooks. Nothing in production imports this module. */
export const createTestDashboard = (deps: DashboardDeps, hooks: DashboardTestHooks) => buildDashboard(deps, hooks);
