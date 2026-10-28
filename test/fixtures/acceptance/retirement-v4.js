import { acceptanceFixturesV4 } from './tasks-v4.js'

export function retirementDiscoveryFixtureV4() {
  const base = acceptanceFixturesV4().find(task => task.id === 'history-retirement-short')
  return { ...base, id: 'retirement-source-discovery-v4', discoverSourcePath: true,
    query: base.query + ' Read the version/checkpoint header using offset 1 and limit 1; do the same for any retirement snapshot. No extra acknowledgement is requested.' }
}

export function retirementDiscoveryPolicyV4() {
  return { ...retirementDiscoveryFixtureV4().historyRetirement, minimumFutureRequests: 200, excerptCharacters: 64 }
}

// PTC batching is a separate negative-control scope, never calibration evidence
// for the direct-call fixture's remaining-request forecast.
export function retirementDiscoveryPtcFixtureV4() {
  return { ...retirementDiscoveryFixtureV4(), id: 'retirement-source-discovery-ptc-v4', ptc: true }
}

export function retirementDiscoveryPtcPolicyV4() {
  return { ...retirementDiscoveryPolicyV4(), tools: ['fixture', 'run_code'] }
}
