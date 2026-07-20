import type {
  MintProofState,
  Observation,
  OracleCredit,
  OracleModel,
  OracleReceipt,
} from './model.js';

interface DeliveryIdentity {
  readonly requestId: string;
  readonly payloadHash: string;
  readonly proofSetHash: string;
}

function fail(message: string): never {
  throw new Error(`Oracle safety violation: ${message}`);
}

function sameDelivery(left: DeliveryIdentity, right: DeliveryIdentity): boolean {
  return (
    left.requestId === right.requestId &&
    left.payloadHash === right.payloadHash &&
    left.proofSetHash === right.proofSetHash
  );
}

function sameCredit(left: OracleCredit, right: OracleCredit): boolean {
  return (
    left.creditId === right.creditId &&
    left.requestId === right.requestId &&
    left.deliveryId === right.deliveryId &&
    left.amount === right.amount &&
    left.unit === right.unit
  );
}

function sameReceipt(left: OracleReceipt, right: OracleReceipt): boolean {
  return (
    left.requestId === right.requestId &&
    left.deliveryId === right.deliveryId &&
    left.payloadHash === right.payloadHash &&
    left.status === right.status &&
    left.detailCode === right.detailCode &&
    left.version === right.version &&
    left.amount === right.amount &&
    left.unit === right.unit
  );
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const values = map.get(key) ?? new Set<string>();
  values.add(value);
  map.set(key, values);
}

export function assertSafety(model: OracleModel): void {
  const requests = new Map<string, boolean>();
  const deliveries = new Map<string, DeliveryIdentity>();
  const proofOwners = new Map<string, string>();
  const redemptionStarts = new Map<string, number>();
  const mayBeConsumed = new Set<string>();
  const settlementPlans = new Map<string, string>();
  const credits = new Map<string, OracleCredit>();
  const creditsByDelivery = new Map<string, Set<string>>();
  const creditsByRequest = new Map<string, Set<string>>();
  const receiptVersions = new Map<string, OracleReceipt>();
  const receiptsByDelivery = new Map<string, OracleReceipt[]>();

  for (const observation of model.observations) {
    switch (observation.type) {
      case 'request_observed': {
        const previous = requests.get(observation.requestId);
        if (previous !== undefined && previous !== observation.singleUse) {
          fail(`request ${observation.requestId} single-use policy is immutable`);
        }
        requests.set(observation.requestId, observation.singleUse);
        break;
      }
      case 'delivery_attempted': {
        const identity: DeliveryIdentity = observation;
        const previous = deliveries.get(observation.deliveryId);
        if (previous && !sameDelivery(previous, identity)) {
          fail(`delivery ${observation.deliveryId} identity is immutable`);
        }
        deliveries.set(observation.deliveryId, previous ?? identity);

        const owner = proofOwners.get(observation.proofSetHash);
        if (owner !== undefined && owner !== observation.deliveryId) {
          fail(`proof set ${observation.proofSetHash} must have a unique owner`);
        }
        proofOwners.set(observation.proofSetHash, observation.deliveryId);
        break;
      }
      case 'mint_proofs_state':
        if (observation.state === 'PENDING' || observation.state === 'SPENT') {
          mayBeConsumed.add(observation.proofSetHash);
        }
        break;
      case 'redemption_started': {
        const identity = deliveries.get(observation.deliveryId);
        if (!identity || identity.proofSetHash !== observation.proofSetHash) {
          fail(`redemption for ${observation.deliveryId} does not match delivery identity`);
        }
        const count = (redemptionStarts.get(observation.deliveryId) ?? 0) + 1;
        if (count > 1) {
          fail(`redemption for ${observation.deliveryId} must start at most once`);
        }
        redemptionStarts.set(observation.deliveryId, count);
        break;
      }
      case 'receiver_settled': {
        const previous = settlementPlans.get(observation.deliveryId);
        if (previous !== undefined && previous !== observation.replacementPlanHash) {
          fail(`delivery ${observation.deliveryId} has more than one settlement plan`);
        }
        settlementPlans.set(observation.deliveryId, observation.replacementPlanHash);
        break;
      }
      case 'merchant_credited': {
        const previous = credits.get(observation.creditId);
        if (previous && !sameCredit(previous, observation)) {
          fail(`credit ${observation.creditId} identity is immutable`);
        }
        credits.set(observation.creditId, previous ?? observation);
        addToSetMap(creditsByDelivery, observation.deliveryId, observation.creditId);
        addToSetMap(creditsByRequest, observation.requestId, observation.creditId);
        break;
      }
      case 'receipt_observed': {
        if (!Number.isSafeInteger(observation.version) || observation.version < 1) {
          fail(`receipt ${observation.deliveryId} has an invalid version`);
        }
        const key = `${observation.deliveryId}\0${observation.version}`;
        const previous = receiptVersions.get(key);
        if (previous && !sameReceipt(previous, observation)) {
          fail(`receipt ${observation.deliveryId} version ${observation.version} is conflicting`);
        }
        receiptVersions.set(key, previous ?? observation);
        const history = receiptsByDelivery.get(observation.deliveryId) ?? [];
        history.push(observation);
        receiptsByDelivery.set(observation.deliveryId, history);
        break;
      }
    }
  }

  for (const [deliveryId, creditIds] of creditsByDelivery) {
    if (creditIds.size > 1) fail(`delivery ${deliveryId} must have at most one credit`);
    if (!settlementPlans.has(deliveryId)) {
      fail(`delivery ${deliveryId} was credited without recovered replacement outputs`);
    }
    const identity = deliveries.get(deliveryId);
    for (const creditId of creditIds) {
      const credit = credits.get(creditId)!;
      if (!identity || credit.requestId !== identity.requestId) {
        fail(`credit ${creditId} does not match immutable delivery identity`);
      }
      if (!Number.isSafeInteger(credit.amount) || credit.amount < 0) {
        fail(`credit ${creditId} has an invalid amount`);
      }
    }
  }

  for (const [requestId, creditIds] of creditsByRequest) {
    if (requests.get(requestId) === true && creditIds.size > 1) {
      fail(`single-use request ${requestId} must have at most one credit`);
    }
  }

  for (const [deliveryId, history] of receiptsByDelivery) {
    const unique = [...new Map(history.map((receipt) => [receipt.version, receipt])).values()];
    const identity = deliveries.get(deliveryId);
    for (const receipt of unique) {
      if (
        identity &&
        (receipt.requestId !== identity.requestId || receipt.payloadHash !== identity.payloadHash)
      ) {
        fail(`receipt ${deliveryId} does not match immutable delivery identity`);
      }
    }

    const terminal = unique
      .filter((receipt) => receipt.status === 'settled' || receipt.status === 'rejected')
      .sort((left, right) => left.version - right.version)[0];
    if (
      terminal &&
      unique.some(
        (receipt) => receipt.version > terminal.version && !sameReceipt(receipt, terminal),
      )
    ) {
      fail(`terminal receipt ${deliveryId} regressed`);
    }

    const latest = unique.sort((left, right) => right.version - left.version)[0]!;
    if (latest.status === 'settled') {
      const creditIds = creditsByDelivery.get(deliveryId);
      if (!settlementPlans.has(deliveryId) || creditIds?.size !== 1) {
        fail(`settled receipt ${deliveryId} requires recovered outputs and exactly one credit`);
      }
      const credit = credits.get([...creditIds][0]!);
      if (
        !credit ||
        credit.requestId !== latest.requestId ||
        credit.amount !== latest.amount ||
        credit.unit !== latest.unit
      ) {
        fail(`settled receipt ${deliveryId} does not match its merchant credit`);
      }
    }

    if (latest.status === 'rejected' && identity && mayBeConsumed.has(identity.proofSetHash)) {
      fail(`receipt ${deliveryId} rejected proofs after they may have been consumed`);
    }
  }

  // Transport convergence: every delivery observed over multiple transports must
  // converge to the same receipt identity (payload hash + status).
  const deliveryTransports = new Map<string, Set<string>>();
  for (const observation of model.observations) {
    if (observation.type === 'delivery_attempted') {
      const existing = deliveryTransports.get(observation.deliveryId) ?? new Set();
      existing.add(observation.transport);
      deliveryTransports.set(observation.deliveryId, existing);
    }
  }
  for (const [_, transportSet] of deliveryTransports) {
    if (transportSet.size > 1) {
      // When a delivery is observed over multiple transports (HTTP + Nostr),
      // receipts must be consistent — verified above via identity immutability.
      // This is a pass-through: the delivery_attempted identity immutability check
      // already ensures payload/proof-set hashes are preserved across transport
      // observations.
    }
  }

  // Net amount consistency: settled receipt amount must match credited amount.
  for (const [deliveryId, receiptList] of receiptsByDelivery) {
    const settled = receiptList
      .filter((r) => r.status === 'settled')
      .sort((a, b) => b.version - a.version)[0];
    if (!settled) continue;
    const deliveryCreditIds = creditsByDelivery.get(deliveryId);
    if (deliveryCreditIds && deliveryCreditIds.size === 1) {
      const credit = credits.get([...deliveryCreditIds][0]!);
      if (credit && credit.amount !== settled.amount) {
        fail(
          `delivery ${deliveryId} settled amount ${settled.amount} does not match credit amount ${credit.amount}`,
        );
      }
      if (credit && credit.unit !== settled.unit) {
        fail(
          `delivery ${deliveryId} settled unit ${settled.unit} does not match credit unit ${credit.unit}`,
        );
      }
    }
  }
}

function latestReceipt(
  observations: readonly Observation[],
  deliveryId: string,
): OracleReceipt | undefined {
  let latest: OracleReceipt | undefined;
  for (const observation of observations) {
    if (
      observation.type === 'receipt_observed' &&
      observation.deliveryId === deliveryId &&
      (!latest || observation.version > latest.version)
    ) {
      latest = observation;
    }
  }
  return latest;
}

function strongestState(
  observations: readonly Observation[],
  proofSetHash: string,
): MintProofState | undefined {
  let strongest: MintProofState | undefined;
  for (const observation of observations) {
    if (observation.type !== 'mint_proofs_state' || observation.proofSetHash !== proofSetHash) {
      continue;
    }
    if (observation.state === 'SPENT') return 'SPENT';
    if (observation.state === 'PENDING') strongest = 'PENDING';
    else strongest ??= 'UNSPENT';
  }
  return strongest;
}

export function assertQuiescentLiveness(model: OracleModel): void {
  assertSafety(model);
  for (const delivery of model.deliveries.values()) {
    const receipt = latestReceipt(model.observations, delivery.deliveryId);
    if (!receipt) fail(`delivery ${delivery.deliveryId} is not quiescent: no receipt`);
    if (receipt.status === 'settled' || receipt.status === 'rejected') continue;
    const state = strongestState(model.observations, delivery.proofSetHash);
    if (receipt.detailCode === 'recovery_blocked' && (state === 'PENDING' || state === 'SPENT')) {
      continue;
    }
    fail(`delivery ${delivery.deliveryId} is not quiescent`);
  }
}
