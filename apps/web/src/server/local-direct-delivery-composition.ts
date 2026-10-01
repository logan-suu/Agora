/** Host-owned read composition for a quiescent direct workspace. No worker,
 * grant, command or lifecycle transition is created by this factory. */
import { LocalDeliveryComparisonStore } from '../../../../packages/runtime/sandbox/src/local-delivery-comparison-record';
import { LocalDirectDeliveryCurrentSource } from '../../../../packages/runtime/sandbox/src/local-delivery-current';
import type { LocalWorkspaceSessions } from '../../../../packages/runtime/sandbox/src/local-workspace-sessions';
import { LocalDirectDeliverySources } from './local-direct-delivery-sources';

type Resources = Pick<
  Parameters<typeof LocalWorkspaceSessions.create>[0],
  'control' | 'objects' | 'versions' | 'verifyGrant'
>;

export function createLocalDirectDeliveryComparisons(
  resources: Resources,
  sessions: LocalWorkspaceSessions,
): LocalDeliveryComparisonStore {
  const current = new LocalDirectDeliveryCurrentSource(
    resources.control,
    resources.versions,
    (scope, grantId) => resources.verifyGrant(scope, grantId),
    (scope, claim) => sessions.verifyClosedClaim(scope, claim),
  );
  const sources = new LocalDirectDeliverySources(
    resources.control,
    current,
    resources.versions,
    sessions,
  );
  return new LocalDeliveryComparisonStore(resources.objects, resources.versions, (scope) =>
    sources.read(scope),
  );
}
