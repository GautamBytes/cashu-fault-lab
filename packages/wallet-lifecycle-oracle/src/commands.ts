import type { LifecycleModel, LifecycleObservation } from './model.js';

function copyObservation(observation: LifecycleObservation): LifecycleObservation {
  if (observation.type === 'operation_observed') {
    return Object.freeze({
      type: observation.type,
      operation: Object.freeze({ ...observation.operation }),
      ...(observation.provenance === undefined ? {} : { provenance: observation.provenance }),
    });
  }
  return Object.freeze({ ...observation });
}

export function applyLifecycleObservation(
  model: LifecycleModel,
  observation: LifecycleObservation,
): LifecycleModel {
  return Object.freeze({
    observations: Object.freeze([...model.observations, copyObservation(observation)]),
  });
}
