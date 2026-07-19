import type {
  Observation,
  OracleCredit,
  OracleDelivery,
  OracleModel,
  OracleReceipt,
  OracleRequest,
} from './model.js';

export function applyObservation(model: OracleModel, observation: Observation): OracleModel {
  const requests = new Map(model.requests);
  const deliveries = new Map(model.deliveries);
  const proofOwners = new Map(model.proofOwners);
  const proofStates = new Map(model.proofStates);
  const credits = new Map(model.credits);
  const receipts = new Map(model.receipts);

  switch (observation.type) {
    case 'request_observed': {
      if (!requests.has(observation.requestId)) {
        const request: OracleRequest = observation;
        requests.set(observation.requestId, request);
      }
      break;
    }
    case 'delivery_attempted': {
      const previous = deliveries.get(observation.deliveryId);
      if (!previous) {
        const delivery: OracleDelivery = {
          requestId: observation.requestId,
          deliveryId: observation.deliveryId,
          payloadHash: observation.payloadHash,
          proofSetHash: observation.proofSetHash,
          transports: new Set([observation.transport]),
        };
        deliveries.set(observation.deliveryId, delivery);
      } else if (
        previous.requestId === observation.requestId &&
        previous.payloadHash === observation.payloadHash &&
        previous.proofSetHash === observation.proofSetHash
      ) {
        deliveries.set(observation.deliveryId, {
          ...previous,
          transports: new Set([...previous.transports, observation.transport]),
        });
      }
      if (!proofOwners.has(observation.proofSetHash)) {
        proofOwners.set(observation.proofSetHash, observation.deliveryId);
      }
      break;
    }
    case 'mint_proofs_state':
      proofStates.set(observation.proofSetHash, observation.state);
      break;
    case 'redemption_started':
      break;
    case 'receiver_settled': {
      const previous = deliveries.get(observation.deliveryId);
      if (previous && previous.replacementPlanHash === undefined) {
        deliveries.set(observation.deliveryId, {
          ...previous,
          replacementPlanHash: observation.replacementPlanHash,
        });
      }
      break;
    }
    case 'merchant_credited': {
      if (!credits.has(observation.creditId)) {
        const credit: OracleCredit = observation;
        credits.set(observation.creditId, credit);
      }
      break;
    }
    case 'receipt_observed': {
      const previous = receipts.get(observation.deliveryId);
      if (!previous || observation.version > previous.version) {
        const receipt: OracleReceipt = observation;
        receipts.set(observation.deliveryId, receipt);
      }
      break;
    }
  }

  return {
    requests,
    deliveries,
    proofOwners,
    proofStates,
    credits,
    receipts,
    observations: [...model.observations, observation],
  };
}
